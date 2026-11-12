'use strict';
// 外に置いた画面から呼ぶ doPost（D-034、D-035 で変更）
//  本文は {"fn": 名前, "args": [引数, …]} の JSON（前の {"fn","arg"} も受ける）。
//  通すのは config・住民向けの4つ・管理者の api_admin_* の14個。管理者の関数は、正しい印（args[0] に {token}）があるときだけ動く。
//  setup_*・job_*・testSeed_*・_ で終わる関数・doGet・doPost・constructor など、ほかの名前と壊れた本文は {"status":"DENIED"}
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, rid, PEOPLE, ADMIN, ADMIN2, CONTRACT, pii, leaks, hasDate } = require('./spec-env');

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
const callArgs = (env, fn, args) => post(env, JSON.stringify({ fn, args }));
const ADMIN_FNS = ['api_admin_login', 'api_admin_availability', 'api_admin_week', 'api_admin_register', 'api_admin_list', 'api_admin_cancel', 'api_admin_change',
  'api_admin_callList', 'api_admin_markCalled', 'api_admin_addBlock', 'api_admin_releaseBlock', 'api_admin_blockList', 'api_admin_monthTable', 'api_admin_exportMonth'];
const OK_STATES = ['OK', 'CONFIRMED', 'CHANGED', 'PREVIEW', 'CANCELLED'];
/** 操作履歴を除いた台帳（失敗した確認を操作履歴に残すのは構わない） */
function ledgerSnap(env) { return JSON.stringify(env.sheetNames().filter((n) => n !== '操作履歴').map((n) => [n, env.grid(n)])); }
async function loginPost(env, who = ADMIN) { return callArgs(env, 'api_admin_login', [{ email: who.email, secret: who.secret }]); }
/** 管理者の13個の関数の、2つ目の引数（予約・使用禁止は env の中に用意する） */
async function adminCalls(env) {
  const a = await env.register({ date: D, person: PEOPLE[3], email: 'secret-mail@example.net' });
  const b = await env.admin('api_admin_addBlock', { requestId: rid(), from: D, to: D, slots: ['S4'], spaces: ['93'], reason: '工事・点検', memo: 'メモ', confirm: true });
  const id = a.reservationId;
  return {
    api_admin_availability: { from: D, to: D },
    api_admin_week: { from: D, to: '2026-11-26' },
    api_admin_register: env.regReq({ date: D, slotId: 'S2' }),
    api_admin_list: { from: D, to: D },
    api_admin_cancel: { reservationId: id, reason: '管理者の判断', requestId: rid() },
    api_admin_change: { reservationId: id, date: '2026-11-21', slotId: 'S3', name: 'x', building: '', room: '1', phone: '0', email: '' },
    api_admin_callList: undefined,
    api_admin_markCalled: { reservationId: id },
    api_admin_addBlock: { requestId: rid(), from: D, to: D, slots: ['S1'], spaces: ['91', '92', '93'], reason: '行事', memo: '', confirm: true },
    api_admin_releaseBlock: { blockId: b.blockId },
    api_admin_blockList: {},
    api_admin_monthTable: { month: '2026-11' },
    api_admin_exportMonth: { month: '2026-11' },
  };
}
/** 台帳の全てのシートの中身（変わっていないことを確かめる） */
function snapshot(env) {
  return JSON.stringify(env.sheetNames().map((n) => [n, env.grid(n)]));
}

test('[S-074] doPost から、運用・内部の関数とほかの名前は動かない。正しい管理者の印があっても DENIED（台帳もメールも変わらない）', async (t) => {
  await withSpec(t, async (env) => {
    const r = await env.register({ date: D, person: PEOPLE[0], email: 'p0@example.net' });
    const lg = await loginPost(env);
    assert.equal(lg.status, 'OK', JSON.stringify(lg));
    const before = snapshot(env);
    const mail0 = env.host.outbox.length;
    const allowed = RESIDENT.concat(ADMIN_FNS);
    const names = Object.keys(CONTRACT.surface.functions).filter((f) => !allowed.includes(f));
    names.push('testSeed_', 'testSeed_all', 'webApi_', 'residentApi_', 'residentConfig_', 'asAdmin_', 'adminOf_', 'book_', 'archiveLedger_', 'adminCancel_',
      'api_admin_unknown', 'api_admin_', 'api_admin_login_', 'API_ADMIN_LIST', ' api_admin_list',
      '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'eval', 'Function', 'globalThis', 'this', '', ' config', 'CONFIG', 'api_getAvailability ');
    for (const n of ['setup_init', 'setup_run', 'job_processNotifications', 'job_archiveLedger', 'doGet', 'doPost']) assert.ok(names.includes(n), `${n} が試験の名前に無い`);
    const tok = { token: lg.token };
    const auth = { email: ADMIN.email, secret: ADMIN.secret };
    const argsList = [
      [], [null], [tok], [auth], [tok, {}], [auth, {}],
      [tok, { reservationId: r.reservationId, reason: '試験', requestId: rid() }],
      [tok, { month: '2026-11' }],
      [{ token: lg.token }, [ADMIN, ADMIN2]],
    ];
    for (const fn of names) {
      for (const args of argsList) {
        const j = await callArgs(env, fn, args);
        assert.deepEqual(j, { status: 'DENIED' }, `fn=${JSON.stringify(fn)} args=${JSON.stringify(args).slice(0, 80)} → ${JSON.stringify(j).slice(0, 200)}`);
      }
      const j = await call(env, fn, tok);
      assert.deepEqual(j, { status: 'DENIED' }, `fn=${JSON.stringify(fn)}（arg の形）→ ${JSON.stringify(j).slice(0, 200)}`);
    }
    assert.equal(snapshot(env), before, 'doPost からの呼び出しで台帳が変わった');
    assert.equal(env.host.outbox.length, mail0, 'doPost からの呼び出しでメールが送られた');
    assert.equal(env.resById(r.reservationId)['状態'], '確定');
  });
});

test('[S-230] doPost の管理者の関数は、印が無い・偽・期限切れ・置き場所違いでは動かず DENIED。台帳もメールも変わらず、個人情報を返さない', async (t) => {
  await withSpec(t, async (env) => {
    const calls = await adminCalls(env);
    const lg = await loginPost(env);
    assert.equal(lg.status, 'OK');
    const expiredTok = { token: lg.token };
    env.host.advanceClock(6 * 3600 * 1000 + 60 * 1000); // 6時間を過ぎた印
    const before = ledgerSnap(env);
    const mail0 = env.host.outbox.length;
    const needles = pii([PEOPLE[3]]).concat(['secret-mail@example.net', 'メモ']);
    const fresh = (await loginPost(env)).token;
    const creds = [
      ['印なし（引数なし）', 'NONE'], ['空', {}], ['null', null],
      ['偽の印', { token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }],
      ['空の印', { token: '' }],
      ['印が文字でない', { token: { a: 1 } }],
      ['期限切れの印', expiredTok],
      ['パスコード違い', { email: ADMIN.email, secret: 'wrong-pass-0000' }],
      ['正しい印を2つ目に置く', 'SECOND'],
    ];
    for (const [fn, q] of Object.entries(calls)) {
      for (const [label, cr] of creds) {
        let args;
        if (cr === 'NONE') args = [];
        else if (cr === 'SECOND') args = [q === undefined ? {} : q, { token: fresh }];
        else args = q === undefined ? [cr] : [cr, q];
        const j = await callArgs(env, fn, args);
        assert.equal(j.status, 'DENIED', `${fn}（${label}）が ${JSON.stringify(j).slice(0, 160)}`);
        assert.deepEqual(leaks(j, needles), [], `${fn}（${label}）が個人情報を返した`);
      }
      // 前の形 {"fn","arg"} で、印を入れずに2つ目の引数だけを送る
      if (q !== undefined) {
        const j = await call(env, fn, q);
        assert.ok(!OK_STATES.includes(j.status), `${fn}（arg に印なし）が ${j.status}`);
      }
    }
    const bad = await callArgs(env, 'api_admin_login', [{ email: ADMIN.email, secret: 'wrong-pass-0000' }]);
    assert.notEqual(bad.status, 'OK'); assert.ok(!bad.token, 'パスコード違いのログインが印を返した');
    assert.equal(ledgerSnap(env), before, '印の無い・偽の・期限切れの呼び出しで台帳が変わった');
    assert.equal(env.host.outbox.length, mail0, '印の無い呼び出しでメールが送られた');
  });
});

test('[S-231] doPost の管理者の関数は、正しい印で google.script.run と同じ結果になり、台帳と操作履歴に同じように残る', async (t) => {
  await withSpec(t, async (env) => {
    const lg = await loginPost(env);
    assert.equal(lg.status, 'OK'); assert.ok(lg.token);
    const tok = { token: lg.token };
    const req = env.regReq({ date: D, slotId: 'S2', person: PEOPLE[5] });
    const r = await callArgs(env, 'api_admin_register', [tok, req]);
    assert.equal(r.status, 'CONFIRMED', JSON.stringify(r));
    assert.equal((await callArgs(env, 'api_admin_register', [tok, req])).status, 'CONFIRMED');
    assert.equal(env.reservations().filter((x) => x['受付要求ID'] === req.requestId).length, 1, '送り直しで二重になった');
    assert.equal(env.resById(r.reservationId)['氏名'], PEOPLE[5].name);
    for (const [fn, q] of [['api_admin_list', { from: D, to: D }], ['api_admin_availability', { from: D, to: '2026-11-26' }], ['api_admin_week', { from: D, to: '2026-11-26' }],
      ['api_admin_monthTable', { month: '2026-11' }], ['api_admin_blockList', {}], ['api_admin_callList', undefined]]) {
      const args = q === undefined ? [tok] : [tok, q];
      assert.deepEqual(await callArgs(env, fn, args), env.val(await env.raw(fn, args)), `${fn} の結果が直接の呼び出しと違う`);
    }
    // 前の形 {"fn","arg"} は、arg を1つ目の引数にする
    assert.equal((await call(env, 'api_admin_callList', tok)).status, 'OK');
    const ch = await callArgs(env, 'api_admin_change', [tok, { reservationId: r.reservationId, date: '2026-11-21', slotId: 'S3', name: req.name, building: req.building, room: req.room, phone: req.phone, email: '' }]);
    assert.equal(ch.status, 'CHANGED', JSON.stringify(ch));
    assert.equal(env.activeAllocs('2026-11-21', 'S3').length, 1);
    assert.equal(env.activeAllocs(D, 'S2').length, 0);
    const blk = { from: '2026-11-22', to: '2026-11-22', slots: ['S1'], spaces: ['91'], reason: '行事', memo: '' };
    assert.equal((await callArgs(env, 'api_admin_addBlock', [tok, { requestId: rid(), ...blk, confirm: false }])).status, 'PREVIEW');
    const bk = await callArgs(env, 'api_admin_addBlock', [tok, { requestId: rid(), ...blk, confirm: true }]);
    assert.equal(bk.status, 'OK', JSON.stringify(bk));
    assert.equal((await callArgs(env, 'api_admin_releaseBlock', [tok, { blockId: bk.blockId }])).status, 'OK');
    const cx = await callArgs(env, 'api_admin_cancel', [tok, { reservationId: r.reservationId, reason: '本人から電話', requestId: rid() }]);
    assert.ok(['OK', 'CANCELLED'].includes(cx.status), JSON.stringify(cx));
    assert.notEqual(env.resById(r.reservationId)['状態'], '確定');
    const mine = env.audit().filter((x) => String(x['予約番号']) === String(r.reservationId));
    const ops = mine.map((x) => String(x['操作'])).join('|');
    for (const w of ['登録', '変更', '取']) assert.ok(ops.includes(w), `操作履歴に「${w}」が無い: ${ops}`);
    assert.ok(mine.every((x) => JSON.stringify(x).includes(ADMIN.email) || JSON.stringify(x).includes(ADMIN.name)), '操作履歴に操作した管理者が無い');
    assert.ok(env.audit().some((x) => String(x['操作']).includes('使用禁止')), '使用禁止が操作履歴に無い');
    assert.equal((await callArgs(env, 'api_admin_exportMonth', [tok, { month: '2026-11' }])).status, 'OK');
  });
});

test('[S-232] 締め出しを入れた設定（adminLockout: true）では、doPost のログインでも5回続けて間違えると15分止まる（直接の呼び出しと回数を共にする）', async (t) => {
  await withSpec(t, { rules: { adminLockout: true } }, async (env) => {
    for (let i = 0; i < 3; i++) assert.notEqual((await callArgs(env, 'api_admin_login', [{ email: ADMIN.email, secret: `bad-${i}-xxxx` }])).status, 'OK');
    for (let i = 3; i < 5; i++) assert.notEqual((await env.pub('api_admin_login', { email: ADMIN.email, secret: `bad-${i}-xxxx` })).status, 'OK');
    const r = await loginPost(env);
    assert.notEqual(r.status, 'OK', '止まっている間に doPost で入れた');
    assert.ok(!r.token);
    assert.equal(r.reason, 'LOCKED');
    assert.equal((await env.pub('api_admin_login', { email: ADMIN.email, secret: ADMIN.secret })).reason, 'LOCKED');
    const l = await callArgs(env, 'api_admin_list', [{ email: ADMIN.email, secret: ADMIN.secret }, { from: D, to: D }]);
    assert.ok(!OK_STATES.includes(l.status), `止まっている間に、パスコードを付けた doPost の呼び出しが通った: ${l.status}`);
    assert.equal((await loginPost(env, ADMIN2)).status, 'OK', '別の管理者まで止まった');
    env.host.advanceClock(15 * 60 * 1000 + 1000);
    assert.equal((await loginPost(env)).status, 'OK');
  });
});

test('[S-235] 既定（締め出しを止めた設定）では、doPost と直接で合わせて何回間違えても止まらず、正しいパスコードで入れる', async (t) => {
  await withSpec(t, async (env) => {
    for (let i = 0; i < 4; i++) assert.notEqual((await callArgs(env, 'api_admin_login', [{ email: ADMIN.email, secret: `bad-${i}-xxxx` }])).status, 'OK');
    for (let i = 4; i < 8; i++) assert.notEqual((await env.pub('api_admin_login', { email: ADMIN.email, secret: `bad-${i}-xxxx` })).status, 'OK');
    const r = await loginPost(env);
    assert.equal(r.status, 'OK', `間違えた後に doPost で入れない: ${JSON.stringify(r)}`);
    assert.ok(r.token);
    const l = await callArgs(env, 'api_admin_list', [{ token: r.token }, { from: D, to: D }]);
    assert.equal(l.status, 'OK');
    // 間違えたパスコードと偽の印は、止めない設定でも DENIED のまま（S-230 と同じ）
    assert.equal((await callArgs(env, 'api_admin_list', [{ email: ADMIN.email, secret: 'wrong-pass-0000' }, { from: D, to: D }])).status, 'DENIED');
  });
});

test('[S-233] 本文の新しい形 {"fn","args"} と前の形 {"fn","arg"} は、同じ結果になる', async (t) => {
  await withSpec(t, async (env) => {
    await env.register({ date: D, slotId: 'S1' });
    const q = { from: '2026-11-14', to: '2026-11-30' };
    const a = await callArgs(env, 'api_getAvailability', [q]);
    assert.equal(a.status, 'OK');
    assert.deepEqual(await call(env, 'api_getAvailability', q), a);
    assert.deepEqual(await env.avail(q.from, q.to), a);
    assert.deepEqual(await callArgs(env, 'config', []), await call(env, 'config', null));
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
