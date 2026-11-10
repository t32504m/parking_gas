'use strict';
// メールは受付のときではなく、利用日の前日に「明日のご予約」の案内を1通送る（D-030）。
// 試験の今日は 2026-10-19（月）9:00、利用日は 2026-10-26。前日の送る時刻は RULES.remindHour（既定 17時）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS, DAY } = require('../helpers');

const R = ACTORS.residents;
const at = (ymdHm) => `${ymdHm}:00+09:00`;
const job = (env) => env.host.run('job_processNotifications', [], { kind: 'trigger' });
const mails = (env, who) => env.host.outbox.filter((m) => String(m.to).includes(who.email));
const ntfOf = (env, rid) => env.host.dumpSheet(env.spreadsheetId, '通知').rows.find((n) => String(n['予約番号']) === String(rid));
const adm = { email: ACTORS.admin.email, secret: ACTORS.admin.secret };

async function submit(env, who, o = {}) {
  const r = await env.adapter.submit(env.host, env.req(who, { slotId: 'S1', ...o }), who);
  assert.equal(r.status, 'CONFIRMED', JSON.stringify(r.raw));
  return r.reservationId;
}
async function change(env, who, rid, date, slotId = 'S1') {
  const q = { reservationId: rid, date, slotId, name: who.name, building: who.building, room: who.room, phone: who.phone, email: who.email };
  const r = await env.host.run('api_admin_change', [adm, q], { kind: 'client', user: ACTORS.admin.email });
  assert.equal(r.value.status, 'CHANGED', JSON.stringify(r.value || r.error));
}

test('受付のときには送らず、利用日の前日の送る時刻の後に、案内を1通だけ送る', async (t) => withEnv(t, async (env) => {
  const rid = await submit(env, R[0], { preferSpace: '93' });
  assert.equal(env.host.mailAttempts.length, 0, '受付のときにメールを送った');
  await job(env);
  assert.equal(mails(env, R[0]).length, 0, '前日より前に送った');
  env.host.setClock(at('2026-10-25T16:59'));
  await job(env);
  assert.equal(mails(env, R[0]).length, 0, '前日の送る時刻より前に送った');
  env.host.setClock(at('2026-10-25T17:05'));
  await job(env);
  const m = mails(env, R[0]);
  assert.equal(m.length, 1);
  assert.match(m[0].subject, /明日のご予約/);
  assert.doesNotMatch(`${m[0].subject}${m[0].body}`, /確定しました/);
  for (const s of ['2026年10月26日', 'A', '朝', String(rid)]) assert.ok(m[0].body.includes(s), `本文に ${s} が無い`);
  assert.match(m[0].body, /区画：9[1-3]/);
  assert.equal(ntfOf(env, rid)['状態'], '送信済み');
  await job(env);
  assert.equal(mails(env, R[0]).length, 1, '2回目の実行で二重に送った');
}));

test('前日の送る時刻より後に入った予約と、当日の予約には送らない（通知は「不要」）', async (t) => withEnv(t, async (env) => {
  env.host.setClock(at('2026-10-25T20:00'));
  const late = await submit(env, R[1]);
  env.host.setClock(at('2026-10-26T09:00'));
  const today = await submit(env, R[2], { slotId: 'S3' });
  await job(env);
  assert.equal(env.host.mailAttempts.length, 0);
  assert.equal(ntfOf(env, late)['状態'], '不要');
  assert.equal(ntfOf(env, today)['状態'], '不要');
}));

test('取り消した予約には送らない', async (t) => withEnv(t, async (env) => {
  const rid = await submit(env, R[3]);
  await env.adapter.adminCancel(env.host, { reservationId: rid, reason: '試験' }, ACTORS.admin);
  env.host.setClock(at('2026-10-25T17:05'));
  await job(env);
  assert.equal(mails(env, R[3]).length, 0);
  assert.equal(ntfOf(env, rid)['状態'], '不要');
}));

test('管理者が利用日を変えた予約には、変更後の利用日の前日に送る（前の日の分を送った後でも）', async (t) => withEnv(t, async (env) => {
  const a = await submit(env, R[4]);
  await change(env, R[4], a, '2026-10-28');
  const b = await submit(env, R[5]);
  env.host.setClock(at('2026-10-25T17:05'));
  await job(env);
  assert.equal(mails(env, R[4]).length, 0, '変更前の利用日の前日に送った');
  assert.equal(mails(env, R[5]).length, 1);
  await change(env, R[5], b, '2026-10-28', 'S2');
  env.host.setClock(at('2026-10-27T17:05'));
  await job(env);
  assert.equal(mails(env, R[4]).length, 1);
  assert.ok(mails(env, R[4])[0].body.includes('2026年10月28日'));
  assert.equal(mails(env, R[5]).length, 2, '変更後の利用日の分を送らない');
  assert.ok(mails(env, R[5])[1].body.includes('2026年10月28日'));
}));

test('前日に送れなかった分は、その日のうちに動かし直せば送る。利用日を過ぎたら送らない', async (t) => withEnv(t, async (env) => {
  const rid = await submit(env, R[6]);
  env.host.setClock(at('2026-10-25T17:05'));
  env.host.setFaults({ mail: { failAll: true, message: 'Service unavailable: Gmail' } });
  await job(env);
  env.host.clearFaults();
  assert.equal(ntfOf(env, rid)['状態'], '再送待ち');
  env.host.setClock(at('2026-10-27T17:05'));
  await job(env);
  assert.equal(mails(env, R[6]).length, 0);
  assert.equal(ntfOf(env, rid)['状態'], '不要');
  const rid2 = await submit(env, R[7], { date: '2026-10-29' });
  env.host.setClock(at('2026-10-28T17:05'));
  env.host.setFaults({ mail: { failAll: true, message: 'Service unavailable: Gmail' } });
  await job(env);
  env.host.clearFaults();
  env.host.setClock(at('2026-10-28T19:00'));
  await job(env);
  assert.equal(mails(env, R[7]).length, 1);
  assert.equal(ntfOf(env, rid2)['状態'], '送信済み');
}));

test('送る数は、その日の予約の数まで（他人の宛先で先の日を大量に申し込んでも、前日の分の上限を使い切らない）', async (t) => withEnv(t, async (env) => {
  for (let i = 0; i < 12; i++) await submit(env, R[8], { date: '2026-11-0' + (1 + (i % 4)), slotId: ['S1', 'S2', 'S3', 'S4'][Math.floor(i / 4)], name: `大量 ${i}` });
  const mine = await submit(env, R[9]);
  env.host.setClock(at('2026-10-25T17:05'));
  await job(env);
  assert.equal(env.host.outbox.length, 1, '前日でない予約の分も送った');
  assert.equal(mails(env, R[9]).length, 1);
  assert.ok(mine);
}));

test('setup_run を実行し直すと、前の版の5分ごとの通知のトリガーを消し、1日1回のトリガーにする', async (t) => withEnv(t, async (env) => {
  env.host._triggerCreate({ fn: 'job_processNotifications', type: 'every', ms: 5 * 60000 }, {});
  const r = await env.host.run('setup_run', [], { kind: 'editor' });
  assert.ok(r.ok && r.value.status === 'OK', JSON.stringify(r.error || r.value));
  const ts = env.host.triggers.filter((x) => x.fn === 'job_processNotifications');
  assert.equal(ts.length, 1, `通知のトリガーが ${ts.length} 個`);
  assert.equal(ts[0].everyMs, 86400000, '1日1回でない');
  await env.host.run('setup_run', [], { kind: 'editor' });
  assert.equal(env.host.triggers.filter((x) => x.fn === 'job_processNotifications').length, 1, '実行し直すと増える');
}));
