'use strict';
/**
 * 公開の関数ごとに、シートを呼んだ回数（metrics.ops）と推定時間（estGasMs）を測る（docs/REVIEW-code.md）。
 *   node tools/measure-ops.js            … 表を出す
 *   node tools/measure-ops.js --json F   … 結果を F に JSON で書く
 *
 * 過去の予約が 100日分・365日分（毎日4コマ×2台）の台帳で、同じ操作の列を流し、
 * 「シートを呼ぶ回数が台帳の行数で増えないか」を見る（2つの列の回数が同じなら、行数に依らない）。
 */
const fs = require('fs');
const { createEnv, ACTORS } = require('../tests/helpers');
const { seed } = require('./measure-growth');

const auth = { email: ACTORS.admin.email, secret: ACTORS.admin.secret };
const R = ACTORS.residents[0];

/** 操作の列。ctx に前の結果（予約番号など）を残す */
const STEPS = [
  ['doGet（住民の画面）', 'doGet', () => [{ parameter: {} }], 'doGet'],
  ['api_admin_login', 'api_admin_login', () => [auth]],
  ['api_admin_register（電話）', 'api_admin_register', (c) => [auth, { requestId: `rq-ops-reg-${c.n}`, date: '2026-10-28', slotId: 'S1', quantity: 1, channel: 'PHONE', name: '測定 花子', room: '101', phone: '090-1111-2222' }], null, (c, v) => { c.rid = v.reservationId; }],
  ['api_getAvailability（1か月）', 'api_getAvailability', () => [{ from: '2026-11-01', to: '2026-11-30' }]],
  ['api_admin_availability（1週間）', 'api_admin_availability', () => [auth, { from: '2026-10-19', to: '2026-10-25' }]],
  ['api_admin_week（週の表を1回で）', 'api_admin_week', () => [auth, { from: '2026-10-19', to: '2026-10-25' }]],
  ['api_admin_list（1週間）', 'api_admin_list', () => [auth, { from: '2026-10-19', to: '2026-10-25' }]],
  ['api_admin_list（名前で探す）', 'api_admin_list', () => [auth, { text: '測定' }]],
  ['api_admin_callList', 'api_admin_callList', () => [auth]],
  ['api_admin_blockList', 'api_admin_blockList', () => [auth, {}]],
  ['api_admin_monthTable', 'api_admin_monthTable', () => [auth, { month: '2026-10' }]],
  ['api_getRequestStatus', 'api_getRequestStatus', (c) => [{ requestId: `rq-ops-reg-${c.n}` }]],
  ['api_lookupReservation', 'api_lookupReservation', (c) => [{ reservationId: c.rid, phoneTail: '2222' }]],
  ['api_admin_change（時間帯）', 'api_admin_change', (c) => [auth, { reservationId: c.rid, date: '2026-10-28', slotId: 'S2', name: '測定 花子', room: '101', phone: '090-1111-2222' }]],
  ['api_admin_markCalled', 'api_admin_markCalled', (c) => [auth, { reservationId: c.rid }]],
  ['api_admin_addBlock（確認）', 'api_admin_addBlock', (c) => [auth, { requestId: `rq-ops-blk-${c.n}`, from: '2026-10-29', to: '2026-10-29', slots: ['S1'], spaces: ['93'], reason: '工事・点検' }]],
  ['api_admin_addBlock（登録）', 'api_admin_addBlock', (c) => [auth, { requestId: `rq-ops-blk-${c.n}`, from: '2026-10-29', to: '2026-10-29', slots: ['S1'], spaces: ['93'], reason: '工事・点検', confirm: true }], null, (c, v) => { c.bid = v.blockId; }],
  ['api_admin_releaseBlock', 'api_admin_releaseBlock', (c) => [auth, { blockId: c.bid }]],
  ['api_admin_exportMonth', 'api_admin_exportMonth', () => [auth, { month: '2026-10' }]],
  ['api_admin_cancel', 'api_admin_cancel', (c) => [auth, { reservationId: c.rid, reason: '本人から電話' }]],
  ['api_submitReservation（住民）', 'api_submitReservation', (c) => [{ requestId: `rq-ops-sub-${c.n}`, date: '2026-10-27', slotId: 'S3', quantity: 1, name: R.name, building: R.building, room: R.room, phone: R.phone, email: R.email }]],
  ['job_processNotifications', 'job_processNotifications', () => [], 'trigger'],
  ['job_archiveLedger', 'job_archiveLedger', () => [], 'trigger'],
];

async function runAll(days) {
  const env = await createEnv({ rules: { residentLookup: true } });
  const rows = seed(env, days);
  const c = { n: days };
  const out = [];
  for (const [label, fn, args, kind, after] of STEPS) {
    const r = await env.host.run(fn, args(c), { kind: kind || 'client', user: kind ? (kind === 'doGet' ? null : undefined) : ACTORS.admin.email });
    if (!r.ok) throw new Error(`${label}: ${JSON.stringify(r.error)}`);
    if (after) after(c, r.value);
    const ops = r.metrics.ops || {};
    const sheetOps = Object.entries(ops).filter(([k]) => k.startsWith('sh.') || k.startsWith('ss.')).reduce((a, [, v]) => a + v, 0);
    out.push({ label, fn, status: r.value && r.value.status, sheetOps, ops, estGasMs: r.metrics.estGasMs, wallMs: r.metrics.wallMs });
  }
  await env.host.close();
  return { days, rows, items: out };
}

(async () => {
  const a = await runAll(100);
  const b = await runAll(365);
  console.log(`公開の関数ごとのシートの呼び出し回数（100日分=${a.rows}行 と 365日分=${b.rows}行）`);
  console.log(['関数', '結果', 'シート呼出し(100)', 'シート呼出し(365)', '推定ms(100)', '推定ms(365)', '実時間ms(365)'].join(' | '));
  let grow = 0;
  a.items.forEach((x, i) => {
    const y = b.items[i];
    const mark = x.sheetOps !== y.sheetOps ? ' ←増えた' : '';
    if (mark) grow++;
    console.log([x.label, x.status, x.sheetOps, y.sheetOps + mark, x.estGasMs, y.estGasMs, y.wallMs].join(' | '));
  });
  const sum = (r) => r.items.reduce((s, x) => s + x.estGasMs, 0);
  console.log(`\n推定の合計：100日分 ${sum(a)}ms、365日分 ${sum(b)}ms。行数で回数が増えた関数：${grow}`);
  const j = process.argv.indexOf('--json');
  if (j > 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify({ a, b }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
