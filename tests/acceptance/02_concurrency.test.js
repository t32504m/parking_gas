'use strict';
// 競合（要件6.5・11「競合・境界・障害」）。
// 各実行は別スレッドで本当に並行して動き、シート操作の合間に遅延を入れて「隙間」を広げている。
// 競合は確率的に起きるため、複数回繰り返す。1回でも違反すれば失敗。
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS, DAY, recordMetric } = require('../helpers');

const R = ACTORS.residents;
const ROUNDS = Number(process.env.HARNESS_RACE_ROUNDS || 4);
const RACE = { latency: { min: 2, max: 20 } };
const slot = (av, id) => av.days.find((d) => d.date === DAY).slots.find((s) => s.slotId === id);

// 住民には残り台数を見せない（U-03、2026-11-09 依頼者の決定）。数は台帳で数える
const CAP = 3; // 受入試験の前提（HARNESS_PREMISE）の1コマの台数
const ymdT = (v) => (v instanceof Date ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(v) : String(v).slice(0, 10));
/** 台帳の有効な割当ての数 */
const used = (env, date, slotId) => env.table('allocations').rows.filter((a) =>
  env.contract.ledger.allocations.activeStates.includes(String(a.state)) && ymdT(a.date) === date && String(a.slot_id) === slotId).length;
/** 住民の応答の1コマ：available が期待どおりで、数を持たない */
function residentSlot(s, expectAvailable, label) {
  assert.ok(s, `${label}: コマが無い`);
  assert.equal(s.available, expectAvailable, `${label}: available が ${s.available}`);
  assert.ok(!('remaining' in s) && !('capacity' in s), `${label}: 住民の応答に台数の数がある`);
}

async function fillTo(env, slotId, n) {
  for (let i = 0; i < n; i++) {
    const r = await env.adapter.submit(env.host, env.req(R[11 - i], { slotId }), R[11 - i]);
    assert.equal(r.status, 'CONFIRMED', `準備の予約に失敗: ${JSON.stringify(r.raw)}`);
  }
}

test('[6.5][11競合] 残り1台へ5人が同時に申し込むと、確定は1件だけ', async (t) => {
  for (let round = 1; round <= ROUNDS; round++) {
    await withEnv(t, { ...RACE, seed: round }, async (env) => {
      await fillTo(env, 'S1', 2);
      const people = R.slice(0, 5);
      const results = await Promise.all(people.map((p) => env.adapter.submit(env.host, env.req(p, { slotId: 'S1' }), p)));
      const st = results.map((r) => r.status);
      assert.equal(st.filter((s) => s === 'CONFIRMED').length, 1, `第${round}回: 確定件数 ${st.join(',')}`);
      assert.ok(st.every((s) => ['CONFIRMED', 'REJECTED', 'ERROR', 'PENDING'].includes(s)), `想定外の状態 ${st}`);
      for (const r of results) {
        if (r.status !== 'CONFIRMED') assert.ok(!r.reservationId || r.status !== 'CONFIRMED', '不成立なのに確定扱いの予約番号');
      }
      const lw = env.host.executions.map((e) => e.metrics.lockWaitMs);
      recordMetric('race.lastSlot.lockWaitMaxMs', Math.max(...lw), 'ms', { round });
    });
  }
});

test('[6.5][A-04][11競合] 利用者の申込みと管理者の代行登録が同時に起きても重複しない', async (t) => {
  for (let round = 1; round <= ROUNDS; round++) {
    await withEnv(t, { ...RACE, seed: 100 + round }, async (env) => {
      await fillTo(env, 'S2', 2);
      const [a, b] = await Promise.all([
        env.adapter.submit(env.host, env.req(R[0], { slotId: 'S2' }), R[0]),
        env.adapter.adminRegister(env.host, env.req(R[1], { slotId: 'S2', channel: 'PHONE', email: undefined }), ACTORS.admin),
      ]);
      const n = [a, b].filter((r) => r.status === 'CONFIRMED').length;
      assert.equal(n, 1, `第${round}回: 利用者=${a.status} 管理者=${b.status}`);
    });
  }
});

test('[6.5][11競合] 古い空き画面（残りありと表示）から申し込んでも、満車なら確定しない', async (t) => withEnv(t, async (env) => {
  await fillTo(env, 'S3', 2);
  const before = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  assert.equal(used(env, DAY, 'S3'), CAP - 1, '準備の後の割当て');
  residentSlot(slot(before, 'S3'), true, 'S3（残り1台）');
  const other = await env.adapter.submit(env.host, env.req(R[0], { slotId: 'S3' }), R[0]);
  assert.equal(other.status, 'CONFIRMED');
  const after = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  residentSlot(slot(after, 'S3'), false, 'S3（他の人が確定した後）');
  // R[1] は「残り1」と表示された古い画面のまま申し込む
  const stale = await env.adapter.submit(env.host, env.req(R[1], { slotId: 'S3' }), R[1]);
  assert.equal(stale.status, 'REJECTED', `古い画面からの申込みが ${stale.status} になった`);
}));

test('[6.5][11競合] 取消しと新規予約が重なっても、枠の数が合っている', async (t) => {
  for (let round = 1; round <= ROUNDS; round++) {
    await withEnv(t, { ...RACE, seed: 200 + round }, async (env) => {
      const ids = [];
      for (const i of [0, 1, 2]) ids.push((await env.adapter.submit(env.host, env.req(R[i], { slotId: 'S4' }), R[i])).reservationId);
      const [c, n1, n2] = await Promise.all([
        env.adapter.adminCancel(env.host, { reservationId: ids[0], reason: '試験', requestId: `cx-${round}` }, ACTORS.admin),
        env.adapter.submit(env.host, env.req(R[3], { slotId: 'S4' }), R[3]),
        env.adapter.submit(env.host, env.req(R[4], { slotId: 'S4' }), R[4]),
      ]);
      assert.equal(c.status, 'CANCELLED');
      const confirmedNew = [n1, n2].filter((r) => r.status === 'CONFIRMED').length;
      assert.ok(confirmedNew <= 1, `空いたのは1台なのに ${confirmedNew} 件確定`);
      const av = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
      assert.equal(used(env, DAY, 'S4'), CAP - 1 + confirmedNew, '台帳の割当ての数が合わない');
      residentSlot(slot(av, 'S4'), confirmedNew === 0, 'S4（取消しと新規の後）');
    });
  }
});

test('[6.5][11競合] 異なるコマへの同時申込みは互いに妨げない（ロックの範囲が過大でない）', async (t) => withEnv(t, RACE, async (env) => {
  const reqs = ['S1', 'S2', 'S3', 'S4'].map((s, i) => [env.req(R[i], { slotId: s }), R[i]]);
  const rs = await Promise.all(reqs.map(([q, a]) => env.adapter.submit(env.host, q, a)));
  assert.deepEqual(rs.map((r) => r.status), ['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'CONFIRMED'],
    'ロック待ちのタイムアウト等で、空いているのに不成立/エラーになった');
}));
