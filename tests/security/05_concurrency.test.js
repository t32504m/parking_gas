'use strict';
// 侵入試験 面E：同時実行と再送（docs/PENTEST.md 2.5）。台帳の不変条件は withEnv が最後に必ず確かめる
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, R, v, adminAuth } = require('./sec-helpers');

const OPEN = { residentBooking: true, residentLookup: true };
const client = (fn, args, user = null) => ({ fn, args, kind: 'client', user });

test('[PT-E1] 同じ枠に、上限より多い申込みを同時に送っても、上限を超えて確定しない', async (t) => H.withEnv(t, { rules: { ...OPEN, capacityPerSlot: 2 } }, async (env) => {
  const calls = R.slice(0, 10).map((p) => client('api_submitReservation', [env.req(p, { slotId: 'S4' })]));
  calls.push(client('api_admin_register', [adminAuth(), env.req(R[10], { slotId: 'S4', channel: 'PHONE' })]));
  const rs = await env.host.runConcurrently(calls);
  const ok = rs.filter((r) => r.ok && r.value.status === 'CONFIRMED').length;
  assert.ok(ok <= 2, `1コマ2台なのに、同時の申込みで ${ok} 件が確定した`);
  const act = env.table('allocations').rows.filter((a) => a.state === '有効' && a.slot_id === 'S4');
  assert.ok(act.length <= 2, `有効な割当てが ${act.length} 件`);
}));

test('[PT-E2] 同じ受付要求ID を、別の内容で同時に送っても、予約は1件だけ', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const rid = 'rq-same-request-0001';
  const calls = R.slice(0, 8).map((p, i) => client('api_submitReservation', [{ ...env.req(p, { slotId: ['S1', 'S2', 'S3', 'S4'][i % 4] }), requestId: rid }]));
  await env.host.runConcurrently(calls);
  const rows = env.table('reservations').rows.filter((x) => x.request_id === rid);
  assert.equal(rows.length, 1, `同じ受付要求ID の予約が ${rows.length} 行`);
}));

test('[PT-E3] 通知を送っている最中に取り消した予約へ、「確定しました」のメールが後から届かない', async (t) => H.withEnv(t, { rules: OPEN, latency: { min: 1, max: 6 } }, async (env) => {
  const sentAfterCancel = [];
  for (let round = 0; round < 6; round++) {
    const p = R[round];
    const b = await v(env, 'api_submitReservation', [env.req(p, { slotId: ['S1', 'S2', 'S3', 'S4'][round % 4], date: `2026-10-${26 + Math.floor(round / 4)}`, email: p.email })]);
    assert.equal(b.status, 'CONFIRMED');
    const [job, cancel] = await env.host.runConcurrently([
      { fn: 'job_processNotifications', args: [], kind: 'trigger' },
      client('api_admin_cancel', [adminAuth(), { reservationId: b.reservationId, reason: '本人から電話（取消し）' }]),
    ]);
    assert.ok(job.ok && cancel.ok);
    if (cancel.value.status !== 'CANCELLED') continue;
    const cancelExec = env.host.executions.find((x) => x.execId === cancel.execId);
    // 取消しがロックを取った時刻（ここから台帳の状態を「取消済み」にする）。これより後の確定のメールは、取り消した予約へのメール
    const cancelLocked = cancelExec.startedAt + (cancel.metrics.lockWaitMs || 0);
    const late = env.host.outbox.filter((m) => m.to === p.email && m.at > cancelLocked);
    if (late.length) sentAfterCancel.push(`${b.reservationId}（取消しがロックを取った ${Math.round(late[0].at - cancelLocked)}ms 後に送信。通知の状態 ${env.host.dumpSheet(env.spreadsheetId, '通知').rows.find((x) => String(x['予約番号']) === b.reservationId)['状態']}）`);
  }
  assert.deepEqual(sentAfterCancel, [], '取消しを始めた後に、確定のメールが送られた（取消しのメールは無い）');
}));

test('[PT-E4] 夜中の保管と、申込み・登録・取消しが重なっても、予約が消えず、二重にならない', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  // 10/20〜10/22 に予約を入れ、2026-12-25 まで時間を進める（60日より前になる）
  const old = [];
  for (const [i, date] of ['2026-10-20', '2026-10-21', '2026-10-22'].entries()) {
    old.push(await v(env, 'api_admin_register', [adminAuth(), env.req(R[i], { date, slotId: 'S4', channel: 'PHONE', email: undefined })]));
  }
  for (const o of old) await v(env, 'api_admin_markCalled', [adminAuth(), { reservationId: o.reservationId }]);
  env.host.setClock('2026-12-25T03:00:00+09:00');
  const recent = await v(env, 'api_admin_register', [adminAuth(), env.req(R[5], { date: '2026-12-26', slotId: 'S1', channel: 'PHONE' })]);
  const calls = [
    { fn: 'job_archiveLedger', args: [], kind: 'trigger' },
    client('api_submitReservation', [env.req(R[6], { date: '2027-01-05', slotId: 'S2' })]),
    client('api_admin_register', [adminAuth(), env.req(R[7], { date: '2027-01-05', slotId: 'S2', channel: 'PHONE' })]),
    client('api_admin_cancel', [adminAuth(), { reservationId: recent.reservationId, reason: '取消し' }]),
    client('api_admin_cancel', [adminAuth(), { reservationId: old[0].reservationId, reason: '保管と同時の取消し' }]),
    { fn: 'job_archiveLedger', args: [], kind: 'trigger' },
  ];
  await env.host.runConcurrently(calls);
  const arc = env.host.dumpSheet(env.spreadsheetId, '予約（保管）').rows;
  assert.ok(arc.length >= 1, '保管が動いていない（試験の前提が崩れている）');
  const all = env.host.dumpSheet(env.spreadsheetId, '予約').rows.concat(arc);
  for (const o of old) {
    const n = all.filter((x) => String(x['予約番号']) === o.reservationId).length;
    assert.equal(n, 1, `予約 ${o.reservationId} が元のシートと保管のシートで ${n} 行`);
  }
}));
