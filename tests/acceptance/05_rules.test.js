'use strict';
// 仮ルールに関する試験（contract/provisional-rules.json）。ルールが決まったら、この試験も合わせて直す。
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS, DAY, RULES } = require('../helpers');

const R = ACTORS.residents;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

test('[6.5][仮ルール multiCar=ALL_OR_NOTHING][11境界] 3台中2台しか空いていないとき、3台の申込みは一部確定しない', async (t) => withEnv(t, async (env) => {
  assert.equal(RULES.multiCar, 'ALL_OR_NOTHING', 'この試験は ALL_OR_NOTHING 用');
  await env.adapter.submit(env.host, env.req(R[0], { slotId: 'S2' }), R[0]);
  const r = await env.adapter.submit(env.host, env.req(R[1], { slotId: 'S2', quantity: 3 }), R[1]);
  assert.equal(r.status, 'REJECTED', `一部しか空いていないのに ${r.status}`);
  const two = await env.adapter.submit(env.host, env.req(R[2], { slotId: 'S2', quantity: 2 }), R[2]);
  assert.equal(two.status, 'CONFIRMED', '2台なら確定できる');
}));

test('[仮ルール cutoff=SLOT_START][11境界] コマ開始の直前は受け付け、直後は受け付けない', async (t) => {
  await withEnv(t, { now: `${DAY}T07:59:00+09:00` }, async (env) => {
    const r = await env.adapter.submit(env.host, env.req(R[3], { slotId: 'S1' }), R[3]);
    assert.equal(r.status, 'CONFIRMED', `開始1分前の申込みが ${r.status}`);
  });
  await withEnv(t, { now: `${DAY}T08:01:00+09:00` }, async (env) => {
    const r = await env.adapter.submit(env.host, env.req(R[3], { slotId: 'S1' }), R[3]);
    assert.equal(r.status, 'REJECTED', `開始1分後の申込みが ${r.status}`);
    const s2 = await env.adapter.submit(env.host, env.req(R[4], { slotId: 'S2' }), R[4]);
    assert.equal(s2.status, 'CONFIRMED', '同日の後のコマはまだ受け付ける');
  });
});

test(`[仮ルール bookingWindowDays=${RULES.bookingWindowDays}][11境界] 受付期間の内側は受け付け、外側は受け付けない`, async (t) => withEnv(t, async (env) => {
  const today = '2026-10-19';
  const inside = addDays(today, RULES.bookingWindowDays);
  const outside = addDays(today, RULES.bookingWindowDays + 1);
  const a = await env.adapter.submit(env.host, env.req(R[5], { date: inside, slotId: 'S3' }), R[5]);
  assert.equal(a.status, 'CONFIRMED', `${inside}（${RULES.bookingWindowDays}日後）が ${a.status}`);
  const b = await env.adapter.submit(env.host, env.req(R[6], { date: outside, slotId: 'S3' }), R[6]);
  assert.equal(b.status, 'REJECTED', `${outside} が ${b.status}`);
  const past = await env.adapter.submit(env.host, env.req(R[7], { date: '2026-10-18', slotId: 'S3' }), R[7]);
  assert.equal(past.status, 'REJECTED', `過去日が ${past.status}`);
}));

test('[7.2][6.4] 不正な入力はサーバー側で拒否される（画面の検証に頼らない）', async (t) => withEnv(t, async (env) => {
  const bad = [
    { slotId: 'S9' }, { slotId: '第1コマ' }, { quantity: 0 }, { quantity: 4 }, { quantity: '1; DROP' },
    { date: '10/26' }, { date: '2026-02-30' }, { date: '' }, { name: '' }, { room: '' },
  ];
  for (const b of bad) {
    const r = await env.adapter.submit(env.host, env.req(R[8], b), R[8]);
    assert.ok(['REJECTED', 'ERROR'].includes(r.status), `不正入力 ${JSON.stringify(b)} が ${r.status}`);
  }
  const active = env.table('allocations').rows.filter((a) => env.contract.ledger.allocations.activeStates.includes(String(a.state)));
  assert.equal(active.length, 0, '不正入力で枠が確保された');
}));

test('[6.4][7.2] 電話番号の先頭0や部屋番号が、シートの自動変換で壊れない', async (t) => withEnv(t, async (env) => {
  const who = { ...R[9], phone: '09012345678', room: '0102' };
  const r = await env.adapter.adminRegister(env.host, { ...env.req(who, { slotId: 'S4', channel: 'PHONE' }), email: undefined }, ACTORS.admin);
  assert.equal(r.status, 'CONFIRMED');
  const list = await env.adapter.adminList(env.host, { reservationId: r.reservationId }, ACTORS.admin);
  const s = JSON.stringify(list.raw);
  assert.ok(s.includes('09012345678'), '電話番号の先頭0が失われた（数値に変換された）');
  assert.ok(s.includes('0102'), '部屋番号 0102 が 102 に変わった');
}));
