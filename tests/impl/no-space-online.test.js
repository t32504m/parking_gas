'use strict';
// 運用確認（2026-11-12）: 区画番号（91〜93）は利用者側から見えない。サーバーも画面（ONLINE）の応答に載せない。
// 管理者経路（電話・窓口）は従来どおり返す（管理者の画面が確定直後の表示に使う）。93に当たる3台目は元から管理者だけ（capacityFor_・D-040）。
// 生の応答を見るため、試験の正規化（adapter.norm）を通さず host.run で直接呼ぶ。
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS } = require('../helpers');

const OPEN = { rules: { residentBooking: true, residentLeadDays: 0 } };

test('住民の画面の確定応答に区画を載せない（電話経路は従来どおり）', async (t) => withEnv(t, OPEN, async (env) => {
  const online = await env.host.run('api_submitReservation', [env.req(ACTORS.residents[0], { slotId: 'S2' })], { kind: 'client', user: null });
  assert.equal(online.value.status, 'CONFIRMED');
  assert.equal(online.value.spaces, undefined, '画面の応答に区画が無い');
  assert.ok(!JSON.stringify(online.value).match(/"9[123]"/), '応答の文字列に区画番号（91〜93）が含まれない');
  const auth = { email: ACTORS.admin.email, secret: ACTORS.admin.secret };
  const admin = await env.host.run('api_admin_register',
    [auth, { ...env.req(ACTORS.residents[1], { slotId: 'S3' }), channel: 'PHONE', email: undefined }], { kind: 'client', user: ACTORS.admin.email });
  assert.equal(admin.value.status, 'CONFIRMED');
  assert.ok(Array.isArray(admin.value.spaces) && admin.value.spaces.length === 1, '電話経路は区画を返す（管理者の画面が使う）');
}));
