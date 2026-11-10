'use strict';
// B. 空き状況と見え方（D-014, D-020, REQ 6.1, 8, 11）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, PEOPLE, pii, leaks, slotOpen } = require('./spec-env');

const D = '2026-11-20';
async function slotOf(env, date, id) {
  const r = await env.avail(date, date);
  return r.days[0].slots.find((s) => s.slotId === id);
}
const isOpen = slotOpen;

test('[S-020] 1コマ2台：1台入っても空き（○）、2台で満車（×）', async (t) => {
  await withSpec(t, async (env) => {
    assert.ok(isOpen(await slotOf(env, D, 'S1')));
    assert.equal((await env.register({ date: D })).status, 'CONFIRMED');
    assert.ok(isOpen(await slotOf(env, D, 'S1')), '1台で満車になった');
    assert.equal((await env.register({ date: D })).status, 'CONFIRMED');
    assert.ok(!isOpen(await slotOf(env, D, 'S1')), '2台で満車にならない');
    assert.ok(isOpen(await slotOf(env, D, 'S2')), 'ほかのコマまで満車になった');
  });
});

test('[S-021] 3台目は管理者でも登録できない', async (t) => {
  await withSpec(t, async (env) => {
    await env.register({ date: D }); await env.register({ date: D });
    const r = await env.register({ date: D });
    assert.notEqual(r.status, 'CONFIRMED');
    assert.equal(env.activeAllocs(D, 'S1').length, 2);
  });
});

test('[S-022] 住民の空き状況に個人情報が入らない', async (t) => {
  await withSpec(t, async (env) => {
    const ps = PEOPLE.slice(0, 6);
    for (let i = 0; i < ps.length; i++) await env.register({ date: '2026-11-2' + (i % 3), slotId: ['S1', 'S4'][i % 2], person: ps[i], email: `p${i}@example.net` });
    const r = await env.avail('2026-11-14', '2027-01-09');
    assert.deepEqual(leaks(r, pii(ps).concat(ps.map((_, i) => `p${i}@example.net`))), []);
    const s = await env.pub('api_getRequestStatus', { requestId: 'nonexistent' });
    assert.deepEqual(leaks(s, pii(ps)), []);
  });
});

test('[S-023] 住民の空き状況の応答に △ が無い', async (t) => {
  await withSpec(t, async (env) => {
    await env.register({ date: D });
    assert.ok(!JSON.stringify(await env.avail('2026-11-14', '2027-01-09')).includes('△'));
  });
});

test('[S-024] 取消し後、そのコマは空きに戻る', async (t) => {
  await withSpec(t, async (env) => {
    const a = await env.register({ date: D }); await env.register({ date: D });
    assert.ok(!isOpen(await slotOf(env, D, 'S1')));
    const c = await env.admin('api_admin_cancel', { reservationId: a.reservationId, reason: '本人から電話', requestId: 'c-1' });
    assert.ok(['OK', 'CANCELLED'].includes(c.status), JSON.stringify(c));
    assert.ok(isOpen(await slotOf(env, D, 'S1')));
    assert.equal((await env.register({ date: D })).status, 'CONFIRMED');
  });
});

test('[S-025] 管理者の一覧・住民の空き状況・台帳が同じ確定情報を示す', async (t) => {
  await withSpec(t, async (env) => {
    const a = await env.register({ date: D, slotId: 'S3' });
    const list = await env.admin('api_admin_list', { from: D, to: D });
    const item = list.reservations.find((x) => x.reservationId === a.reservationId);
    const alc = env.activeAllocs(D, 'S3');
    assert.equal(alc.length, 1);
    assert.deepEqual(item.spaces, [String(alc[0]['駐車場'])]);
    assert.ok(slotOpen(await slotOf(env, D, 'S3')));
    const aa = (await env.adminAvail(D, D)).days[0].slots.find((x) => x.slotId === 'S3');
    assert.equal(aa.remaining, 1);
  });
});
