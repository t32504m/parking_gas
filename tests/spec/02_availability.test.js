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

// D-040（依頼者の決定、2026-11-12）：前は「3台目は管理者でも登録できない」を確かめていた
test('[S-021] 管理者は3台目（全ての区画）まで登録でき、4台目は登録できない。住民には2台で×のまま', async (t) => {
  await withSpec(t, async (env) => {
    await env.register({ date: D }); await env.register({ date: D });
    assert.ok(!isOpen(await slotOf(env, D, 'S1')), '2台で住民に×にならない');
    const r = await env.register({ date: D });
    assert.equal(r.status, 'CONFIRMED', `管理者の3台目: ${JSON.stringify(r)}`);
    assert.deepEqual(env.activeAllocs(D, 'S1').map((a) => String(a['駐車場'])).sort(), ['91', '92', '93']);
    assert.ok(!isOpen(await slotOf(env, D, 'S1')), '3台で住民に○になった');
    const r4 = await env.register({ date: D });
    assert.notEqual(r4.status, 'CONFIRMED', '4台目が入った');
    assert.equal(env.activeAllocs(D, 'S1').length, 3);
  });
});

test('[S-026] 住民の申込み（開いた設定）は2台で断る。管理者が3台目を入れた後も、住民は入れない', async (t) => {
  await withSpec(t, { rules: { residentBooking: true, residentLeadDays: 0 } }, async (env) => {
    const sub = () => env.pub('api_submitReservation', env.regReq({ date: D, slotId: 'S2', channel: undefined }));
    assert.equal((await sub()).status, 'CONFIRMED');
    assert.equal((await sub()).status, 'CONFIRMED');
    assert.notEqual((await sub()).status, 'CONFIRMED', '住民の3台目が入った');
    assert.equal((await env.register({ date: D, slotId: 'S2' })).status, 'CONFIRMED', '管理者の3台目が入らない');
    assert.notEqual((await sub()).status, 'CONFIRMED');
    assert.equal(env.activeAllocs(D, 'S2').length, 3);
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
    // 管理者の空き状況の残りは、全ての区画（3台）から数える（D-040）
    const aa = (await env.adminAvail(D, D)).days[0].slots.find((x) => x.slotId === 'S3');
    assert.equal(aa.remaining, 2);
  });
});
