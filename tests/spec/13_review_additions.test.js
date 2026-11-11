'use strict';
// 見直し（重複予約・境目・権限・保管・変更の5つの観点）で足した項目
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withSpec, rid, ymdOf, ADMIN, ADMIN2, CONTRACT, TODAY } = require('./spec-env');

const D = '2026-11-20';
const ALL = ['91', '92', '93'];
const spaceOf = (env, id) => env.allocations().filter((a) => String(a['予約番号']) === String(id) && a['状態'] === '有効').map((a) => String(a['駐車場']));

test('[S-012] 住民の予約（開いたとき）：夜コマは16:59まで受け付け、17:00で断る', async (t) => {
  await withSpec(t, { now: '2026-11-09T16:59:00+09:00', rules: { residentBooking: true, residentLeadDays: 0 } }, async (env) => {
    assert.equal((await env.pub('api_submitReservation', env.regReq({ date: TODAY, slotId: 'S4' }))).status, 'CONFIRMED');
    env.host.setClock('2026-11-09T17:00:00+09:00');
    assert.notEqual((await env.pub('api_submitReservation', env.regReq({ date: TODAY, slotId: 'S4' }))).status, 'CONFIRMED');
  });
});

test('[S-042] 埋まっている区画を指定して登録しても、その区画に重ねない', async (t) => {
  await withSpec(t, async (env) => {
    const a = await env.register({ date: D, preferSpace: '92' });
    assert.deepEqual(spaceOf(env, a.reservationId), ['92']);
    const b = await env.register({ date: D, preferSpace: '92' });
    assert.equal(b.status, 'CONFIRMED');
    assert.notDeepEqual(spaceOf(env, b.reservationId), ['92']);
    // 無い区画（99）の指定は、無い区画に入れない（断るか、空いている区画にする）。D-040 で管理者は3台目まで入れる
    const c = await env.register({ date: D, preferSpace: '99' });
    if (c.status === 'CONFIRMED') assert.deepEqual(spaceOf(env, c.reservationId).filter((s) => !['91', '92', '93'].includes(s) || s === '92'), [], '無い区画・埋まった区画に入った');
    const used = env.activeAllocs(D, 'S1').map((x) => String(x['駐車場']));
    assert.equal(new Set(used).size, used.length, '同じ区画に重なった');
    if (used.length === 3) assert.notEqual((await env.register({ date: D, preferSpace: '92' })).status, 'CONFIRMED', '4台目が入った');
  });
});

test('[S-043] 使用禁止の登録と、その枠への変更が同時でも、禁止の後に移らない', async (t) => {
  for (let round = 0; round < 3; round++) {
    await withSpec(t, { latency: { min: 1, max: 6 }, seed: 400 + round }, async (env) => {
      const req = env.regReq({ date: D });
      const x = await env.register(req);
      const rs = (await env.host.runConcurrently([
        { fn: 'api_admin_addBlock', args: [env.auth(ADMIN2), { requestId: rid(), from: '2026-11-21', to: '2026-11-21', slots: ['S2'], spaces: ALL, reason: '行事', memo: '', confirm: true }], kind: 'client', user: null },
        { fn: 'api_admin_change', args: [env.auth(ADMIN), { reservationId: x.reservationId, date: '2026-11-21', slotId: 'S2', name: req.name, building: req.building, room: req.room, phone: req.phone, email: '' }], kind: 'client', user: null },
      ])).map(env.val);
      assert.equal(rs[0].status, 'OK');
      const au = env.audit().map((a) => String(a['操作']));
      const bi = au.findIndex((o) => o.includes('使用禁止'));
      const ci = au.findIndex((o) => o.includes('変更'));
      if (rs[1].status === 'CHANGED') assert.ok(ci < bi, '使用禁止の後に、止めた枠へ変更できた');
    });
  }
});

test('[S-071] 公開の関数（名前が _ で終わらない最上位の関数）は、全て contract の surface に宣言されている', async () => {
  const dir = path.join(__dirname, '..', '..', 'src');
  const names = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.gs'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of s.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)) if (!m[1].endsWith('_')) names.push(m[1]);
    for (const m of s.matchAll(/^(?:var|let|const)\s+([A-Za-z0-9_$]+)\s*=\s*(?:function|\()/gm)) if (!m[1].endsWith('_')) names.push(m[1]);
  }
  const declared = Object.keys(CONTRACT.surface.functions);
  assert.deepEqual(names.filter((n) => !declared.includes(n)), [], '宣言されていない公開の関数');
  for (const [fn, kind] of Object.entries(CONTRACT.surface.functions)) {
    if (fn.startsWith('api_admin_')) assert.equal(kind, 'admin', `${fn} が admin でない`);
    if (fn.startsWith('job_')) assert.equal(kind, 'job');
    if (fn.startsWith('setup_')) assert.equal(kind, 'operator');
  }
});

test('[S-101] 月をまたぐ使用禁止（11/30〜12/1）は、両方の月の予約表に出て、両方の日で止まる', async (t) => {
  await withSpec(t, async (env) => {
    const b = await env.admin('api_admin_addBlock', { requestId: rid(), from: '2026-11-30', to: '2026-12-01', slots: ['S4'], spaces: ALL, reason: '工事・点検', memo: '', confirm: true });
    assert.equal(b.status, 'OK');
    assert.notEqual((await env.register({ date: '2026-11-30', slotId: 'S4' })).status, 'CONFIRMED');
    assert.notEqual((await env.register({ date: '2026-12-01', slotId: 'S4' })).status, 'CONFIRMED');
    assert.equal((await env.register({ date: '2026-12-02', slotId: 'S4' })).status, 'CONFIRMED');
    const nov = JSON.stringify(env.grid('予約表 2026年11月'));
    const dec = JSON.stringify(env.grid('予約表 2026年12月'));
    assert.ok(nov.includes('使用禁止'), '11月の予約表に出ない');
    assert.ok(dec.includes('使用禁止'), '12月の予約表に出ない');
  });
});

test('[S-122] 同じコマの中で、止めた区画へは変更できない', async (t) => {
  await withSpec(t, async (env) => {
    const req = env.regReq({ date: D, preferSpace: '91' });
    const x = await env.register(req);
    await env.admin('api_admin_addBlock', { requestId: rid(), from: D, to: D, slots: ['S1'], spaces: ['93'], reason: '管理者が使う', memo: '', confirm: true });
    await env.admin('api_admin_change', { reservationId: x.reservationId, date: D, slotId: 'S1', preferSpace: '93', name: req.name, building: req.building, room: req.room, phone: req.phone, email: '' });
    assert.notDeepEqual(spaceOf(env, x.reservationId), ['93'], '止めた区画へ移った');
    assert.equal(spaceOf(env, x.reservationId).length, 1);
  });
});

test('[S-123] 保管の前でも、利用日が61日より前の予約は変更・取消しできない（日付で決まる）', async (t) => {
  await withSpec(t, { now: '2026-09-01T09:00:00+09:00' }, async (env) => {
    const req = env.regReq({ date: '2026-09-05' });
    const x = await env.register(req);
    env.host.setClock('2026-11-09T09:00:00+09:00'); // 保管のトリガーはまだ動いていない
    const c = await env.admin('api_admin_change', { reservationId: x.reservationId, date: '2026-11-20', slotId: 'S1', name: req.name, building: req.building, room: req.room, phone: req.phone, email: '' });
    assert.notEqual(c.status, 'CHANGED');
    const k = await env.admin('api_admin_cancel', { reservationId: x.reservationId, reason: '管理者の判断', requestId: rid() });
    assert.ok(!['OK', 'CANCELLED'].includes(k.status), JSON.stringify(k));
    assert.equal(env.resById(x.reservationId)['状態'], '確定');
    assert.equal(ymdOf(env.resById(x.reservationId)['利用日']), '2026-09-05');
  });
});

test('[S-151] 保管は使用禁止と操作履歴を移さない', async (t) => {
  await withSpec(t, { now: '2026-09-01T09:00:00+09:00' }, async (env) => {
    await env.register({ date: '2026-09-03', email: 'a@example.net' });
    await env.admin('api_admin_addBlock', { requestId: rid(), from: '2026-09-04', to: '2026-09-04', slots: ['S1'], spaces: ALL, reason: '行事', memo: '', confirm: true });
    await env.runTrigger('job_processNotifications');
    env.host.setClock('2026-11-09T03:00:00+09:00');
    const blocks = JSON.stringify(env.sheet('使用禁止'));
    const n = env.audit().length;
    await env.runTrigger('job_archiveLedger');
    assert.equal(JSON.stringify(env.sheet('使用禁止')), blocks);
    assert.ok(env.audit().length >= n + 1, '操作履歴が減った・保管が記録されない');
  });
});
