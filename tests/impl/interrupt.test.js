'use strict';
// 変更・取消しの実行が途中で止まったとき（Google 側の時間切れ・障害）の残骸が、片付けでそろうこと（D-026）。
// 止まる場所ごとに、毎晩の job_archiveLedger の後（または同じ予約をもう一度変更した後）、
// 確定の予約の「有効」な割当てが、予約の行の利用日・コマと合い、台数と同じ数で、「変更前」か「変更後」のどちらかになる。
// エミュレータは、止まった実行の反映前の書込みを捨てる（何も残らない）。ここでは、止まる前の書込みが
// シートに残った場合を試すため、書込みをその場で反映させる（env.host.deferWrites = false）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS, DAY } = require('../helpers');

const R = ACTORS.residents[0];
const adm = (env, fn, q) => env.host.run(fn, [{ email: ACTORS.admin.email, secret: ACTORS.admin.secret }, q], { kind: 'client', user: ACTORS.admin.email });
const nightly = (env) => env.host.run('job_archiveLedger', [], { kind: 'trigger' });
const dump = (env, name) => env.host.dumpSheet(env.spreadsheetId, name).rows;

async function register(env) {
  env.host.deferWrites = false;
  const r = await env.adapter.adminRegister(env.host, { ...env.req(R, { slotId: 'S1', preferSpace: '91' }), channel: 'PHONE', email: undefined }, ACTORS.admin);
  assert.equal(r.status, 'CONFIRMED');
  return r.reservationId;
}

/** その予約の有効な割当て（[利用日, コマ, 区画]）と、予約の行 */
function stateOf(env, rid) {
  const row = dump(env, '予約').find((x) => String(x['予約番号']) === rid);
  const act = dump(env, '割当て').filter((a) => String(a['予約番号']) === rid && a['状態'] === '有効')
    .map((a) => [String(a['利用日']), String(a['コマID']), String(a['駐車場'])]);
  return { row, act };
}

function assertTidy(state, choices, msg) {
  const { row, act } = state;
  if (row['状態'] !== '確定') { assert.deepEqual(act, [], `${msg}: 確定でない予約に割当てが残る`); return; }
  act.forEach((a) => assert.deepEqual(a.slice(0, 2), [String(row['利用日']), String(row['コマID'])], `${msg}: 予約の行と合わない割当て ${a}`));
  assert.equal(act.length, Number(row['台数']), `${msg}: 割当ての数が台数と違う`);
  assert.ok(choices.some((c) => JSON.stringify(c) === JSON.stringify(act)), `${msg}: 変更前でも変更後でもない ${JSON.stringify(act)}`);
}

const MOVES = {
  '日・時間帯': { date: '2026-10-28', slotId: 'S3', after: [['2026-10-28', 'S3', '91']] },
  '区画だけ': { date: DAY, slotId: 'S1', preferSpace: '93', after: [[DAY, 'S1', '93']] },
};

for (const [kind, mv] of Object.entries(MOVES)) {
  test(`変更（${kind}）がどの書込みの後で止まっても、毎晩の片付けで変更前か変更後にそろう`, async (t) => withEnv(t, async (env) => {
    for (let at = 1; at <= 3; at++) {
      const rid = await register(env);
      const before = [[DAY, 'S1', '91']];
      env.host.setFaults({ terminateAfterWrite: { fn: 'api_admin_change', at } });
      const r = await adm(env, 'api_admin_change', { reservationId: rid, date: mv.date, slotId: mv.slotId, preferSpace: mv.preferSpace, name: R.name, building: R.building, room: R.room, phone: R.phone });
      env.host.clearFaults();
      assert.ok(!r.ok, `at=${at}: 止まらなかった`);
      const n = await nightly(env);
      assert.ok(n.ok, JSON.stringify(n.error));
      assertTidy(stateOf(env, rid), [before, mv.after], `${kind} at=${at}`);
      await adm(env, 'api_admin_cancel', { reservationId: rid, reason: '試験の片付け' });
      assert.deepEqual(stateOf(env, rid).act, [], `at=${at}: 取消しで割当てが残る`);
    }
  }));
}

test('変更が止まった予約を、もう一度変更すると、残骸を片付けてから変える', async (t) => withEnv(t, async (env) => {
  const rid = await register(env);
  const q = { reservationId: rid, date: '2026-10-28', slotId: 'S3', name: R.name, building: R.building, room: R.room, phone: R.phone };
  env.host.setFaults({ terminateAfterWrite: { fn: 'api_admin_change', at: 2 } });
  await adm(env, 'api_admin_change', q);
  env.host.clearFaults();
  const r = await adm(env, 'api_admin_change', { ...q, slotId: 'S4' });
  assert.equal(r.value.status, 'CHANGED', JSON.stringify(r.value || r.error));
  assertTidy(stateOf(env, rid), [[['2026-10-28', 'S4', '91']]], 'もう一度の変更');
  const log = dump(env, '操作履歴').filter((x) => x['操作'] === '片付け');
  assert.equal(log.length, 1, '片付けが操作履歴に残らない');
}));

test('取消しが途中で止まっても、毎晩の片付けで枠が放される', async (t) => withEnv(t, async (env) => {
  const rid = await register(env);
  env.host.setFaults({ terminateAfterWrite: { fn: 'api_admin_cancel', at: 1 } });
  await adm(env, 'api_admin_cancel', { reservationId: rid, reason: '本人から電話' });
  env.host.clearFaults();
  assert.equal(stateOf(env, rid).row['状態'], '取消済み');
  await nightly(env);
  assert.deepEqual(stateOf(env, rid).act, []);
}));
