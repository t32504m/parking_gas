'use strict';
// G. 使用禁止（D-016, D-021, D-011）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, rid, addDays, TODAY, slotOpen } = require('./spec-env');

const D = '2026-11-20';
const ALL = ['91', '92', '93'];
const block = (env, o) => env.admin('api_admin_addBlock', { requestId: rid(), from: D, to: D, slots: ['S1'], spaces: ALL, reason: '工事・点検', memo: '', confirm: true, ...o });
async function slot(env, date, id) { return (await env.avail(date, date)).days[0].slots.find((s) => s.slotId === id); }
const open = slotOpen;
async function aslot(env, date, id) { return (await env.adminAvail(date, date)).days[0].slots.find((s) => s.slotId === id); }
const spaceOf = (env, id) => env.allocations().filter((a) => String(a['予約番号']) === String(id) && a['状態'] === '有効').map((a) => String(a['駐車場']));

test('[S-090] 全区画を止めたコマは、住民に×、管理者の登録は断る', async (t) => {
  await withSpec(t, async (env) => {
    assert.equal((await block(env, {})).status, 'OK');
    assert.ok(!open(await slot(env, D, 'S1')));
    assert.notEqual((await env.register({ date: D })).status, 'CONFIRMED');
    assert.equal(env.activeAllocs(D, 'S1').length, 0);
    assert.ok(open(await slot(env, D, 'S2')), '止めていないコマまで止まった');
  });
});

test('[S-091] 91・92を止めると93の1台だけ', async (t) => {
  await withSpec(t, async (env) => {
    await block(env, { spaces: ['91', '92'] });
    const s = await slot(env, D, 'S1');
    assert.ok(open(s));
    assert.equal((await aslot(env, D, 'S1')).remaining, 1);
    const r = await env.register({ date: D });
    assert.equal(r.status, 'CONFIRMED');
    assert.deepEqual(spaceOf(env, r.reservationId), ['93']);
    assert.notEqual((await env.register({ date: D })).status, 'CONFIRMED');
    assert.ok(!open(await slot(env, D, 'S1')));
  });
});

test('[S-092] 「管理者が使う」で93を止めても、91・92が空いていれば住民の分は2台', async (t) => {
  await withSpec(t, async (env) => {
    await block(env, { spaces: ['93'], reason: '管理者が使う' });
    assert.ok(open(await slot(env, D, 'S1')));
    assert.equal((await aslot(env, D, 'S1')).remaining, 2);
    const a = await env.register({ date: D }); const b = await env.register({ date: D });
    assert.equal(a.status, 'CONFIRMED'); assert.equal(b.status, 'CONFIRMED');
    assert.deepEqual([...spaceOf(env, a.reservationId), ...spaceOf(env, b.reservationId)].sort(), ['91', '92']);
  });
});

test('[S-093] 期間×時間帯×区画で止まり、範囲の外は止まらない', async (t) => {
  await withSpec(t, async (env) => {
    assert.equal((await block(env, { from: '2026-11-20', to: '2026-11-22', slots: ['S1', 'S4'] })).status, 'OK');
    for (const [date, id] of [['2026-11-20', 'S1'], ['2026-11-21', 'S4'], ['2026-11-22', 'S4'], ['2026-11-22', 'S1']]) {
      assert.notEqual((await env.register({ date, slotId: id })).status, 'CONFIRMED', `${date} ${id} が止まっていない`);
    }
    for (const [date, id] of [['2026-11-19', 'S1'], ['2026-11-19', 'S4'], ['2026-11-23', 'S1'], ['2026-11-21', 'S2'], ['2026-11-21', 'S3']]) {
      assert.equal((await env.register({ date, slotId: id })).status, 'CONFIRMED', `${date} ${id} まで止まった`);
    }
  });
});

test('[S-094] 予約がある枠を止めても、予約は自動で取り消さない。重なる予約を示す', async (t) => {
  await withSpec(t, async (env) => {
    const r = await env.register({ date: D });
    const pv = await block(env, { confirm: false });
    assert.equal(pv.status, 'PREVIEW');
    assert.ok(JSON.stringify(pv.conflicts).includes(String(r.reservationId)), '重なる予約が示されない');
    assert.equal(env.sheet('使用禁止').length, 0, '確かめる段階で使用禁止が書かれた');
    assert.equal((await block(env, {})).status, 'OK');
    assert.equal(env.resById(r.reservationId)['状態'], '確定');
    assert.equal(spaceOf(env, r.reservationId).length, 1);
  });
});

test('[S-095] 解除すると、また登録できる', async (t) => {
  await withSpec(t, async (env) => {
    const b = await block(env, {});
    const b2 = await block(env, { slots: ['S2'] });
    const rel = await env.admin('api_admin_releaseBlock', { blockId: b.blockId });
    assert.equal(rel.status, 'OK', JSON.stringify(rel));
    assert.equal((await env.register({ date: D })).status, 'CONFIRMED');
    assert.notEqual((await env.register({ date: D, slotId: 'S2' })).status, 'CONFIRMED', '別に登録した使用禁止まで解除された');
    const list = await env.admin('api_admin_blockList', {});
    assert.deepEqual(list.blocks.map((x) => x.blockId), [b2.blockId]);
    // 2回目の解除は何も変えない
    const again = await env.admin('api_admin_releaseBlock', { blockId: b.blockId });
    assert.ok(again.status !== 'ERROR', JSON.stringify(again));
  });
});

test('[S-096] 使用禁止の登録と解除が操作履歴に残る', async (t) => {
  await withSpec(t, async (env) => {
    const b = await block(env, { memo: '点検' });
    await env.admin('api_admin_releaseBlock', { blockId: b.blockId });
    const ops = env.audit().map((x) => String(x['操作']));
    assert.ok(ops.some((o) => o.includes('使用禁止')));
    assert.ok(ops.some((o) => o.includes('解除')));
  });
});

test('[S-097] 過ぎた期間は新しく止められない', async (t) => {
  await withSpec(t, async (env) => {
    const r = await block(env, { from: addDays(TODAY, -3), to: addDays(TODAY, -1) });
    assert.notEqual(r.status, 'OK');
    assert.equal(env.sheet('使用禁止').length, 0);
  });
});

test('[S-098] 2台入ったコマの残りの区画を「管理者が使う」で止められる', async (t) => {
  await withSpec(t, async (env) => {
    const a = await env.register({ date: D }); const b = await env.register({ date: D });
    const used = [...spaceOf(env, a.reservationId), ...spaceOf(env, b.reservationId)];
    const free = ALL.filter((x) => !used.includes(x));
    assert.equal(free.length, 1);
    assert.equal((await block(env, { spaces: free, reason: '管理者が使う' })).status, 'OK');
  });
});

test('[S-099] 止めた区画を指定して登録しても、その区画に入らない', async (t) => {
  await withSpec(t, async (env) => {
    await block(env, { spaces: ['91'] });
    const r = await env.register({ date: D, preferSpace: '91' });
    if (r.status === 'CONFIRMED') assert.notDeepEqual(spaceOf(env, r.reservationId), ['91']);
    // 空いている区画の指定は、その区画に入る（D-011）
    const r2 = await env.register({ date: D, slotId: 'S2', preferSpace: '93' });
    assert.deepEqual(spaceOf(env, r2.reservationId), ['93']);
  });
});

test('[S-100] 使用禁止の入力の誤り（逆の期間・無い区画・無い時間帯・空の区画）は断る', async (t) => {
  await withSpec(t, async (env) => {
    for (const o of [{ from: '2026-11-22', to: '2026-11-20' }, { spaces: ['94'] }, { slots: ['S9'] }, { spaces: [] }, { slots: [] }, { from: '2026-02-30', to: '2026-02-30' }, { reason: '' }]) {
      const r = await block(env, o);
      assert.notEqual(r.status, 'OK', `${JSON.stringify(o)} が通った`);
    }
    assert.equal(env.sheet('使用禁止').length, 0);
  });
});
