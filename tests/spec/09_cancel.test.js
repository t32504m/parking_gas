'use strict';
// I. 取消し（REQ A-06, A-08, D-023, REQ 8）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, rid, ADMIN } = require('./spec-env');

const D = '2026-11-20';

test('[S-130] 取消しで状態が取消済みになり、割当てが解放され、操作履歴に理由が残る', async (t) => {
  await withSpec(t, async (env) => {
    const r = await env.register({ date: D });
    const c = await env.admin('api_admin_cancel', { reservationId: r.reservationId, reason: '本人から窓口で', requestId: rid() });
    assert.ok(c.status !== 'ERROR' && c.status !== 'REJECTED', JSON.stringify(c));
    assert.equal(env.resById(r.reservationId)['状態'], '取消済み');
    assert.equal(env.activeAllocs(D, 'S1').length, 0);
    const au = env.audit().filter((x) => String(x['予約番号']) === String(r.reservationId) && String(x['操作']).includes('取消'));
    assert.equal(au.length, 1);
    assert.ok(String(au[0]['理由']).includes('本人から窓口で'));
    assert.ok(String(au[0]['操作者']).includes(ADMIN.email));
  });
});

test('[S-131] 保管した日付の予約は取り消せない。60日以内の過ぎた予約は取り消せる', async (t) => {
  await withSpec(t, { now: '2026-09-01T09:00:00+09:00' }, async (env) => {
    const old = await env.register({ date: '2026-09-05', email: 'a@example.net' });
    const recent = await env.register({ date: '2026-09-15', email: 'b@example.net' });
    await env.runTrigger('job_processNotifications');
    env.host.setClock('2026-11-09T03:00:00+09:00');
    await env.runTrigger('job_archiveLedger');
    const c = await env.admin('api_admin_cancel', { reservationId: old.reservationId, reason: '管理者の判断', requestId: rid() });
    assert.ok(!['OK', 'CANCELLED'].includes(c.status), `保管した予約を取り消せた: ${JSON.stringify(c)}`);
    const arch = (env.sheet('予約（保管）') || []).find((x) => String(x['予約番号']) === String(old.reservationId));
    assert.equal(arch && arch['状態'], '確定', '保管した予約の状態が変わった');
    assert.ok(!env.resById(old.reservationId), '保管した予約が元のシートに戻った');
    const c2 = await env.admin('api_admin_cancel', { reservationId: recent.reservationId, reason: '管理者の判断', requestId: rid() });
    assert.ok(c2.status !== 'ERROR' && c2.status !== 'REJECTED', JSON.stringify(c2));
    assert.equal(env.resById(recent.reservationId)['状態'], '取消済み');
  });
});

test('[S-132] 取り消した予約は、元の受付要求IDで送り直しても確定に戻らない', async (t) => {
  await withSpec(t, async (env) => {
    const req = env.regReq({ date: D });
    const r = await env.register(req);
    await env.admin('api_admin_cancel', { reservationId: r.reservationId, reason: '本人から電話', requestId: rid() });
    const again = env.val(await env.raw('api_admin_register', [env.auth(ADMIN), req]));
    assert.notEqual(again.status === 'CONFIRMED' && again.reservationId === r.reservationId && env.resById(r.reservationId)['状態'] === '確定', true);
    assert.equal(env.resById(r.reservationId)['状態'], '取消済み');
    assert.equal(env.reservations().filter((x) => x['受付要求ID'] === req.requestId).length, 1);
    const st = await env.pub('api_getRequestStatus', { requestId: req.requestId });
    assert.notEqual(st.status, 'CONFIRMED', `取り消した予約の受付要求IDが「確定」と答える: ${JSON.stringify(st)}`);
  });
});
