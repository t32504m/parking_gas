'use strict';
// 侵入試験 面C（追加）：画面を GAS の外（Cloudflare Pages など）に置いたことで増えた入口 doPost。
// D-035（案 A+）で、住民だけでなく管理者の画面も外に置き、doPost が管理者の関数も通すようになった。
// 本文は {"fn": 名前, "args": [引数, …]}（前の {"fn","arg"} も受ける。Content-Type は text/plain、クッキー無し）。
// src/Web.gs の webApi_ が、住民の4つ・config・api_admin_* の14個だけを switch で1つずつ呼ぶ。ほかは DENIED。
// 管理者の関数は、中で adminOf_ が印（トークン、または email＋パスコード）を確かめる＝google.script.run と同じ守り。
// エミュレータには ContentService があるので doPost を直接呼べる。未ログインの人として kind:'doGet' で呼ぶ。
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, R, ADMIN, v, call, adminAuth, snapshot, internalLeaks, allPii, digests } = require('./sec-helpers');

const OPEN = { residentBooking: true, residentLookup: true };
const ADMIN2 = H.ACTORS.admin2;

/** 外の画面と同じ経路：text/plain の POST で doPost を呼び、返ってきた JSON を読む */
async function post(env, body, user = null) {
  const contents = typeof body === 'string' ? body : JSON.stringify(body);
  const e = { postData: { contents, type: 'text/plain' } };
  const r = await env.host.run('doPost', [e], { kind: 'doGet', user });
  if (!r.ok) return { status: r.denied ? 'ACCESS_DENIED' : 'THROWN', error: r.error, _run: r };
  let parsed = null;
  try { parsed = JSON.parse(r.value.content); } catch (x) { parsed = null; }
  return { ...(parsed || { status: 'NON_JSON' }), _mime: r.value.mime, _raw: r.value.content, _run: r };
}
/** doPost からログインして、管理者のトークンを取る */
async function loginTok(env, a = ADMIN) {
  const r = await post(env, { fn: 'api_admin_login', args: [{ email: a.email, secret: a.secret }] });
  assert.equal(r.status, 'OK', 'ログインできない（前提）');
  return r.token;
}

// webApi_ の switch が通す19個（住民4＋config＋管理者14）
const ADMIN_FNS = ['api_admin_availability', 'api_admin_week', 'api_admin_register', 'api_admin_list', 'api_admin_cancel', 'api_admin_change', 'api_admin_callList', 'api_admin_markCalled', 'api_admin_addBlock', 'api_admin_releaseBlock', 'api_admin_blockList', 'api_admin_monthTable', 'api_admin_exportMonth'];
// 通してはいけない関数の名前（運用・試験用・内部・プロトタイプのキー・画面の入口そのもの）
const DENY_FN = [
  'setup_init', 'setup_run', 'setupCore_', 'job_archiveLedger', 'job_processNotifications',
  'testSeed_clear', 'testSeed_1year', 'doGet', 'doPost', 'webApi_', 'residentApi_', 'asAdmin_',
  'adminOf_', 'verifyAdmin_', 'book_', 'lookup_', 'guard_', 'hashSecret_',
  '__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'Config', 'DEFAULT_RULES', '', 'CONFIG', 'api_admin_login_', 'api_admin_', 'API_ADMIN_LIST',
];

test('[PT-C11] doPost（webApi_）は、許可リストの19個以外の関数の名前を、switch の default ですべて DENIED にする', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const before = snapshot(env.host);
  const tok = await loginTok(env); // 正しい印があっても、名前が許可リスト外なら通らないことを見る
  for (const fn of DENY_FN) {
    const r = await post(env, { fn, args: [{ token: tok }, { from: H.DAY, to: H.DAY, email: ADMIN.email, secret: ADMIN.secret, reservationId: '000001' }] });
    assert.equal(r.status, 'DENIED', `fn=${JSON.stringify(fn)} が ${r.status}（許可リスト外は DENIED）`);
  }
  // constructor・__proto__ などで、switch がほかの関数（admins_ など）に届かないこと＝台帳・設定は不変
  assert.equal(snapshot(env.host), before, '許可リスト外の名前で、台帳か設定が変わった');
  // 許可リストの管理者14個は switch では届くが、印が無ければ adminOf_ が DENIED にする
  for (const fn of ADMIN_FNS) {
    const r = await post(env, { fn, args: [null, { from: H.DAY, to: H.DAY }] });
    assert.equal(r.status, 'DENIED', `${fn} が、印なしで ${r.status}`);
  }
}));

test('[PT-C12] doPost は、args の数・型を崩しても（配列でない・null・巨大・入れ子・__proto__）、落ちず・漏らさず・安全に断る', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const before = snapshot(env.host);
  const tok = await loginTok(env);
  // args が配列でない → [body.arg ?? null] に落ちる＝a,b が null で、管理者の確認は失敗
  for (const args of ['x', 123, true, { 0: { token: tok } }, null]) {
    const r = await post(env, { fn: 'api_admin_list', args });
    assert.equal(r.status, 'DENIED', `args=${JSON.stringify(args)} が ${r.status}`);
  }
  // args が空・足りない → b が null。落ちない
  assert.notEqual((await post(env, { fn: 'api_admin_week', args: [{ token: tok }] })).status, 'THROWN', 'args 不足で落ちた');
  // 前の形 {fn, arg} も受ける（住民の関数）
  assert.equal((await post(env, { fn: 'api_getAvailability', arg: { from: '2026-10-20', to: '2026-10-21' } })).status, 'OK');
  // args[0]（auth）や args[1]（本文）に __proto__・constructor を入れても、汚染も昇格もしない
  const poison = await post(env, { fn: 'api_admin_register', args: [{ token: tok }, { __proto__: { isAdmin: true }, constructor: { x: 1 }, requestId: 'rq-poison-1', name: '偽', building: 'Z', room: '9', phone: '090-0000-0000', date: H.DAY, slotId: 'S1', quantity: 1, channel: 'PHONE' }] });
  assert.ok(['CONFIRMED', 'REJECTED', 'DENIED'].includes(poison.status), `__proto__ 入りで ${poison.status}`);
  assert.equal(({}).isAdmin, undefined, 'Object.prototype が汚染された');
  // 印の代わりに、型の違う token（オブジェクト・配列）を入れても、adminOf_ をすり抜けられない
  assert.equal((await post(env, { fn: 'api_admin_list', args: [{ token: { toString: 1 } }, {}] })).status, 'DENIED', 'token がオブジェクトなのに通った');
  assert.equal((await post(env, { fn: 'api_admin_list', args: [{ token: [tok] }, {}] })).status, 'DENIED', 'token が配列なのに通った');
  // 巨大な本文・壊れた JSON・postData 無し
  for (const raw of ['{壊れ', '', 'null', '[]', '"x"', '12345']) {
    const r = await post(env, raw);
    assert.equal(r.status, 'DENIED', `本文=${JSON.stringify(raw)} が ${r.status}`);
    assert.deepEqual(internalLeaks(env, r._raw), [], `本文=${JSON.stringify(raw)} で内部情報が漏れた`);
  }
  const noPost = await env.host.run('doPost', [{}], { kind: 'doGet', user: null });
  assert.equal(JSON.parse(noPost.value.content).status, 'DENIED', 'postData 無しが DENIED でない');
  const huge = await post(env, { fn: 'api_admin_list', args: [{ token: tok }, { from: '2026-10-20', to: 'x'.repeat(2_000_000) }] });
  assert.notEqual(huge.status, 'THROWN', '巨大な args で落ちた');
  assert.deepEqual(internalLeaks(env, huge._raw), [], '巨大な args で内部情報が漏れた');
}));

test('[PT-C13] doPost の管理者の入口は、偽・期限切れ・壊れた印、印の代わりの生の email＋パスコードを、すべて DENIED にする（正しい印だけ通す）', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  // 被害者の予約（個人情報）を1件、管理者が入れておく
  const reg = await v(env, 'api_admin_register', [adminAuth(), env.req(R[0], { channel: 'PHONE' })]);
  assert.equal(reg.status, 'CONFIRMED');
  const before = snapshot(env.host);

  const BAD_AUTH = [
    undefined, null, '', 'token', 123, [], { token: '' }, { token: 'deadbeef-not-real' }, { token: {} }, { token: ['x'] },
    { token: null }, { email: ADMIN.email, secret: 'wrong' }, { email: ADMIN.email }, { secret: ADMIN.secret },
    { email: ADMIN.email, secret: ADMIN.secret + 'x' }, { __proto__: { token: 'x' } }, { email: 'nobody@example.org', secret: 'x' },
  ];
  // 読む（一覧）・書く（取消し）の両方を、偽の印で試す
  for (const auth of BAD_AUTH) {
    const list = await post(env, { fn: 'api_admin_list', args: [auth, { from: H.DAY, to: H.DAY }] });
    assert.equal(list.status, 'DENIED', `一覧が、偽の印 ${JSON.stringify(auth)} で ${list.status}`);
    assert.deepEqual(allPii().filter((p) => p && JSON.stringify(list).includes(p)), [], `偽の印の応答に個人情報が漏れた: ${JSON.stringify(auth)}`);
    assert.equal(list.token, undefined, '偽の印の応答にトークンが入っている');
    const cancel = await post(env, { fn: 'api_admin_cancel', args: [auth, { reservationId: reg.reservationId }] });
    assert.equal(cancel.status, 'DENIED', `取消しが、偽の印 ${JSON.stringify(auth)} で ${cancel.status}`);
  }
  assert.equal(snapshot(env.host), before, '偽の印での管理者の呼出しで、台帳が変わった');
  // 正しい印（トークン・email＋パスコード）は通る
  const tok = await loginTok(env);
  assert.equal((await post(env, { fn: 'api_admin_list', args: [{ token: tok }, { from: H.DAY, to: H.DAY }] })).status, 'OK');
  assert.equal((await post(env, { fn: 'api_admin_list', args: [{ email: ADMIN.email, secret: ADMIN.secret }, { from: H.DAY, to: H.DAY }] })).status, 'OK');
}));

test('[PT-C14] doPost の管理者の入口は、google.script.run と守りの強さが同じ（結果が一致・パスコードの総当たりの締め出しも効く）', async (t) => H.withEnv(t, {}, async (env) => {
  // (1) 同じ入力で、doPost と google.script.run が同じ結果か
  const tok = await loginTok(env);
  const q = { from: H.DAY, to: H.DAY };
  const okPost = await post(env, { fn: 'api_admin_list', args: [{ token: tok }, q] });
  const okRun = await v(env, 'api_admin_list', [{ token: tok }, q]);
  assert.equal(okPost.status, okRun.status, '正しい印で、経路によって結果が違う');
  const ngPost = await post(env, { fn: 'api_admin_list', args: [{ token: 'x' }, q] });
  const ngRun = await v(env, 'api_admin_list', [{ token: 'x' }, q]);
  assert.equal(ngPost.status, 'DENIED');
  assert.equal(ngPost.status, ngRun.status, '偽の印で、経路によって結果が違う');

  // (2) パスコードの総当たりの締め出し（5回で15分）が、doPost から順に送っても効く
  const seq = [];
  for (let i = 0; i < 7; i++) seq.push((await post(env, { fn: 'api_admin_login', args: [{ email: ADMIN2.email, secret: 'ng' + i }] })).reason || 'TRY');
  const lockedCount = seq.filter((x) => x === 'LOCKED').length;
  assert.ok(lockedCount >= 2, `順に7回間違えても締め出されない（LOCKED=${lockedCount}）`);
  assert.notEqual((await post(env, { fn: 'api_admin_login', args: [{ email: ADMIN2.email, secret: ADMIN2.secret }] })).status, 'OK', '締め出し中なのに、doPost からログインできた');

  // (3) 締め出しは入口をまたいで共通（google.script.run で5回外す → doPost でも締め出し）
  const admin3 = ADMIN; // 別の管理者で、run 側から外す
  for (let i = 0; i < 5; i++) await call(env, 'api_admin_login', [{ email: admin3.email, secret: 'z' + i }], null);
  const crossed = await post(env, { fn: 'api_admin_login', args: [{ email: admin3.email, secret: admin3.secret }] });
  assert.notEqual(crossed.status, 'OK', 'google.script.run で外した締め出しが、doPost では効かない（入口ごとに別）');
}));
