'use strict';
// 連続の予約を同じ区画に寄せる（D-031）。
// 区画を自動で選ぶとき（住民の申込み・区画を指定しない管理者の登録・管理者の変更）、同じ部屋の確定の予約が
// すぐ前か後のコマにあれば、その区画が空いていればそこを選ぶ。空いていなければ、ほかの区画で受ける（断らない）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS, DAY } = require('../helpers');

const R = ACTORS.residents;
const NEXT = '2026-10-27';
const PREV = '2026-10-25';
const dump = (env, name) => env.host.dumpSheet(env.spreadsheetId, name).rows;

/** 管理者が登録する（space を渡すと、台帳のマスを押して選んだのと同じ） */
async function adminReg(env, who, slotId, o = {}) {
  const req = { ...env.req(who, { slotId, ...o }), channel: 'PHONE', email: undefined };
  const r = await env.adapter.adminRegister(env.host, req, ACTORS.admin);
  assert.equal(r.status, 'CONFIRMED', JSON.stringify(r.raw));
  return r;
}
async function residentReg(env, who, slotId, o = {}) {
  const r = await env.adapter.submit(env.host, env.req(who, { slotId, ...o }), who);
  assert.equal(r.status, 'CONFIRMED', JSON.stringify(r.raw));
  return r;
}
function spacesOf(env, rid) {
  return dump(env, '割当て').filter((a) => String(a['予約番号']) === String(rid) && a['状態'] === '有効').map((a) => String(a['駐車場']));
}

test('住民の申込みは、同じ部屋のすぐ前のコマの区画に寄せる（部屋の書き方の揺れはそろえて比べる）', async (t) => withEnv(t, async (env) => {
  await adminReg(env, R[1], 'S2', { preferSpace: '91' }); // 別の部屋が 91 を使う
  const a = await adminReg(env, R[0], 'S1', { preferSpace: '93' });
  assert.deepEqual(spacesOf(env, a.reservationId), ['93']);
  const b = await residentReg(env, R[0], 'S2', { building: ` ${R[0].building.replace(/棟$/, '').normalize('NFKC').replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0))} `, room: `${R[0].room}号室` });
  assert.deepEqual(spacesOf(env, b.reservationId), ['93']);
}));

test('日をまたぐ：S4 の次は翌日の S1、S1 の前は前日の S4', async (t) => withEnv(t, async (env) => {
  const a = await adminReg(env, R[2], 'S4', { preferSpace: '92' });
  const b = await adminReg(env, R[2], 'S1', { date: NEXT });
  assert.deepEqual(spacesOf(env, b.reservationId), ['92'], 'S4 の次の日の S1');
  const c = await adminReg(env, R[3], 'S1', { preferSpace: '93' });
  const d = await adminReg(env, R[3], 'S4', { date: PREV });
  assert.deepEqual(spacesOf(env, d.reservationId), ['93'], 'S1 の前の日の S4');
  assert.ok(a && c);
}));

test('前と後で区画が違えば、前の予約に合わせる', async (t) => withEnv(t, async (env) => {
  await adminReg(env, R[4], 'S1', { preferSpace: '92' });
  await adminReg(env, R[4], 'S3', { preferSpace: '93' });
  const m = await adminReg(env, R[4], 'S2');
  assert.deepEqual(spacesOf(env, m.reservationId), ['92']);
}));

test('寄せたい区画が埋まっていれば、ほかの空いている区画で受ける（断らない）', async (t) => withEnv(t, async (env) => {
  await adminReg(env, R[5], 'S1', { preferSpace: '91' });
  await adminReg(env, R[6], 'S2', { preferSpace: '91' }); // 別の部屋が先に 91 を取った
  const b = await residentReg(env, R[5], 'S2');
  assert.equal(spacesOf(env, b.reservationId).length, 1);
  assert.notEqual(spacesOf(env, b.reservationId)[0], '91');
}));

test('管理者が台帳のマスを押して選んだ区画は、連続の区画より優先する', async (t) => withEnv(t, async (env) => {
  await adminReg(env, R[7], 'S1', { preferSpace: '91' });
  const b = await adminReg(env, R[7], 'S2', { preferSpace: '93' });
  assert.deepEqual(spacesOf(env, b.reservationId), ['93']);
}));

test('取り消した予約や、別の部屋の予約には寄せない', async (t) => withEnv(t, async (env) => {
  const a = await adminReg(env, R[8], 'S1', { preferSpace: '93' });
  await env.adapter.adminCancel(env.host, { reservationId: a.reservationId, reason: '試験' }, ACTORS.admin);
  const b = await adminReg(env, R[8], 'S2');
  assert.deepEqual(spacesOf(env, b.reservationId), ['91'], '取り消した予約の区画に寄せた');
  await adminReg(env, R[9], 'S3', { preferSpace: '92' });
  const c = await adminReg(env, R[10], 'S4', { building: R[9].building, room: String(Number(R[9].room) + 1) });
  assert.deepEqual(spacesOf(env, c.reservationId), ['91'], '別の部屋の区画に寄せた');
}));

test('管理者の変更でも、移った先の前後の同じ部屋の区画に寄せる', async (t) => withEnv(t, async (env) => {
  await adminReg(env, R[11], 'S3', { preferSpace: '93' });
  const b = await adminReg(env, R[11], 'S1', { date: NEXT });
  const q = { reservationId: b.reservationId, date: DAY, slotId: 'S4', name: R[11].name, building: R[11].building, room: R[11].room, phone: R[11].phone };
  const r = await env.host.run('api_admin_change', [{ email: ACTORS.admin.email, secret: ACTORS.admin.secret }, q], { kind: 'client', user: ACTORS.admin.email });
  assert.equal(r.value.status, 'CHANGED', JSON.stringify(r.value || r.error));
  assert.deepEqual(spacesOf(env, b.reservationId), ['93']);
}));
