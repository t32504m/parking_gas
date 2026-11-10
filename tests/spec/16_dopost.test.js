'use strict';
// 外に置いた住民の画面から呼ぶ doPost（D-034）
//  本文は {"fn": 名前, "arg": 引数} の JSON。通すのは config と住民向けの4つだけ。ほかの名前・壊れた本文は {"status":"DENIED"}
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, rid, PEOPLE, ADMIN, CONTRACT, pii, leaks, hasDate } = require('./spec-env');

const D = '2026-11-20';
const RESIDENT = ['api_getAvailability', 'api_submitReservation', 'api_getRequestStatus', 'api_lookupReservation'];

async function postRaw(env, e) {
  const r = await env.host.run('doPost', [e], { kind: 'client', user: null });
  return r;
}
async function post(env, contents) {
  const r = await postRaw(env, { postData: { contents, type: 'text/plain' }, parameter: {} });
  assert.ok(r.ok, `doPost が例外: ${JSON.stringify(r.error)}`);
  const txt = String(r.value && r.value.content);
  let j;
  try { j = JSON.parse(txt); } catch (e) { assert.fail(`doPost の応答が JSON でない: ${txt.slice(0, 200)}`); }
  return j;
}
const call = (env, fn, arg) => post(env, JSON.stringify({ fn, arg }));
/** 台帳の全てのシートの中身（変わっていないことを確かめる） */
function snapshot(env) {
  return JSON.stringify(env.sheetNames().map((n) => [n, env.grid(n)]));
}

test('[S-074] doPost から、管理者・運用・内部の関数は動かない（DENIED。台帳もメールも変わらない）', async (t) => {
  await withSpec(t, async (env) => {
    const r = await env.register({ date: D, person: PEOPLE[0], email: 'p0@example.net' });
    const before = snapshot(env);
    const mail0 = env.host.outbox.length;
    const names = Object.keys(CONTRACT.surface.functions).filter((f) => !RESIDENT.includes(f));
    names.push('testSeed_', 'testSeed_all', 'residentApi_', 'residentConfig_', 'book_', 'archiveLedger_', 'api_admin_unknown',
      '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'eval', 'Function', 'globalThis', 'this', '', ' config', 'CONFIG', 'api_getAvailability ');
    const auth = { email: ADMIN.email, secret: ADMIN.secret };
    const args = [
      undefined, null, auth, [auth],
      { ...auth, reservationId: r.reservationId, reason: '試験', requestId: rid() },
      [auth, { reservationId: r.reservationId, reason: '試験', requestId: rid() }],
      [auth, { month: '2026-11' }],
    ];
    for (const fn of names) {
      for (const arg of args) {
        const j = await call(env, fn, arg);
        assert.deepEqual(j, { status: 'DENIED' }, `fn=${JSON.stringify(fn)} arg=${JSON.stringify(arg)} → ${JSON.stringify(j).slice(0, 200)}`);
      }
    }
    assert.equal(snapshot(env), before, 'doPost からの呼び出しで台帳が変わった');
    assert.equal(env.host.outbox.length, mail0, 'doPost からの呼び出しでメールが送られた');
    assert.equal(env.resById(r.reservationId)['状態'], '確定');
  });
});

test('[S-075] 壊れた本文・形の違う本文は DENIED（例外にならず、台帳は変わらない）', async (t) => {
  await withSpec(t, async (env) => {
    await env.register({ date: D });
    const before = snapshot(env);
    const bodies = ['', 'xx', 'null', '[]', '1', '"config"', '{', '{"fn":1}', '{"fn":null}', '{"fn":["config"]}', '{"arg":{}}',
      '{"fn":{"toString":"config"}}', JSON.stringify({ fn: 'config'.padEnd(5000, 'x') }), 'fn=config', '<script>alert(1)</script>'];
    for (const b of bodies) {
      const j = await post(env, b);
      assert.deepEqual(j, { status: 'DENIED' }, `本文 ${b.slice(0, 40)} → ${JSON.stringify(j).slice(0, 200)}`);
    }
    // postData が無い・e が無い
    for (const e of [{}, { parameter: { fn: 'config' } }, { postData: null }]) {
      const r = await postRaw(env, e);
      assert.ok(r.ok, `doPost(${JSON.stringify(e)}) が例外: ${JSON.stringify(r.error)}`);
      assert.deepEqual(JSON.parse(String(r.value.content)), { status: 'DENIED' });
    }
    assert.equal(snapshot(env), before);
  });
});

test('[S-076] doPost の住民向けの4つは、直接の呼び出しと同じ結果・同じ決まりになる', async (t) => {
  await withSpec(t, async (env) => {
    await env.register({ date: D, slotId: 'S2' });
    await env.register({ date: D, slotId: 'S2' });
    const q = { from: '2026-11-14', to: '2026-12-31' };
    assert.deepEqual(await call(env, 'api_getAvailability', q), await env.avail(q.from, q.to));
    // 住民の予約は既定で閉じている。doPost から申し込んでも確定しない
    const req = env.regReq({ date: D, slotId: 'S1', channel: undefined });
    const s = await call(env, 'api_submitReservation', req);
    assert.notEqual(s.status, 'CONFIRMED', JSON.stringify(s));
    assert.equal(env.activeAllocs(D, 'S1').length, 0);
    // 住民の範囲（今日+5日〜2か月先）の外は、doPost でも直接と同じ
    const out = { from: '2026-11-09', to: '2026-11-13' };
    assert.deepEqual(await call(env, 'api_getAvailability', out), await env.avail(out.from, out.to));
    // 予約の確認は既定で閉じている
    assert.deepEqual(await call(env, 'api_lookupReservation', { reservationId: '1', phoneTail: '0000' }), await env.pub('api_lookupReservation', { reservationId: '1', phoneTail: '0000' }));
  });
});

test('[S-077] doPost から住民の予約（開いた設定）を送り直しても二重にならない。満車は確定しない', async (t) => {
  await withSpec(t, { rules: { residentBooking: true, residentLeadDays: 0 } }, async (env) => {
    const req = env.regReq({ date: D, slotId: 'S3', channel: undefined });
    const a = await call(env, 'api_submitReservation', req);
    assert.equal(a.status, 'CONFIRMED', JSON.stringify(a));
    const b = await call(env, 'api_submitReservation', req);
    assert.equal(b.status, 'CONFIRMED');
    assert.equal(env.reservations().filter((x) => x['受付要求ID'] === req.requestId).length, 1, '送り直しで二重になった');
    assert.equal((await call(env, 'api_getRequestStatus', { requestId: req.requestId })).status, 'CONFIRMED');
    await env.register({ date: D, slotId: 'S3' });
    const c = await call(env, 'api_submitReservation', env.regReq({ date: D, slotId: 'S3', channel: undefined }));
    assert.notEqual(c.status, 'CONFIRMED', '満車なのに確定した');
    assert.ok(env.activeAllocs(D, 'S3').length <= 2);
  });
});

test('[S-078] config は画面の設定だけを返す（台帳・秘密・管理者の情報が無い）', async (t) => {
  await withSpec(t, async (env) => {
    const ps = PEOPLE.slice(0, 3);
    for (const p of ps) await env.register({ date: D, person: p, email: 'c@example.net' });
    const c = await call(env, 'config', null);
    assert.equal(c.status, 'OK');
    const allowed = ['today', 'viewFrom', 'contact', 'hours', 'terms', 'version', 'status'];
    assert.deepEqual(Object.keys(c).filter((k) => !allowed.includes(k)), [], `config に余計な項目: ${Object.keys(c)}`);
    assert.equal(c.today, '2026-11-09');
    assert.equal(c.viewFrom, '2026-11-14');
    const secrets = [env.ssId, ADMIN.email, ADMIN.secret, 'kanri2@example.org', 'spec-pass-2222', 'c@example.net'].concat(pii(ps));
    assert.deepEqual(leaks(c, secrets), [], 'config に秘密・個人情報がある');
    // arg に何を入れても同じ
    assert.deepEqual(await call(env, 'config', { email: ADMIN.email, secret: ADMIN.secret }), c);
  });
});

test('[S-079] doPost の応答は JSON の文字で、日付の型（Date）を含まない', async (t) => {
  await withSpec(t, async (env) => {
    await env.register({ date: D });
    const r = await postRaw(env, { postData: { contents: JSON.stringify({ fn: 'api_getAvailability', arg: { from: D, to: D } }), type: 'text/plain' }, parameter: {} });
    assert.ok(r.ok);
    assert.equal(String(r.value.mime).toUpperCase(), 'JSON', `mime ${r.value.mime}`);
    const j = JSON.parse(String(r.value.content));
    assert.ok(!hasDate(j));
    assert.equal(j.status, 'OK');
  });
});
