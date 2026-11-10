'use strict';
// 台帳の不変条件。実装のコードを通さず、シートを直接読んで検査する（実装が自分の誤りを隠せないように）。
// 要件8「重複確定・受付済み申込みの所在不明・無断の結果変更は0件」を機械的に確かめる中心部分。
const { formatYmd } = require('./emulator/tz');

function readTable(host, ssId, spec) {
  const d = host.dumpSheet(ssId, spec.sheet);
  if (!d) return { missing: true, rows: [] };
  const inv = {};
  for (const [k, col] of Object.entries(spec.columns)) inv[k] = col;
  const rows = d.rows.map((r) => {
    const o = { __row: r.__row };
    for (const [k, col] of Object.entries(inv)) o[k] = r[col];
    return o;
  });
  const missingCols = Object.entries(spec.columns).filter(([, col]) => !d.header.includes(col)).map(([k, col]) => `${k}(${col})`);
  return { rows, header: d.header, missingCols };
}

function normDate(v, tz) {
  if (v instanceof Date) return { ok: true, v: formatYmd(v.getTime(), tz) };
  const s = String(v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { ok: true, v: s };
  return { ok: false, v: s };
}

/**
 * @returns {{ ok: boolean, violations: {code:string, message:string}[], stats: object }}
 */
function checkLedger(host, ssId, contract, { requireAllSheets = true } = {}) {
  const tz = contract.timeZone;
  const L = contract.ledger;
  const V = [];
  const add = (code, message) => V.push({ code, message });
  const res = readTable(host, ssId, L.reservations);
  const alc = readTable(host, ssId, L.allocations);
  if (res.missing) add('SHEET_MISSING', `予約台帳シート "${L.reservations.sheet}" が無い`);
  if (alc.missing) add('SHEET_MISSING', `割当てシート "${L.allocations.sheet}" が無い`);
  if (res.missing || alc.missing) return { ok: !requireAllSheets, violations: requireAllSheets ? V : [], stats: {} };
  for (const t of [['予約台帳', res], ['割当て', alc]]) {
    if (t[1].missingCols.length) add('COLUMN_MISSING', `${t[0]}に列が無い: ${t[1].missingCols.join(', ')}（contract.json の columns を確認）`);
  }
  const active = new Set(L.allocations.activeStates);
  const confirmed = new Set(L.reservations.states.confirmed);
  const cancelled = new Set(L.reservations.states.cancelled || []);
  const spaces = new Set(contract.spaces.map(String));
  const slots = new Set(Object.keys(contract.slots));

  // 予約
  const byId = new Map();
  const byReq = new Map();
  for (const r of res.rows) {
    const id = String(r.reservation_id ?? '');
    if (!id) { add('RES_NO_ID', `予約台帳 ${r.__row}行目: 予約IDが空`); continue; }
    if (byId.has(id)) add('RES_DUP_ID', `予約ID ${id} が複数行にある（${byId.get(id).__row}行目と${r.__row}行目）`);
    byId.set(id, r);
    const rq = String(r.request_id ?? '');
    if (rq) {
      if (byReq.has(rq)) add('REQ_DUP', `受付要求ID ${rq} で予約が二重登録されている（${byReq.get(rq).__row}行目と${r.__row}行目）`);
      byReq.set(rq, r);
    }
    const nd = normDate(r.date, tz);
    if (!nd.ok) add('RES_BAD_DATE', `予約 ${id}: 利用日 "${nd.v}" が年を含む日付として解釈できない`);
    if (r.slot_id !== undefined && !slots.has(String(r.slot_id))) add('RES_BAD_SLOT', `予約 ${id}: コマID "${r.slot_id}" が不正`);
    for (const k of Object.keys(r)) {
      if (typeof r[k] === 'string' && /^#(REF|VALUE|N\/A|NAME|DIV\/0|NUM|ERROR)/.test(r[k])) add('CELL_ERROR', `予約 ${id}: ${k} がエラー値 ${r[k]}`);
    }
  }

  // 割当て
  const seen = new Map();
  const activeByRes = new Map();
  for (const a of alc.rows) {
    const st = String(a.state ?? '');
    const nd = normDate(a.date, tz);
    if (!nd.ok) add('ALC_BAD_DATE', `割当て ${a.__row}行目: 日付 "${nd.v}" が年を含む日付として解釈できない`);
    const sp = String(a.space_id ?? '');
    if (!spaces.has(sp)) add('ALC_BAD_SPACE', `割当て ${a.__row}行目: 駐車場 "${sp}" は存在しない`);
    if (!slots.has(String(a.slot_id))) add('ALC_BAD_SLOT', `割当て ${a.__row}行目: コマ "${a.slot_id}" は存在しない`);
    if (!active.has(st)) continue;
    const key = `${nd.v}|${a.slot_id}|${sp}`;
    if (seen.has(key)) add('DOUBLE_BOOKING', `二重予約: ${nd.v} ${a.slot_id} 駐車場${sp} が ${seen.get(key)} と ${a.reservation_id} の両方に確保されている`);
    else seen.set(key, a.reservation_id);
    const rid = String(a.reservation_id ?? '');
    activeByRes.set(rid, (activeByRes.get(rid) || 0) + 1);
    const r = byId.get(rid);
    if (!r) add('ORPHAN_ALLOCATION', `割当て ${a.__row}行目: 予約 ${rid} が台帳に無い`);
    else {
      if (!confirmed.has(String(r.state))) add('ALLOC_FOR_UNCONFIRMED', `予約 ${rid}（状態 ${r.state}）に有効な割当てが残っている`);
      const rd = normDate(r.date, tz);
      if (rd.ok && nd.ok && rd.v !== nd.v) add('ALLOC_DATE_MISMATCH', `予約 ${rid} の利用日 ${rd.v} と割当ての日付 ${nd.v} が違う`);
      if (String(r.slot_id) !== String(a.slot_id)) add('ALLOC_SLOT_MISMATCH', `予約 ${rid} のコマ ${r.slot_id} と割当てのコマ ${a.slot_id} が違う`);
    }
  }

  for (const [id, r] of byId) {
    const n = activeByRes.get(id) || 0;
    if (confirmed.has(String(r.state))) {
      const q = Number(r.quantity);
      if (!Number.isFinite(q) || q < 1) add('RES_BAD_QTY', `予約 ${id}: 台数 "${r.quantity}" が不正`);
      else if (n !== q) add('PARTIAL_ALLOCATION', `確定予約 ${id}: 台数 ${q} に対し有効な割当てが ${n} 件`);
    }
    if (cancelled.has(String(r.state)) && n > 0) add('CANCELLED_STILL_HOLDS', `取消済み予約 ${id} が枠を ${n} 件保持している`);
  }

  return {
    ok: V.length === 0,
    violations: V,
    stats: {
      reservations: res.rows.length,
      confirmed: [...byId.values()].filter((r) => confirmed.has(String(r.state))).length,
      activeAllocations: [...activeByRes.values()].reduce((a, b) => a + b, 0),
    },
  };
}

function readNamed(host, ssId, spec) { return readTable(host, ssId, spec); }

module.exports = { checkLedger, readNamed, normDate };
