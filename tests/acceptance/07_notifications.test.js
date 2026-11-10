'use strict';
// 通知（要件6.6・A-07・11「通知だけが失敗する」）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, optional, ACTORS, DAY, recordMetric } = require('../helpers');

const R = ACTORS.residents;
// 案内のメールは、受付のときではなく、利用日の前日に送る（2026-11-10 依頼者の決定）。
// 試験では、時計を利用日の前日の夜（23:00）へ進めてから、通知処理を動かす。
const prevDay = new Date(Date.parse(`${DAY}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
const toEveBefore = (env) => env.host.setClock(`${prevDay}T23:00:00+09:00`);

test('[6.6] 予約の確定と通知は分離され、確定の時点ではメールを送らず、利用日の前日の通知処理で送る', async (t) => withEnv(t, async (env) => {
  const r = await env.adapter.submit(env.host, env.req(R[0], { slotId: 'S1' }), R[0]);
  assert.equal(r.status, 'CONFIRMED');
  const sentDuringSubmit = env.host.mailAttempts.length;
  await env.adapter.processNotifications(env.host);
  const mine = env.host.outbox.filter((m) => String(m.to).includes(R[0].email));
  if (sentDuringSubmit > 0) t.diagnostic('注意: 申込み処理の中でメール送信が行われている（6.6 分離の方針と要確認）');
  assert.equal(sentDuringSubmit, 0, '申込み処理の中でメールを送っている（確定処理と通知処理を分離すること）');
  assert.equal(mine.length, 0, `利用日の前日より前に ${mine.length} 通送った`);
  toEveBefore(env);
  await env.adapter.processNotifications(env.host);
  assert.equal(env.host.outbox.filter((m) => String(m.to).includes(R[0].email)).length, 1, '前日の通知処理で案内が1通届かない');
  await env.adapter.processNotifications(env.host);
  assert.equal(env.host.outbox.filter((m) => String(m.to).includes(R[0].email)).length, 1, '通知処理を2回動かすと二重送信された');
}));

test('[6.6][11障害] 通知だけが失敗しても予約は確定のまま。再送対象として残り、後で送られる', async (t) => withEnv(t, async (env) => {
  const r = await env.adapter.submit(env.host, env.req(R[1], { slotId: 'S2' }), R[1]);
  assert.equal(r.status, 'CONFIRMED');
  toEveBefore(env);
  env.host.setFaults({ mail: { failAll: true, message: 'Service unavailable: Gmail' } });
  await env.adapter.processNotifications(env.host).catch(() => null);
  env.host.clearFaults();
  const resv = env.table('reservations').rows.find((x) => String(x.reservation_id) === String(r.reservationId));
  assert.ok(env.contract.ledger.reservations.states.confirmed.includes(String(resv.state)), `通知失敗で予約の状態が ${resv.state} に変わった`);
  const notes = env.table('notifications').rows.filter((n) => String(n.reservation_id) === String(r.reservationId));
  assert.ok(notes.length >= 1, '通知記録が無い（未通知・失敗を管理者が把握できない）');
  assert.ok(notes.some((n) => env.contract.ledger.notifications.states.failed.includes(String(n.state))), `通知失敗が記録されていない: ${notes.map((n) => n.state)}`);
  await env.adapter.processNotifications(env.host);
  assert.equal(env.host.outbox.filter((m) => String(m.to).includes(R[1].email)).length, 1, '回復後に通知が送られていない、または二重');
}));

test('[6.6][8費用・制限] メールの1日上限に達しても予約は失われず、未送信が把握できる', async (t) => withEnv(t, async (env) => {
  env.host.mailQuota = 2;
  const ids = [];
  for (const i of [2, 3, 4, 5]) ids.push((await env.adapter.submit(env.host, env.req(R[i], { slotId: i < 5 ? 'S3' : 'S4' }), R[i])).reservationId);
  toEveBefore(env);
  await env.adapter.processNotifications(env.host).catch(() => null);
  assert.equal(env.host.outbox.length, 2);
  const notes = env.table('notifications').rows;
  const unsent = notes.filter((n) => !env.contract.ledger.notifications.states.sent.includes(String(n.state)));
  assert.ok(unsent.length >= 2, `上限超過で送れなかった通知が記録されていない（未送信 ${unsent.length} 件）`);
}));

test('[A-07][6.6] 電話連絡の予約は、メールが無くても登録でき、連絡待ちとして管理者が把握できる', async (t) => withEnv(t, async (env) => {
  const r = await env.adapter.adminRegister(env.host, { ...env.req(R[6], { slotId: 'S4', channel: 'PHONE' }), email: undefined }, ACTORS.admin);
  assert.equal(r.status, 'CONFIRMED');
  await env.adapter.processNotifications(env.host);
  assert.equal(env.host.mailAttempts.length, 0, 'メールの無い電話予約にメール送信を試みた');
  const list = await optional(t, env.adapter.adminCallList(env.host, ACTORS.admin));
  if (!list) return;
  assert.ok(JSON.stringify(list.raw).includes(String(r.reservationId)), '電話連絡待ちの一覧に出ない');
}));

test('[8性能] 通知処理の所要時間を記録する（合格基準は未確定のため記録のみ）', async (t) => withEnv(t, async (env) => {
  for (const i of [7, 8, 9]) await env.adapter.submit(env.host, env.req(R[i], { slotId: 'S1' }), R[i]);
  toEveBefore(env);
  await env.adapter.processNotifications(env.host);
  const ex = env.host.executions.filter((e) => e.kind === 'trigger');
  if (ex.length) recordMetric('notify.batch3.estGasMs', ex.at(-1).metrics.estGasMs, 'ms');
}));
