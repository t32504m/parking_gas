'use strict';
// 侵入試験 面B：管理者の認証（docs/PENTEST.md 2.2）。全て「攻撃が成功しないこと」を期待する
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, R, ADMIN, v, call, adminAuth, allPii, digests } = require('./sec-helpers');

const login = (env, email, secret) => v(env, 'api_admin_login', [{ email, secret }]);
const MAX = 5;

test('[PT-B1] パスコードを5回間違えると、6回目は正しいパスコードでも通らない', async (t) => H.withEnv(t, async (env) => {
  for (let i = 0; i < MAX; i++) assert.equal((await login(env, ADMIN.email, `guess-${i}`)).status, 'DENIED');
  const r = await login(env, ADMIN.email, ADMIN.secret);
  assert.notEqual(r.status, 'OK', '締め出しの後に、総当たりで当てたパスコードが通った');
  assert.equal(r.reason, 'LOCKED');
}));

test('[PT-B2] メールの書き方（大文字・前後の空白）を変えても、締め出しの数え方を逃れられない', async (t) => H.withEnv(t, async (env) => {
  const variants = [ADMIN.email.toUpperCase(), ` ${ADMIN.email}`, `${ADMIN.email}\t`, ADMIN.email.replace('k', 'K'), `\n${ADMIN.email}\n`];
  for (const e of variants) await login(env, e, 'wrong-passcode');
  for (const e of [ADMIN.email, ...variants]) {
    const r = await login(env, e, ADMIN.secret);
    assert.notEqual(r.status, 'OK', `書き方「${JSON.stringify(e)}」で、締め出しの後に通った`);
  }
}));

test('[PT-B3] ログイン以外の管理者用の関数に {email, secret} を付けた総当たりも、同じく数えて止める', async (t) => H.withEnv(t, async (env) => {
  const fns = ['api_admin_list', 'api_admin_callList', 'api_admin_blockList', 'api_admin_week', 'api_admin_monthTable'];
  for (let i = 0; i < MAX; i++) await v(env, fns[i], [{ email: ADMIN.email, secret: `guess-${i}` }, {}]);
  const r1 = await v(env, 'api_admin_list', [adminAuth(), {}]);
  assert.equal(r1.status, 'DENIED', '関数を変えながらの総当たりで、締め出しの後に通った');
  const r2 = await login(env, ADMIN.email, ADMIN.secret);
  assert.notEqual(r2.status, 'OK');
}));

test('[PT-B4] 30件を同時に送っても、15分の間に確かめるパスコードは5個まで（締め出しを同時実行で逃れられない）', async (t) => H.withEnv(t, async (env) => {
  const calls = [];
  for (let i = 0; i < 29; i++) calls.push({ fn: 'api_admin_login', args: [{ email: ADMIN.email, secret: `guess-${i}` }], kind: 'client', user: null });
  calls.push({ fn: 'api_admin_login', args: [{ email: ADMIN.email, secret: ADMIN.secret }], kind: 'client', user: null });
  const rs = await env.host.runConcurrently(calls);
  const checked = rs.reduce((n, r) => n + digests(r), 0);
  const okCount = rs.filter((r) => r.ok && r.value && r.value.status === 'OK').length;
  const counter = env.host.cache.get(`script|fail:${ADMIN.email}`);
  assert.ok(checked <= MAX + 1, `同時の30件で、パスコードを ${checked} 個確かめた（締め出しの数は ${counter && counter.v}。正しいパスコードの成功 ${okCount} 件）`);
}));

test('[PT-B5] 攻撃者が管理者のメールで5回間違えても、本物の管理者はログインできる（締め出しを妨害に使えない）', async (t) => H.withEnv(t, async (env) => {
  for (let i = 0; i < MAX; i++) await login(env, ADMIN.email, `attacker-${i}`);
  const r = await login(env, ADMIN.email, ADMIN.secret);
  assert.equal(r.status, 'OK', `攻撃者の5回の間違いの後、本物の管理者のログインが ${r.status} ${r.reason || ''}`);
}));

test('[PT-B6] パスコードを替えた後は、前のパスコードで手に入れたトークンが使えない', async (t) => H.withEnv(t, async (env) => {
  const stolen = (await login(env, ADMIN.email, ADMIN.secret)).token;
  assert.ok(stolen);
  // 漏れたと気づいた持ち主が、エディタからパスコードを替える（setup_init は同じメールの管理者を書き換える）
  const rot = await env.host.run('setup_init', [env.rules, [{ email: ADMIN.email, name: ADMIN.name, secret: 'brand-new-passcode-2026' }]], { kind: 'editor' });
  assert.equal(rot.value.status, 'OK');
  assert.notEqual((await login(env, ADMIN.email, ADMIN.secret)).status, 'OK', '前のパスコードがまだ通る');
  const r = await v(env, 'api_admin_list', [{ token: stolen }, {}]);
  assert.equal(r.status, 'DENIED', `パスコードを替えた後も、前のトークンで予約の一覧が ${r.status}`);
}));

test('[PT-B7] 偽のトークン・推測したトークン・他の鍵の名前では、管理者になれない', async (t) => H.withEnv(t, async (env) => {
  const real = (await login(env, ADMIN.email, ADMIN.secret)).token;
  const fakes = ['x', real.slice(0, 36), real.slice(36), real.toUpperCase(), `${real} `, `adm:${real}`, `fail:${ADMIN.email}`, ADMIN.email, ADMIN.secret, '*', '%', '../', '\u0000'];
  for (const token of fakes) {
    const r = await v(env, 'api_admin_list', [{ token }, {}]);
    assert.equal(r.status, 'DENIED', `token=${JSON.stringify(token).slice(0, 40)} → ${r.status}`);
  }
}));

test('[PT-B8] 応答の違いで、管理者のメールかどうかが分からない', async (t) => H.withEnv(t, async (env) => {
  const strip = (r) => JSON.stringify({ ...r });
  for (let i = 0; i < MAX + 1; i++) {
    const a = await login(env, ADMIN.email, `guess-${i}`);
    const b = await login(env, 'nobody@example.org', `guess-${i}`);
    assert.equal(strip(a), strip(b), `${i + 1}回目：管理者のメールと知らないメールで、応答が違う`);
  }
  const c = await login(env, 'nobody@example.org', ''), d = await login(env, ADMIN.email, '');
  assert.equal(strip(c), strip(d), '空のパスコードで、管理者のメールかどうかが分かる');
}));

test('[PT-B9] 時間差で、管理者のメールかどうかが分からない（どちらも同じだけ計算する）', async (t) => H.withEnv(t, async (env) => {
  const a = await call(env, 'api_admin_login', [{ email: ADMIN.email, secret: 'wrong-1' }]);
  const b = await call(env, 'api_admin_login', [{ email: 'nobody@example.org', secret: 'wrong-1' }]);
  assert.equal(digests(b), digests(a), `ハッシュの計算：管理者のメール ${digests(a)} 回、知らないメール ${digests(b)} 回（時間の差になる）`);
}));

test('[PT-B10] 管理者用 URL を開くだけでは、個人情報・管理者のメール・設定が HTML に入らない', async (t) => H.withEnv(t, async (env) => {
  await v(env, 'api_submitReservation', [env.req(R[0], { email: R[0].email })]);
  await v(env, 'api_admin_register', [adminAuth(), env.req(R[1], { slotId: 'S2', channel: 'PHONE' })]);
  for (const user of [null, R[4].email]) {
    const g = await env.host.run('doGet', [{ parameter: { page: 'admin' }, parameters: { page: ['admin'] }, queryString: 'page=admin' }], { kind: 'doGet', user });
    assert.ok(g.ok);
    const html = g.value.content;
    assert.match(html, /管理者の確認|api_admin_login/);
    const props = JSON.parse(env.host.getScriptProperty('ADMINS'));
    const secrets = [env.spreadsheetId, ...Object.values(props).flatMap((a) => [a.salt, a.hash]), ...Object.keys(props)];
    assert.deepEqual(H.findLeaks(html, allPii().concat(secrets)), [], '管理者用の HTML に、個人情報・管理者のメール・秘密が入っている');
  }
}));
