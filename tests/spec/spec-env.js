'use strict';
// 仕様から書いた試験（tests/spec/）の共通部品。
// 受入試験の前提（adapter の HARNESS_PREMISE：1コマ3台・住民の受付を開く）は使わず、
// 本番の既定（docs/SETUP.md 付録の RULES の既定）で動かす。必要な試験だけ rules で項目を変える。
const path = require('path');
const crypto = require('crypto');
const { GasHost } = require('../../harness/emulator/host');
const { checkLedger } = require('../../harness/invariants');
const { formatYmd } = require('../../harness/emulator/tz');

const ROOT = path.join(__dirname, '..', '..');
const CONTRACT = require('../../contract/contract.json');
const NOW = '2026-11-09T09:00:00+09:00'; // 月曜
const TODAY = '2026-11-09';
const SPACES = ['91', '92', '93'];
const RES_CAP = 2; // 住民の上限（本番の既定の capacityPerSlot）
const ADMIN_CAP = SPACES.length; // 管理者の上限（D-040）

const ADMIN = { email: 'kanri1@example.org', name: '管理 一郎', secret: 'spec-pass-1111' };
const ADMIN2 = { email: 'kanri2@example.org', name: '管理 二葉', secret: 'spec-pass-2222' };
const SUR = ['青柳', '笹島', '桐生', '早乙女', '鬼頭', '東雲', '雨宮', '御手洗', '久遠', '霧島', '朝比奈', '鳳'];
const GIV = ['澄子', '巌', '千鶴', '甚八', '小百合', '鉄之助', '綾乃', '権三', '紫苑', '与一', '菫', '玄'];
function person(i) {
  return {
    name: `${SUR[i % 12]} ${GIV[(i * 5) % 12]}`, building: ['A棟', 'B棟', 'C棟'][i % 3],
    room: String(201 + i * 3), phone: `090-${String(5100 + i)}-${String(8300 + i)}`,
  };
}
const PEOPLE = Array.from({ length: 30 }, (_, i) => person(i));

/** 'YYYY-MM-DD' に日数を足す */
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}
function rid() { return `spec-${crypto.randomUUID()}`; }
function ymdOf(v) { return v instanceof Date ? formatYmd(v.getTime(), 'Asia/Tokyo') : String(v ?? ''); }

let seq = 0;
async function createSpecEnv(opts = {}) {
  const host = new GasHost({ projectDir: path.join(ROOT, 'src'), now: opts.now || NOW, latency: opts.latency || { min: 0, max: 0 }, seed: opts.seed || 11 });
  const ssId = `SS_SPEC_${++seq}`;
  host.createSpreadsheet({ id: ssId, name: '駐車場予約（仕様の試験）' });
  host.setScriptProperties({ SPREADSHEET_ID: ssId, CONTACT_NOTE: '自治会の駐車場係（電話 03-0000-0000）' });
  const s = await host.run('setup_init', [opts.rules || {}, [ADMIN, ADMIN2]], { kind: 'editor' });
  if (!s.ok || !s.value || s.value.status !== 'OK') throw new Error(`setup_init に失敗: ${JSON.stringify(s.error || s.value)}`);
  // D-040：住民（空き状況・申込み）は capacityPerSlot（既定 2）まで。管理者（代行登録・変更・空き状況）は全ての区画（3台）まで
  const capacity = (opts.rules && opts.rules.capacityPerSlot) || 2;
  const adminCapacity = SPACES.length;

  const val = (r) => (r.ok ? (r.value === undefined ? { status: 'UNDEFINED' } : r.value) : { status: r.denied ? 'DENIED' : 'ERROR', error: r.error });
  const auth = (who) => ({ email: who && who.email, secret: who && who.secret });
  const env = {
    host, ssId, capacity, adminCapacity, TODAY,
    val, auth,
    /** google.script.run と同じ経路で呼ぶ（引数はそのまま） */
    async raw(fn, args, user = null) { return host.run(fn, args, { kind: 'client', user }); },
    async pub(fn, q) { return val(await host.run(fn, q === undefined ? [] : [q], { kind: 'client', user: null })); },
    async admin(fn, q, who = ADMIN) {
      const args = q === undefined ? [auth(who)] : [auth(who), q];
      return val(await host.run(fn, args, { kind: 'client', user: null }));
    },
    regReq(o = {}) {
      const p = o.person || PEOPLE[Math.floor(Math.random() * PEOPLE.length)];
      const r = { requestId: rid(), date: TODAY, slotId: 'S1', quantity: 1, channel: 'PHONE', name: p.name, building: p.building, room: p.room, phone: p.phone, email: '', ...o };
      delete r.person;
      return r;
    },
    async register(o = {}, who = ADMIN) { return env.admin('api_admin_register', env.regReq(o), who); },
    async avail(from, to) { return env.pub('api_getAvailability', { from, to }); },
    async adminAvail(from, to) { return env.admin('api_admin_availability', { from, to }); },
    sheet(name) { const d = host.dumpSheet(ssId, name); return d ? d.rows : null; },
    sheetRaw(name) { return host.dumpSheet(ssId, name); },
    sheetNames() { return host.store.book(ssId).sheets.map((x) => x.name); },
    /** シートの全セルの値（2次元） */
    grid(name) {
      const b = host.store.book(ssId); const sh = b.sheets.find((x) => x.name === name);
      if (!sh) return null;
      const { lastRow, lastCol } = host.store.dims(ssId, sh.sheetId);
      if (!lastRow) return [];
      return host.store.getValues(ssId, sh.sheetId, 1, 1, lastRow, Math.max(lastCol, 1));
    },
    formulas(name) {
      const b = host.store.book(ssId); const sh = b.sheets.find((x) => x.name === name);
      const { lastRow, lastCol } = host.store.dims(ssId, sh.sheetId);
      if (!lastRow) return [];
      return host.store.getValues(ssId, sh.sheetId, 1, 1, lastRow, Math.max(lastCol, 1), 'formulas');
    },
    reservations() { return env.sheet('予約') || []; },
    allocations() { return env.sheet('割当て') || []; },
    audit() { return env.sheet('操作履歴') || []; },
    activeAllocs(date, slotId) {
      return env.allocations().filter((a) => a['状態'] === '有効' && (!date || ymdOf(a['利用日']) === date) && (!slotId || a['コマID'] === slotId));
    },
    resById(id) { return env.reservations().find((r) => String(r['予約番号']) === String(id)); },
    async runTrigger(fn) { return host.run(fn, [{ triggerUid: 'spec', authMode: 'FULL' }], { kind: 'trigger' }); },
    /** 追加の不変条件：1コマの有効な割当てが、全ての区画の数（管理者の上限、D-040）以下。住民の上限（2台）は各試験で確かめる */
    extraCheck() {
      const v = [];
      const cnt = new Map();
      for (const a of env.allocations()) {
        if (a['状態'] !== '有効') continue;
        const k = `${ymdOf(a['利用日'])}|${a['コマID']}`;
        cnt.set(k, (cnt.get(k) || 0) + 1);
      }
      for (const [k, n] of cnt) if (n > adminCapacity) v.push(`[OVER_CAPACITY] ${k} に有効な割当てが ${n} 件（上限 ${adminCapacity}）`);
      return v;
    },
  };
  return env;
}

function slug(s) { return s.replace(/[^\w぀-ヿ一-龯-]+/g, '_').slice(0, 80); }

/** 環境を作って fn を走らせ、最後に台帳の不変条件を確かめる */
async function withSpec(t, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const env = await createSpecEnv(opts);
  let err = null;
  try { await fn(env); } catch (e) { err = e; }
  const inv = checkLedger(env.host, env.ssId, CONTRACT);
  const extra = env.extraCheck();
  if (err || !inv.ok || extra.length) env.host.exportCsv(path.join(ROOT, 'reports', 'spec-sheets', slug(t.name)));
  await env.host.close();
  if (err) throw err;
  if (!inv.ok || extra.length) {
    throw new Error(`台帳の不変条件違反:\n${inv.violations.map((x) => `  [${x.code}] ${x.message}`).concat(extra.map((x) => `  ${x}`)).join('\n')}`);
  }
}

/** 応答の中に Date が無いか（google.script.run は Date を返せない） */
function hasDate(v) {
  if (v instanceof Date) return true;
  if (v && typeof v === 'object') return Object.values(v).some(hasDate);
  return false;
}
/**
 * 住民向けの空き状況の1コマが「空きがある」か（Q-3 の決定：住民には台数の数を返さず、空きの有無だけを返す）。
 * 依頼者の決定（2026-11-09 夜）で、欄は available（真偽）。open / vacant / hasVacancy は、決まる前に想定した名前の残り。
 * 数（remaining）しか無い間は、それで判断する（数を返すこと自体は S-072 が問う）。
 */
function slotOpen(s) {
  if (!s || s.closed) return false;
  for (const k of ['available', 'open', 'vacant', 'hasVacancy']) if (typeof s[k] === 'boolean') return s[k];
  if (typeof s.remaining === 'number') return s.remaining > 0;
  throw new Error(`住民の空き状況に、空きの有無を示す欄が無い: ${JSON.stringify(s)}`);
}
function pii(list) { return list.flatMap((p) => [p.name, p.name.split(' ')[0], p.phone, p.phone.replace(/-/g, ''), `${p.building}${p.room}`]); }
function leaks(obj, needles) { const s = JSON.stringify(obj ?? null); return needles.filter((n) => n && s.includes(n)); }

module.exports = { RES_CAP, ADMIN_CAP, createSpecEnv, withSpec, addDays, rid, ymdOf, hasDate, pii, leaks, slotOpen, ADMIN, ADMIN2, PEOPLE, NOW, TODAY, CONTRACT };
