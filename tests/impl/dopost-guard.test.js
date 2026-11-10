'use strict';
// doPost は、どんな本文でも JSON で答える（外に置いた画面は、GAS の HTML のエラー画面を読めない。D-036）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv } = require('../helpers');

const post = (env, postData) => env.host.run('doPost', [{ postData, parameter: {} }], { kind: 'client', user: null });

test('大きすぎる本文・文字列でない本文は、読まずに DENIED を JSON で返す', async (t) => withEnv(t, async (env) => {
  const big = JSON.stringify({ fn: 'api_getAvailability', args: [{ from: '2026-10-26', to: '2026-10-26', pad: 'x'.repeat(200000) }] });
  for (const pd of [{ contents: big, type: 'text/plain' }, { contents: 12345 }, { contents: { fn: 'config' } }]) {
    const r = await post(env, pd);
    assert.ok(r.ok, JSON.stringify(r.error));
    assert.deepEqual(JSON.parse(String(r.value.content)), { status: 'DENIED' });
  }
}));

test('台帳を読めないときも、例外にせず JSON（ERROR）で返す', async (t) => withEnv(t, async (env) => {
  env.host.setScriptProperties({ SPREADSHEET_ID: 'NO_SUCH_SHEET' });
  const r = await post(env, { contents: JSON.stringify({ fn: 'api_getAvailability', args: [{ from: '2026-10-26', to: '2026-10-26' }] }) });
  assert.ok(r.ok, JSON.stringify(r.error));
  const j = JSON.parse(String(r.value.content));
  assert.equal(j.status, 'ERROR');
}));
