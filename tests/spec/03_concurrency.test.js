'use strict';
// C. 重複予約が起きないこと（同時の処理）。host.runConcurrently で一斉に走らせる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, ADMIN, ADMIN2, rid, ymdOf, slotOpen, RES_CAP, ADMIN_CAP } = require('./spec-env');
// D-040：管理者は1コマに全ての区画（3台）まで。住民は2台まで

const D = '2026-11-20';
const LAT = { latency: { min: 1, max: 6 } };
const c = (env, fn, args) => ({ fn, args, kind: 'client', user: null });
const regCall = (env, o, who = ADMIN) => c(env, 'api_admin_register', [env.auth(who), env.regReq(o)]);
const conc = async (env, calls) => (await env.host.runConcurrently(calls)).map(env.val);
const confirmed = (rs) => rs.filter((r) => r.status === 'CONFIRMED');

test('[S-030] 残り1台（管理者の3台目）へ管理者2人が同時に登録しても、1件だけ確定', async (t) => {
  for (let round = 0; round < 3; round++) {
    await withSpec(t, { ...LAT, seed: 100 + round }, async (env) => {
      await env.register({ date: D }); await env.register({ date: D });
      const rs = await conc(env, [regCall(env, { date: D }, ADMIN), regCall(env, { date: D }, ADMIN2)]);
      assert.equal(confirmed(rs).length, 1, JSON.stringify(rs));
      assert.equal(env.activeAllocs(D, 'S1').length, ADMIN_CAP);
    });
  }
});

test('[S-031] 空のコマへ管理者が5件同時に登録しても、確定は3件（全ての区画）', async (t) => {
  await withSpec(t, LAT, async (env) => {
    const rs = await conc(env, Array.from({ length: 5 }, () => regCall(env, { date: D, slotId: 'S4' })));
    assert.equal(confirmed(rs).length, ADMIN_CAP, JSON.stringify(rs.map((r) => r.status)));
    assert.equal(env.activeAllocs(D, 'S4').length, ADMIN_CAP);
    assert.deepEqual(env.activeAllocs(D, 'S4').map((a) => String(a['駐車場'])).sort(), ['91', '92', '93'], '同じ区画に重なった');
    // 断られた要求は、確定とは言わない（不成立か、混み合いの誤り）
    for (const r of rs.filter((x) => x.status !== 'CONFIRMED')) assert.ok(!r.reservationId || r.status === 'REJECTED', JSON.stringify(r));
  });
});

test('[S-032] 住民の申込み（開いたとき）と管理者の登録が同時でも、上限を超えない', async (t) => {
  await withSpec(t, { ...LAT, rules: { residentBooking: true } }, async (env) => {
    const calls = [];
    for (let i = 0; i < 3; i++) calls.push(c(env, 'api_submitReservation', [env.regReq({ date: D, slotId: 'S2' })]));
    for (let i = 0; i < 2; i++) calls.push(regCall(env, { date: D, slotId: 'S2' }));
    const rs = await conc(env, calls);
    // 住民の確定は2台まで。管理者は3台目まで入れる。管理者が断られるのは3台で埋まったときだけ
    const res = confirmed(rs.slice(0, 3)).length;
    const adm = confirmed(rs.slice(3)).length;
    const total = env.activeAllocs(D, 'S2').length;
    assert.equal(total, res + adm, JSON.stringify(rs.map((r) => r.status)));
    assert.ok(res <= RES_CAP, `住民が ${res} 件確定した（2台まで）`);
    assert.ok(total <= ADMIN_CAP);
    if (adm < 2) assert.equal(total, ADMIN_CAP, '空きがあるのに管理者の登録が断られた');
    // 住民の空き状況は×（2台以上入っている）
    assert.ok(!slotOpen((await env.avail(D, D)).days[0].slots.find((s) => s.slotId === 'S2')));
  });
});

test('[S-033] 取消しと新規の登録が同時でも、上限を超えず、取消し済みが枠を持たない', async (t) => {
  await withSpec(t, LAT, async (env) => {
    const a = await env.register({ date: D }); await env.register({ date: D }); await env.register({ date: D });
    const rs = await conc(env, [
      c(env, 'api_admin_cancel', [env.auth(ADMIN), { reservationId: a.reservationId, reason: '本人から電話', requestId: rid() }]),
      regCall(env, { date: D }, ADMIN2), regCall(env, { date: D }, ADMIN2),
    ]);
    assert.ok(confirmed(rs.slice(1)).length <= 1);
    assert.ok(env.activeAllocs(D, 'S1').length <= ADMIN_CAP);
    assert.equal(env.resById(a.reservationId)['状態'], '取消済み');
  });
});

test('[S-034] 使用禁止の登録と予約の登録が同時でも、禁止の後に予約が入らない', async (t) => {
  for (let round = 0; round < 3; round++) {
    await withSpec(t, { ...LAT, seed: 200 + round }, async (env) => {
      const blk = { requestId: rid(), from: D, to: D, slots: ['S3'], spaces: ['91', '92', '93'], reason: '工事・点検', memo: '', confirm: true };
      const rs = await conc(env, [
        regCall(env, { date: D, slotId: 'S3' }),
        c(env, 'api_admin_addBlock', [env.auth(ADMIN2), blk]),
        regCall(env, { date: D, slotId: 'S3' }),
      ]);
      assert.equal(rs[1].status, 'OK', JSON.stringify(rs[1]));
      // 操作履歴の順（ロックの順）で、使用禁止より後の登録が確定していないこと
      const au = env.audit();
      const bi = au.findIndex((x) => String(x['操作']).includes('使用禁止'));
      const after = au.slice(bi + 1).filter((x) => String(x['操作']).includes('登録')).map((x) => String(x['予約番号']));
      for (const id of after) {
        const r = env.resById(id);
        assert.notEqual(r && r['状態'], '確定', `使用禁止の後に確定した予約 ${id}`);
      }
      // 住民の空き状況は×
      const s = (await env.avail(D, D)).days[0].slots.find((x) => x.slotId === 'S3');
      assert.ok(!slotOpen(s));
    });
  }
});

async function twoRes(env) {
  const x = await env.register({ date: D, slotId: 'S1' });
  const y = await env.register({ date: D, slotId: 'S2' });
  await env.register({ date: '2026-11-21', slotId: 'S1' }); await env.register({ date: '2026-11-21', slotId: 'S1' }); // 変更先は管理者の残り1台
  return { x, y };
}
const chg = (env, id, o, who = ADMIN) => c(env, 'api_admin_change', [env.auth(who), { reservationId: id, date: '2026-11-21', slotId: 'S1', name: '変更 太郎', building: 'A棟', room: '301', phone: '090-0000-0001', email: '', ...o }]);

test('[S-035] 2件の変更が同じ残り1台へ同時でも、1件だけ移る', async (t) => {
  await withSpec(t, LAT, async (env) => {
    const { x, y } = await twoRes(env);
    const rs = await conc(env, [chg(env, x.reservationId, {}), chg(env, y.reservationId, {}, ADMIN2)]);
    assert.equal(rs.filter((r) => r.status === 'CHANGED').length, 1, JSON.stringify(rs));
    assert.equal(env.activeAllocs('2026-11-21', 'S1').length, ADMIN_CAP);
    const lost = rs[0].status === 'CHANGED' ? y : x;
    const lr = env.resById(lost.reservationId);
    assert.equal(lr['状態'], '確定');
    assert.equal(ymdOf(lr['利用日']), D, '移れなかった予約の日付が変わった');
  });
});

test('[S-036] 変更と新規の登録が同じ残り1台へ同時でも、上限を超えない', async (t) => {
  await withSpec(t, LAT, async (env) => {
    const { x } = await twoRes(env);
    const rs = await conc(env, [chg(env, x.reservationId, {}), regCall(env, { date: '2026-11-21', slotId: 'S1' }, ADMIN2)]);
    const ok = (rs[0].status === 'CHANGED' ? 1 : 0) + (rs[1].status === 'CONFIRMED' ? 1 : 0);
    assert.equal(ok, 1, JSON.stringify(rs));
    assert.equal(env.activeAllocs('2026-11-21', 'S1').length, ADMIN_CAP);
  });
});

test('[S-037] 同じ予約の変更と取消しが同時でも、取り消した予約が枠を持たない', async (t) => {
  for (let round = 0; round < 3; round++) {
    await withSpec(t, { ...LAT, seed: 300 + round }, async (env) => {
      const { x } = await twoRes(env);
      await conc(env, [
        chg(env, x.reservationId, { date: '2026-11-22', slotId: 'S3' }),
        c(env, 'api_admin_cancel', [env.auth(ADMIN2), { reservationId: x.reservationId, reason: '本人から電話', requestId: rid() }]),
      ]);
      const r = env.resById(x.reservationId);
      const mine = env.allocations().filter((a) => String(a['予約番号']) === String(x.reservationId) && a['状態'] === '有効');
      if (r['状態'] === '取消済み') assert.equal(mine.length, 0);
      else assert.equal(mine.length, 1);
    });
  }
});

test('[S-038] 同じ受付要求IDの登録を同時に3回送っても、予約は1件', async (t) => {
  await withSpec(t, LAT, async (env) => {
    const req = env.regReq({ date: D, slotId: 'S3' });
    const rs = await conc(env, [0, 1, 2].map(() => c(env, 'api_admin_register', [env.auth(ADMIN), req])));
    const rows = env.reservations().filter((r) => r['受付要求ID'] === req.requestId);
    assert.equal(rows.length, 1);
    const ids = new Set(confirmed(rs).map((r) => r.reservationId));
    assert.ok(ids.size <= 1, JSON.stringify(rs));
    assert.equal(env.activeAllocs(D, 'S3').length, 1);
  });
});

test('[S-039] ロックが取れないときは、書かずに断る（成功と言わない）', async (t) => {
  await withSpec(t, async (env) => {
    env.host.setFaults({ lock: { mode: 'timeout' } });
    const req = env.regReq({ date: D });
    const r = env.val(await env.raw('api_admin_register', [env.auth(ADMIN), req]));
    assert.notEqual(r.status, 'CONFIRMED');
    assert.equal(env.activeAllocs(D).length, 0);
    assert.equal(env.reservations().filter((x) => x['状態'] === '確定').length, 0);
    env.host.clearFaults();
    const r2 = env.val(await env.raw('api_admin_register', [env.auth(ADMIN), req]));
    assert.equal(r2.status, 'CONFIRMED');
    assert.equal(env.reservations().filter((x) => x['受付要求ID'] === req.requestId && x['状態'] === '確定').length, 1);
  });
});

test('[S-040] 使用禁止の解除と、その枠への登録が同時でも、上限を超えない', async (t) => {
  await withSpec(t, LAT, async (env) => {
    const b = await env.admin('api_admin_addBlock', { requestId: rid(), from: D, to: D, slots: ['S4'], spaces: ['91', '92', '93'], reason: '行事', memo: '', confirm: true });
    assert.equal(b.status, 'OK');
    const rs = await conc(env, [
      c(env, 'api_admin_releaseBlock', [env.auth(ADMIN2), { blockId: b.blockId }]),
      regCall(env, { date: D, slotId: 'S4' }), regCall(env, { date: D, slotId: 'S4' }), regCall(env, { date: D, slotId: 'S4' }), regCall(env, { date: D, slotId: 'S4' }),
    ]);
    assert.ok(confirmed(rs).length <= ADMIN_CAP);
    assert.ok(env.activeAllocs(D, 'S4').length <= ADMIN_CAP);
  });
});

test('[S-041] 保管（トリガー）と登録が同時でも、予約が消えない・二重にならない', async (t) => {
  await withSpec(t, { ...LAT, now: '2026-09-01T09:00:00+09:00' }, async (env) => {
    const old = [];
    for (let i = 0; i < 4; i++) {
      const r = await env.register({ date: `2026-09-0${2 + i}`, slotId: 'S1', email: `o${i}@example.net` });
      old.push(r.reservationId);
    }
    await env.runTrigger('job_processNotifications');
    env.host.setClock('2026-11-09T03:00:00+09:00');
    const rs = await env.host.runConcurrently([
      { fn: 'job_archiveLedger', args: [{ triggerUid: 'x', authMode: 'FULL' }], kind: 'trigger' },
      regCall(env, { date: D }), regCall(env, { date: D, slotId: 'S2' }),
    ]);
    const vals = rs.map(env.val);
    const ids = [...env.reservations(), ...(env.sheet('予約（保管）') || [])].map((r) => String(r['予約番号']));
    for (const id of old) assert.equal(ids.filter((x) => x === id).length, 1, `予約 ${id} が ${ids.filter((x) => x === id).length} 件`);
    for (const v of vals.slice(1)) {
      assert.equal(v.status, 'CONFIRMED');
      assert.equal(ids.filter((x) => x === String(v.reservationId)).length, 1);
    }
  });
});
