'use strict';
// 正常動作（要件11「正常動作」・6.1・6.2・6.4・5章）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS, DAY, CONTRACT, findLeaks, piiOf } = require('../helpers');

const R = ACTORS.residents;
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const slot = (av, date, id) => av.days.find((d) => d.date === date)?.slots.find((s) => s.slotId === id);

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

test('[U-02][U-03][5章] 空き状況に4コマの時間帯・料金・空きの有無が出る（台数の数は出ない）', async (t) => withEnv(t, async (env) => {
  const av = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  const day = av.days.find((d) => d.date === DAY);
  assert.ok(day, `${DAY} の空き情報が無い`);
  assert.deepEqual(day.slots.map((s) => s.slotId).sort(), ['S1', 'S2', 'S3', 'S4']);
  for (const s of day.slots) {
    const def = CONTRACT.slots[s.slotId];
    assert.equal(Number(s.price), def.price, `${s.slotId} の料金`);
    residentSlot(s, true, s.slotId);
    assert.equal(used(env, DAY, s.slotId), 0, `${s.slotId} の台帳の割当て`);
  }
  const raw = JSON.stringify(av.raw);
  assert.ok(!raw.includes('"remaining"') && !raw.includes('"capacity"'), '住民の応答に台数の数がある');
}));

test('[5章][11正常] 第4コマは翌日8:00終了・600円として扱われる', async (t) => withEnv(t, async (env) => {
  const av = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  const s4 = slot(av, DAY, 'S4');
  assert.ok(s4, 'S4 が無い');
  assert.equal(Date.parse(s4.start), Date.parse(`${DAY}T17:00:00+09:00`), `S4 開始 ${s4.start}`);
  assert.equal(Date.parse(s4.end), Date.parse(`${nextDay(DAY)}T08:00:00+09:00`), `S4 終了 ${s4.end}（翌日8:00であること）`);
  const r = await env.adapter.submit(env.host, env.req(R[0], { slotId: 'S4' }), R[0]);
  assert.equal(r.status, 'CONFIRMED', JSON.stringify(r.raw));
  const row = env.table('reservations').rows.find((x) => String(x.reservation_id) === String(r.reservationId));
  assert.ok(row, '台帳に予約が無い');
  assert.equal(Number(row.price_total), 600, '台帳の料金');
  const end = row.end_at instanceof Date ? row.end_at.getTime() : Date.parse(row.end_at);
  assert.equal(end, Date.parse(`${nextDay(DAY)}T08:00:00+09:00`), `台帳の終了日時 ${row.end_at}`);
  // 翌日の第1コマは別枠として空いている
  const av2 = await env.adapter.getAvailability(env.host, { from: nextDay(DAY), to: nextDay(DAY) }, ACTORS.anonymous);
  assert.equal(used(env, DAY, 'S4'), 1, '当日 S4 の割当て');
  assert.equal(used(env, nextDay(DAY), 'S1'), 0, 'S4 が翌日 S1 の枠を消費してはいけない');
  residentSlot(slot(av2, nextDay(DAY), 'S1'), true, '翌日 S1');
}));

test('[U-04][U-06][6.4] オンライン申込みで確定し、台帳に必要項目が残る', async (t) => withEnv(t, async (env) => {
  const req = env.req(R[1], { slotId: 'S2', quantity: 2 });
  const r = await env.adapter.submit(env.host, req, R[1]);
  assert.equal(r.status, 'CONFIRMED', JSON.stringify(r.raw));
  assert.ok(r.reservationId, '予約番号が返らない（U-08）');
  const row = env.table('reservations').rows.find((x) => String(x.reservation_id) === String(r.reservationId));
  assert.ok(row, '予約台帳に行が無い');
  assert.equal(String(row.request_id), req.requestId, '受付要求IDが保存されていない');
  assert.equal(String(row.channel).toUpperCase(), 'ONLINE', `受付経路 ${row.channel}`);
  assert.equal(Number(row.quantity), 2);
  assert.equal(Number(row.price_total), 600, '300円×2台');
  assert.ok(row.created_at !== '' && row.created_at !== undefined, 'システム受付日時が無い');
  const av = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  assert.equal(used(env, DAY, 'S2'), CAP - 1, '2台で残り1台');
  residentSlot(slot(av, DAY, 'S2'), true, 'S2（残り1台）');
}));

test('[A-02][A-03][6.6] 電話受付の代行登録はメールなしで確定できる', async (t) => withEnv(t, async (env) => {
  const req = env.req(R[2], { slotId: 'S3', channel: 'PHONE', email: undefined });
  const r = await env.adapter.adminRegister(env.host, req, ACTORS.admin);
  assert.equal(r.status, 'CONFIRMED', JSON.stringify(r.raw));
  const row = env.table('reservations').rows.find((x) => String(x.reservation_id) === String(r.reservationId));
  assert.equal(String(row.channel).toUpperCase(), 'PHONE');
  assert.ok(String(row.operator || '').length > 0, '代行登録した管理者が記録されていない（A-08）');
}));

test('[A-01][A-04][8整合性] 利用者画面と管理者画面が同じ確定情報を参照する', async (t) => withEnv(t, async (env) => {
  const a = await env.adapter.submit(env.host, env.req(R[3], { slotId: 'S1' }), R[3]);
  const b = await env.adapter.adminRegister(env.host, env.req(R[4], { slotId: 'S1', channel: 'COUNTER', email: undefined }), ACTORS.admin);
  assert.equal(a.status, 'CONFIRMED'); assert.equal(b.status, 'CONFIRMED');
  const av = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  assert.equal(used(env, DAY, 'S1'), CAP - 1, 'オンラインと代行登録で2台');
  residentSlot(slot(av, DAY, 'S1'), true, 'S1（残り1台）');
  const list = await env.adapter.adminList(env.host, { date: DAY }, ACTORS.admin);
  const ids = list.reservations.filter((x) => x.state === 'CONFIRMED').map((x) => String(x.reservationId));
  assert.ok(ids.includes(String(a.reservationId)) && ids.includes(String(b.reservationId)), 'オンラインと代行登録の両方が一覧に出ること');
}));

test('[A-06][11正常] 取消し後、その枠が空きに戻り、別の人が予約できる', async (t) => withEnv(t, async (env) => {
  const ids = [];
  for (const i of [5, 6, 7]) {
    const r = await env.adapter.submit(env.host, env.req(R[i], { slotId: 'S3' }), R[i]);
    assert.equal(r.status, 'CONFIRMED'); ids.push(r.reservationId);
  }
  const full = await env.adapter.submit(env.host, env.req(R[8], { slotId: 'S3' }), R[8]);
  assert.equal(full.status, 'REJECTED', '満車なのに不成立にならない');
  const avFull = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  residentSlot(slot(avFull, DAY, 'S3'), false, 'S3（満車）');
  const c = await env.adapter.adminCancel(env.host, { reservationId: ids[1], reason: '本人から電話で取消し', requestId: `cx-${ids[1]}` }, ACTORS.admin);
  assert.equal(c.status, 'CANCELLED', JSON.stringify(c.raw));
  const av = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  assert.equal(used(env, DAY, 'S3'), CAP - 1, '取消し後の割当て');
  residentSlot(slot(av, DAY, 'S3'), true, 'S3（取消し後）');
  const again = await env.adapter.submit(env.host, env.req(R[8], { slotId: 'S3' }), R[8]);
  assert.equal(again.status, 'CONFIRMED');
}));

test('[6.1][9][8個人情報] 一般公開の空き情報に他人の氏名・部屋・連絡先が含まれない', async (t) => withEnv(t, async (env) => {
  for (const i of [0, 1, 2]) await env.adapter.submit(env.host, env.req(R[i], { slotId: 'S1' }), R[i]);
  await env.adapter.adminRegister(env.host, env.req(R[3], { slotId: 'S2', channel: 'PHONE', email: undefined }), ACTORS.admin);
  const av = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  const leaks = findLeaks(av.raw, piiOf(R.slice(0, 4)));
  assert.deepEqual(leaks, [], `空き情報の応答に個人情報が含まれる: ${leaks.join(', ')}`);
}));
