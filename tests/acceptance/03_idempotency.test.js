'use strict';
// 再送・通信断（要件6.5・U-07・U-08・8「所在不明0」）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS } = require('../helpers');

const R = ACTORS.residents;

test('[6.5][11障害] 同じ受付要求IDを再送しても二重登録されず、同じ予約番号が返る', async (t) => withEnv(t, async (env) => {
  const req = env.req(R[0], { slotId: 'S1' });
  const a = await env.adapter.submit(env.host, req, R[0]);
  const b = await env.adapter.submit(env.host, req, R[0]);
  assert.equal(a.status, 'CONFIRMED');
  assert.equal(b.status, 'CONFIRMED', `再送の結果が ${b.status}（確定済みの結果を返すこと）`);
  assert.equal(String(b.reservationId), String(a.reservationId), '再送で別の予約番号になった');
  const rows = env.table('reservations').rows.filter((x) => String(x.request_id) === req.requestId);
  assert.equal(rows.length, 1);
}));

test('[6.5][11障害] ボタン連打（同じ受付要求IDの同時送信）でも予約は1件', async (t) => {
  for (let round = 1; round <= 3; round++) {
    await withEnv(t, { latency: { min: 2, max: 20 }, seed: 300 + round }, async (env) => {
      const req = env.req(R[1], { slotId: 'S2' });
      const rs = await Promise.all([0, 1, 2].map(() => env.adapter.submit(env.host, req, R[1])));
      const ids = new Set(rs.filter((r) => r.status === 'CONFIRMED').map((r) => String(r.reservationId)));
      assert.ok(ids.size <= 1, `第${round}回: 予約番号が ${ids.size} 種類`);
      const rows = env.table('reservations').rows.filter((x) => String(x.request_id) === req.requestId);
      assert.equal(rows.length, 1, `第${round}回: 台帳の行数 ${rows.length}`);
    });
  }
});

test('[6.5][U-08][11障害] 応答が届かなかった（通信断）後、受付要求IDで結果を確認できる', async (t) => withEnv(t, async (env) => {
  const req = env.req(R[2], { slotId: 'S3' });
  await env.adapter.submit(env.host, req, R[2]); // 応答は利用者に届かなかったとみなし、結果を捨てる
  const s = await env.adapter.getRequestStatus(env.host, { requestId: req.requestId }, R[2]);
  assert.equal(s.status, 'CONFIRMED', `再確認の結果 ${s.status}`);
  assert.ok(s.reservationId, '再確認で予約番号が分からない');
  const unknown = await env.adapter.getRequestStatus(env.host, { requestId: 'rq-never-sent' }, R[2]);
  assert.equal(unknown.status, 'UNKNOWN', '送っていない要求が「ある」ことになっている');
}));

test('[6.5][U-07] 満車で不成立になった要求も、後から「不成立」と確認できる（所在不明にしない）', async (t) => withEnv(t, async (env) => {
  for (const i of [3, 4, 5]) await env.adapter.submit(env.host, env.req(R[i], { slotId: 'S4' }), R[i]);
  const req = env.req(R[6], { slotId: 'S4' });
  const r = await env.adapter.submit(env.host, req, R[6]);
  assert.equal(r.status, 'REJECTED');
  const s = await env.adapter.getRequestStatus(env.host, { requestId: req.requestId }, R[6]);
  assert.equal(s.status, 'REJECTED', `不成立の要求を再確認すると ${s.status}`);
}));
