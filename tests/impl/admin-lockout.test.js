'use strict';
// 管理者のログインの締め出し（同じメールで5回間違えたら15分止める）は、依頼者の決定で停止（D-044）。
// 仕組みは残し、設定 RULES の adminLockout を true にすれば、今までどおり止まる。予約番号の確認の数え上げは、設定にかかわらず今のまま。
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS } = require('../helpers');

const login = (env, secret) => env.host.run('api_admin_login', [{ email: ACTORS.admin.email, secret }], { kind: 'client', user: null }).then((r) => r.value);
function setRules(env, extra) {
  const rules = JSON.parse(env.host.props.script.get('RULES') || '{}');
  env.host.setScriptProperties({ RULES: JSON.stringify({ ...rules, ...extra }) });
}

test('既定（停止）：6回間違えた後でも、正しいパスコードで入れる。間違いの応答は止まると言わない', async (t) => withEnv(t, async (env) => {
  for (let i = 0; i < 6; i++) {
    const r = await login(env, 'wrong-passcode');
    assert.equal(r.status, 'DENIED');
    assert.notEqual(r.reason, 'LOCKED');
    assert.equal(r.lockout, false);
  }
  assert.equal((await login(env, ACTORS.admin.secret)).status, 'OK');
}));

test('adminLockout: true：5回間違えると、6回目は正しいパスコードでも LOCKED', async (t) => withEnv(t, async (env) => {
  setRules(env, { adminLockout: true });
  assert.equal((await login(env, 'wrong-passcode')).lockout, true, '締め出しを入れているのに、止まると言わない');
  for (let i = 1; i < 5; i++) assert.equal((await login(env, 'wrong-passcode')).status, 'DENIED');
  const r = await login(env, ACTORS.admin.secret);
  assert.equal(r.status, 'DENIED');
  assert.equal(r.reason, 'LOCKED');
}));

test('予約番号の確認の数え上げは、締め出しの停止にかかわらず止まる', async (t) => withEnv(t, async (env) => {
  setRules(env, { residentLookup: true });
  const who = ACTORS.residents[0];
  const s = await env.adapter.submit(env.host, env.req(who, { slotId: 'S1' }), who);
  assert.equal(s.status, 'CONFIRMED');
  const tail = who.phone.replace(/\D/g, '').slice(-4);
  const look = (phoneTail) => env.host.run('api_lookupReservation', [{ reservationId: s.reservationId, phoneTail }], { kind: 'client', user: null }).then((r) => r.value.status);
  assert.equal(await look(tail), 'OK');
  for (let i = 0; i < 5; i++) assert.equal(await look('0000'), 'NOT_FOUND');
  assert.equal(await look(tail), 'NOT_FOUND', '5回外した後も、当たりで答えた');
}));
