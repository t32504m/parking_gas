'use strict';
// D. 送り直し（REQ 6.5, CLAUDE 5, D-016, D-024）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, ADMIN, rid, ymdOf } = require('./spec-env');

const D = '2026-11-20';
const send = async (env, req) => env.val(await env.raw('api_admin_register', [env.auth(ADMIN), req]));

test('[S-050] 同じ受付要求IDの送り直しは1件。同じ予約番号を返す', async (t) => {
  await withSpec(t, async (env) => {
    const req = env.regReq({ date: D });
    const a = await send(env, req);
    const b = await send(env, req);
    assert.equal(a.status, 'CONFIRMED');
    assert.equal(b.status, 'CONFIRMED');
    assert.equal(b.reservationId, a.reservationId);
    assert.equal(env.reservations().filter((r) => r['受付要求ID'] === req.requestId).length, 1);
  });
});

test('[S-051] 同じ受付要求IDで中身を変えて送っても、2件目を作らない', async (t) => {
  await withSpec(t, async (env) => {
    const req = env.regReq({ date: D });
    const a = await send(env, req);
    const b = await send(env, { ...req, date: '2026-11-21', slotId: 'S3' });
    assert.equal(env.reservations().filter((r) => r['受付要求ID'] === req.requestId).length, 1);
    assert.equal(env.activeAllocs('2026-11-21').length, 0);
    assert.equal(ymdOf(env.resById(a.reservationId)['利用日']), D);
    if (b.status === 'CONFIRMED') assert.equal(b.reservationId, a.reservationId);
  });
});

test('[S-052] 受付要求IDで後から結果を確かめられる', async (t) => {
  await withSpec(t, async (env) => {
    const req = env.regReq({ date: D });
    const a = await send(env, req);
    const s = await env.pub('api_getRequestStatus', { requestId: req.requestId });
    assert.equal(s.status, 'CONFIRMED');
    assert.equal(s.reservationId, a.reservationId);
    const u = await env.pub('api_getRequestStatus', { requestId: rid() });
    assert.notEqual(u.status, 'CONFIRMED');
    assert.notEqual(u.status, 'ERROR');
  });
});

test('[S-053] 処理の途中で止まった後に送り直しても、二重・所在不明にならない', async (t) => {
  await withSpec(t, async (env) => {
    const slots = ['S1', 'S2', 'S3', 'S4'];
    for (let at = 1; at <= 8; at++) {
      const date = `2026-11-${10 + at}`;
      const req = env.regReq({ date, slotId: slots[at % 4] });
      env.host.setFaults({ terminateAfterWrite: { fn: 'api_admin_register', at } });
      const first = await send(env, req);
      env.host.clearFaults();
      const again = await send(env, req);
      const rows = env.reservations().filter((r) => r['受付要求ID'] === req.requestId);
      assert.ok(rows.length <= 1, `at=${at}: 同じ要求の行が ${rows.length}`);
      assert.equal(again.status, 'CONFIRMED', `at=${at}: 送り直しで確定しない ${JSON.stringify(again)}（初回 ${JSON.stringify(first)}）`);
      assert.equal(rows.filter((r) => r['状態'] === '確定').length, 1, `at=${at}`);
      const st = await env.pub('api_getRequestStatus', { requestId: req.requestId });
      assert.equal(st.status, 'CONFIRMED', `at=${at}`);
    }
  });
});

test('[S-054] 同じ変更を送り直しても、2回目は何も変えない', async (t) => {
  await withSpec(t, async (env) => {
    const req = env.regReq({ date: D });
    const a = await send(env, req);
    const q = { reservationId: a.reservationId, date: '2026-11-21', slotId: 'S2', name: req.name, building: req.building, room: req.room, phone: req.phone, email: '' };
    const r1 = await env.admin('api_admin_change', q);
    const r2 = await env.admin('api_admin_change', q);
    assert.equal(r1.status, 'CHANGED');
    assert.ok(r2.status !== 'ERROR' && r2.status !== 'DENIED', JSON.stringify(r2));
    const ch = env.audit().filter((x) => String(x['予約番号']) === String(a.reservationId) && String(x['操作']).includes('変更'));
    assert.equal(ch.length, 1, '操作履歴の「変更」が2件');
    assert.equal(env.allocations().filter((x) => String(x['予約番号']) === String(a.reservationId) && x['状態'] === '有効').length, 1);
  });
});

test('[S-055] 同じ受付要求IDの使用禁止を送り直しても、二重にならない', async (t) => {
  await withSpec(t, async (env) => {
    const q = { requestId: rid(), from: D, to: '2026-11-22', slots: ['S1', 'S2'], spaces: ['93'], reason: '工事・点検', memo: '塗装', confirm: true };
    const a = await env.admin('api_admin_addBlock', q);
    const b = await env.admin('api_admin_addBlock', q);
    assert.equal(a.status, 'OK');
    assert.ok(b.status === 'OK' && b.blockId === a.blockId, JSON.stringify(b));
    assert.equal(env.sheet('使用禁止').filter((x) => x['受付要求ID'] === q.requestId).length, 1);
    assert.equal(env.audit().filter((x) => x['操作'] === '使用禁止').length, 1);
  });
});

test('[S-056] 同じ取消しを2回送っても、取消しは1回', async (t) => {
  await withSpec(t, async (env) => {
    const a = await send(env, env.regReq({ date: D }));
    const q = { reservationId: a.reservationId, reason: '本人から電話', requestId: rid() };
    await env.admin('api_admin_cancel', q);
    const r2 = await env.admin('api_admin_cancel', q);
    assert.ok(r2.status !== 'ERROR', JSON.stringify(r2));
    await env.admin('api_admin_cancel', { ...q, requestId: rid() }); // 別の画面から、もう一度
    assert.equal(env.resById(a.reservationId)['状態'], '取消済み');
    const cn = env.audit().filter((x) => String(x['予約番号']) === String(a.reservationId) && String(x['操作']).includes('取消'));
    assert.equal(cn.length, 1, `取消しの操作履歴が ${cn.length} 件`);
  });
});
