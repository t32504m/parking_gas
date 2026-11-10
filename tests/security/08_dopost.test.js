'use strict';
// 侵入試験 面C（追加）：住民の画面を GAS の外（Cloudflare Pages など、D-034）に置いたことで増えた入口 doPost。
// doPost は、本文 {"fn","arg"}（Content-Type は text/plain、クッキー無し）を residentApi_ に渡す。
// residentApi_ は、住民向けの4つの関数と config だけを通し、ほかは DENIED（src/Web.gs）。
// エミュレータには ContentService があるので、doPost を直接呼べる。未ログインの人として kind:'doGet' で呼ぶ。
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, R, v, adminAuth, snapshot, internalLeaks } = require('./sec-helpers');

const OPEN = { residentBooking: true, residentLookup: true };

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

// 通してはいけない関数の名前（管理者・運用・試験用）と、プロトタイプのキー
const DENY_FN = [
  'api_admin_login', 'api_admin_register', 'api_admin_cancel', 'api_admin_addBlock', 'api_admin_search',
  'setup_init', 'setup_run', 'setupCore_', 'job_archiveLedger', 'job_processNotifications',
  'doGet', 'doPost', 'residentApi_', 'verifyAdmin_', 'book_', 'lookup_',
  '__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'Config', 'DEFAULT_RULES', '', 'CONFIG',
];

test('[PT-C11] doPost の入口は、住民向けの4つと config 以外の関数の名前を、すべて DENIED で断る（台帳・設定は変わらない）', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const before = snapshot(env.host);
  for (const fn of DENY_FN) {
    const r = await post(env, { fn, arg: { email: 'x', secret: 'y', requestId: 'rq-x', reservationId: '000000' } });
    assert.equal(r.status, 'DENIED', `fn=${JSON.stringify(fn)} が ${r.status}（DENIED で断るべき）`);
    assert.deepEqual(Object.keys(r).filter((k) => !k.startsWith('_')), ['status'], `fn=${JSON.stringify(fn)} の応答に status 以外の情報が出た: ${r._raw}`);
  }
  // 通ってよい4つ＋config は DENIED にならない（入口そのものは生きている）
  assert.equal((await post(env, { fn: 'config' })).status, 'OK');
  assert.equal((await post(env, { fn: 'api_getAvailability', arg: { from: '2026-10-20', to: '2026-10-21' } })).status, 'OK');
  assert.equal(snapshot(env.host), before, 'DENIED を返したのに、台帳か設定が変わった');
}));

test('[PT-C12] doPost は、fn が文字列でない・本文が壊れている・巨大でも、落ちず・漏らさず・DENIED か REJECTED を返す', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const before = snapshot(env.host);
  // fn が文字列でない → typeof で弾かれ DENIED
  for (const fn of [['config'], { fn: 'config' }, 123, null, true]) {
    const r = await post(env, { fn });
    assert.equal(r.status, 'DENIED', `fn=${JSON.stringify(fn)} が ${r.status}`);
  }
  // 本文が JSON として壊れている・空・配列・文字列・数値・postData 無し → すべて DENIED（JSON.parse 失敗は null 扱い）
  for (const raw of ['{壊れた', '', 'null', '[]', '"x"', '12345', 'undefined']) {
    const r = await post(env, raw);
    assert.equal(r.status, 'DENIED', `本文=${JSON.stringify(raw)} が ${r.status}`);
    assert.deepEqual(internalLeaks(env, r._raw), [], `本文=${JSON.stringify(raw)} の応答に内部の情報が漏れた: ${internalLeaks(env, r._raw)}`);
  }
  const noPost = await env.host.run('doPost', [{}], { kind: 'doGet', user: null });
  assert.equal(noPost.ok, true, 'postData 無しで doPost が落ちた');
  assert.equal(JSON.parse(noPost.value.content).status, 'DENIED');
  // 巨大な本文（fn も arg も）→ 落ちない。arg が巨大でも住民の関数の検査で弾く
  assert.equal((await post(env, { fn: 'x'.repeat(2_000_000) })).status, 'DENIED', '巨大な fn で DENIED にならない');
  const huge = await post(env, { fn: 'api_getAvailability', arg: { from: '2026-10-20', to: 'x'.repeat(2_000_000) } });
  assert.notEqual(huge.status, 'THROWN', '巨大な arg で落ちた');
  assert.deepEqual(internalLeaks(env, huge._raw), [], '巨大な arg の応答に内部の情報が漏れた');
  assert.equal(snapshot(env.host), before, '壊れた・巨大な入力で、台帳か設定が変わった');
}));

test('[PT-C13] doPost から、他人の確定した予約を取消し・変更できない（取消しの関数は入口に無く、管理者用は DENIED）', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  // 被害者が1件、正規の経路（google.script.run）で確定させる
  const victim = await v(env, 'api_submitReservation', [env.req(R[0], { date: '2026-10-26', slotId: 'S1' })]);
  assert.equal(victim.status, 'CONFIRMED', '前提：被害者の予約が確定していない');
  const rid = victim.reservationId;
  const stateOf = () => (env.table('reservations').rows.find((x) => x.reservation_id === rid) || {}).state;
  assert.equal(stateOf(), '確定');
  const before = snapshot(env.host);

  // doPost から、取消し・変更に当たる呼び方をいろいろ試す
  const tries = [
    { fn: 'api_admin_cancel', arg: { reservationId: rid, email: H.ACTORS.admin.email, secret: H.ACTORS.admin.secret } },
    { fn: 'api_admin_cancel', arg: { auth: adminAuth(), reservationId: rid } },
    { fn: 'adminCancel_', arg: { reservationId: rid } },
    { fn: 'api_submitReservation', arg: { reservationId: rid, state: '取消済み', cancel: true } },
    // 被害者の受付要求IDを使い回して上書き・取消しを狙う
    { fn: 'api_submitReservation', arg: env.req(R[1], { requestId: victim.requestId, date: '2026-10-26', slotId: 'S1', quantity: 0 }) },
  ];
  for (const b of tries) {
    const r = await post(env, b);
    assert.ok(r.status === 'DENIED' || r.status === 'REJECTED' || r.status === 'CONFIRMED',
      `${JSON.stringify(b.fn)} が ${r.status}`);
    assert.equal(stateOf(), '確定', `${JSON.stringify(b.fn)} の後、被害者の予約が ${stateOf()} になった（取消し・変更された）`);
  }
  assert.equal(snapshot(env.host), before, 'doPost からの取消し・変更の試みで、台帳が変わった');
}));

test('[PT-C14] doPost を通る住民の4つは、google.script.run で呼んだときと同じ結果（入口が増えても権限は変わらない）', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  // 空き状況：両経路で同じ中身
  const q = { from: '2026-10-20', to: '2026-10-22' };
  const viaRun = await v(env, 'api_getAvailability', [q]);
  const viaPost = await post(env, { fn: 'api_getAvailability', arg: q });
  assert.equal(viaPost.status, 'OK');
  assert.deepEqual(viaPost.days, viaRun.days, '同じ空き状況が、経路で違う結果になった');
  // 受付要求の確認：無い番号は両経路とも「無い」と答える（PII は増えない）
  const st = await post(env, { fn: 'api_getRequestStatus', arg: { requestId: 'rq-nope-0001' } });
  assert.notEqual(st.status, 'THROWN');
  // 予約の確認：開けていれば答え、閉じていれば答えない（設定どおり。権限は関数側にある）
  const openLk = await post(env, { fn: 'api_lookupReservation', arg: { reservationId: '000000', phoneTail: '0000' } });
  assert.notEqual(openLk.status, 'THROWN', 'lookup が落ちた');
  await H.withEnv({ name: 'closed-lookup' }, { rules: { residentBooking: true, residentLookup: false } }, async (env2) => {
    const closed = await post(env2, { fn: 'api_lookupReservation', arg: { reservationId: '000000', phoneTail: '0000' } });
    assert.notEqual(closed.status, 'OK', 'residentLookup を閉じているのに doPost の予約の確認が答えた');
  });
}));
