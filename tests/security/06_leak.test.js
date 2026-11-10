'use strict';
// 侵入試験 面F・G：情報の漏れと doGet（docs/PENTEST.md 2.6）
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, R, v, call, adminAuth, internalLeaks, allPii } = require('./sec-helpers');

const OPEN = { residentBooking: true, residentLookup: true };
const doGet = (env, parameter, user = null) => env.host.run('doGet', [{ parameter, parameters: Object.fromEntries(Object.entries(parameter).map(([k, x]) => [k, [x]])), queryString: '' }], { kind: 'doGet', user });

async function seed(env) {
  for (let i = 0; i < 4; i++) await v(env, 'api_submitReservation', [env.req(R[i], { slotId: ['S1', 'S2', 'S3', 'S4'][i], email: R[i].email })]);
  await v(env, 'api_admin_register', [adminAuth(), env.req(R[5], { slotId: 'S1', channel: 'PHONE' })]);
}

test('[PT-F1] 例外・書込みの失敗を起こさせても、応答の文言に内部の情報（スタック・シート名・ID）が出ない', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  await seed(env);
  const out = [];
  out.push(await call(env, 'api_submitReservation', [env.req(R[6], { slotId: 'constructor' })]));
  env.host.setFaults({ sheetWrite: { fn: 'api_submitReservation', failAt: 1 } });
  out.push(await call(env, 'api_submitReservation', [env.req(R[7], { slotId: 'S2', date: '2026-10-27' })]));
  env.host.clearFaults();
  env.host.setFaults({ lock: { mode: 'timeout' } });
  out.push(await call(env, 'api_submitReservation', [env.req(R[8], { slotId: 'S3', date: '2026-10-27' })]));
  env.host.clearFaults();
  // スプレッドシートの ID を壊す（設定の誤り）
  const id = env.host.getScriptProperty('SPREADSHEET_ID');
  env.host.setScriptProperties({ SPREADSHEET_ID: 'SS_DOES_NOT_EXIST' });
  for (const fn of ['api_getAvailability', 'api_getRequestStatus', 'api_lookupReservation']) out.push(await call(env, fn, [{ from: H.DAY, to: H.DAY, requestId: 'rq-zzzzzzzz', reservationId: '100000', phoneTail: '1234' }]));
  out.push(await call(env, 'api_admin_list', [adminAuth(), {}]));
  env.host.setScriptProperties({ SPREADSHEET_ID: id });
  for (const r of out) {
    assert.ok(r.ok, `例外がそのまま google.script.run に返った: ${r.error && r.error.message}`);
    assert.deepEqual(internalLeaks(env, r.value).concat(H.findLeaks(r.value, ['SS_DOES_NOT_EXIST', 'シート「', 'openById'])), [], `応答に内部の情報: ${JSON.stringify(r.value).slice(0, 200)}`);
  }
}));

test('[PT-F2] doGet の HTML（住民・管理者）に、台帳の中身・スクリプトプロパティ・ハッシュ・個人情報が入らない', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  await seed(env);
  const props = JSON.parse(env.host.getScriptProperty('ADMINS'));
  const secrets = [env.spreadsheetId, 'SPREADSHEET_ID', 'ADMINS', '"RULES"', ...Object.values(props).flatMap((a) => [a.salt, a.hash]), ...Object.keys(props), H.ACTORS.admin.name, H.ACTORS.admin2.name];
  for (const parameter of [{}, { page: 'admin' }, { layout: 'calendar' }, { layout: 'list' }]) {
    for (const user of [null, R[3].email, H.ACTORS.owner.email]) {
      const g = await doGet(env, parameter, user);
      assert.ok(g.ok);
      assert.deepEqual(H.findLeaks(g.value.content, allPii().concat(secrets)), [], `doGet(${JSON.stringify(parameter)}) の HTML に秘密・個人情報`);
    }
  }
}));

test('[PT-F3] 公開の関数の全ての応答に、他人の個人情報が入らない（受付を開けた設定）', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  await seed(env);
  const rows = env.table('reservations').rows;
  const out = [];
  out.push(await v(env, 'api_getAvailability', [{ from: '2026-10-19', to: '2026-12-19' }]));
  for (const x of rows) {
    out.push(await v(env, 'api_getRequestStatus', [{ requestId: x.request_id }]));
    out.push(await v(env, 'api_lookupReservation', [{ reservationId: String(x.reservation_id), phoneTail: '0000' }]));
    // 同じ受付要求ID の送り直し（他人の結果が返る）
    out.push(await v(env, 'api_submitReservation', [{ ...env.req(R[11]), requestId: x.request_id }]));
  }
  out.push(await v(env, 'api_admin_login', [{ email: H.ACTORS.admin.email, secret: 'x' }]));
  assert.deepEqual(H.findLeaks(out, allPii()), [], '公開の応答に個人情報');
}));

test('[PT-G1] ?page= に admin 以外の名前（Admin・Setup・Common・Styles・../x・配列）を入れても、想定外のテンプレートは開かない', async (t) => H.withEnv(t, async (env) => {
  const index = (await doGet(env, {})).value;
  for (const page of ['Admin', 'ADMIN', 'admin ', ' admin', 'Setup', 'Common', 'Styles', 'Index', '../src/Admin', 'Admin.html', 'admin\u0000', 'Code', 'appsscript']) {
    const g = await doGet(env, { page });
    assert.ok(g.ok, `?page=${page} で落ちた`);
    assert.equal(g.value.title, index.title, `?page=${JSON.stringify(page)} で別の画面（${g.value.title}）が開いた`);
    assert.equal(g.value.content.length > 0, true);
  }
  // 引数が配列の形（?page=x&page=admin）でも、e.parameter は最初の値だけ
  const g = await env.host.run('doGet', [{ parameter: { page: 'x' }, parameters: { page: ['x', 'admin'] }, queryString: 'page=x&page=admin' }], { kind: 'doGet', user: null });
  assert.equal(g.value.title, index.title);
}));
