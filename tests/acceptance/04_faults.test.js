'use strict';
// 障害（要件6.5・8「安定性・復旧性」・11）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS, DAY } = require('../helpers');

const R = ACTORS.residents;
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

test('[6.5][11障害] ロックを取得できないとき、確定したと表示せず、枠も確保しない', async (t) => withEnv(t, async (env) => {
  env.host.setFaults({ lock: { mode: 'timeout' } });
  const req = env.req(R[0], { slotId: 'S1' });
  const r = await env.adapter.submit(env.host, req, R[0]);
  env.host.clearFaults();
  assert.notEqual(r.status, 'CONFIRMED', 'ロック失敗なのに確定と返した');
  assert.ok(['ERROR', 'PENDING'].includes(r.status), `ロック失敗時の状態 ${r.status}（ERROR か PENDING を期待）`);
  const active = env.table('allocations').rows.filter((a) => env.contract.ledger.allocations.activeStates.includes(String(a.state)));
  assert.equal(active.length, 0, 'ロック無しで枠が確保された');
  // 同じ要求を再送すれば成立できる（受付が失われていない）
  const again = await env.adapter.submit(env.host, req, R[0]);
  assert.equal(again.status, 'CONFIRMED', `再送の結果 ${again.status}`);
}));

test('[6.5][8復旧性] スプレッドシートへの書込みが途中で失敗しても、成功と表示せず、再送で正しく確定する', async (t) => {
  for (let k = 1; k <= 8; k++) {
    let reached = true;
    await withEnv(t, async (env) => {
      const req = env.req(R[1], { slotId: 'S2' });
      env.host.setFaults({ sheetWrite: { failAt: k } });
      const r = await env.adapter.submit(env.host, req, R[1]);
      const failedExec = env.host.executions.at(-1);
      env.host.clearFaults();
      reached = (failedExec && failedExec.metrics.ops && Object.entries(failedExec.metrics.ops).filter(([op]) => /sh\.(set|append|clear|fmt|insertRows|deleteRows)|ss\.insertSheet/.test(op)).reduce((a, [, n]) => a + n, 0) >= k);
      if (r.status === 'CONFIRMED') {
        const inv = env.check();
        assert.ok(inv.ok, `書込み${k}回目で失敗したのに CONFIRMED と返し、台帳が不整合: ${inv.violations.map((v) => v.message).join(' / ')}`);
      }
      const again = await env.adapter.submit(env.host, req, R[1]);
      assert.equal(again.status, 'CONFIRMED', `書込み${k}回目の失敗後、再送の結果が ${again.status}`);
      const av = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
      assert.equal(used(env, DAY, 'S2'), 1, `書込み${k}回目の失敗後、割当ての数がずれた`);
      residentSlot(slot(av, 'S2'), true, `書込み${k}回目の失敗後の S2`);
    });
    if (!reached) break; // 書込み回数がこれより少ない実装では、以降の k は意味がない
  }
});

test('[8復旧性][11障害] 処理が途中で強制終了しても、二重予約にならず、再送で回復する', async (t) => {
  for (let k = 1; k <= 8; k++) {
    let killed = false;
    await withEnv(t, async (env) => {
      const req = env.req(R[2], { slotId: 'S3', quantity: 2 });
      env.host.setFaults({ terminateAfterWrite: { at: k } });
      await env.adapter.submit(env.host, req, R[2]).catch(() => null);
      killed = env.host.executions.some((e) => e.error && e.error.name === 'Terminated');
      env.host.clearFaults();
      const mid = env.check();
      const dbl = mid.violations.filter((v) => v.code === 'DOUBLE_BOOKING');
      assert.deepEqual(dbl, [], '強制終了直後に二重予約');
      const s = await env.adapter.getRequestStatus(env.host, { requestId: req.requestId }, R[2]);
      assert.ok(['CONFIRMED', 'PENDING', 'UNKNOWN', 'ERROR', 'REJECTED'].includes(s.status), `再確認の状態 ${s.status}`);
      const again = await env.adapter.submit(env.host, req, R[2]);
      assert.equal(again.status, 'CONFIRMED', `書込み${k}回目で強制終了した後の再送が ${again.status}`);
      const other = await env.adapter.submit(env.host, env.req(R[3], { slotId: 'S3' }), R[3]);
      assert.equal(other.status, 'CONFIRMED', '強制終了の残骸が枠を占有し続けている');
    });
    if (!killed) break;
  }
});
