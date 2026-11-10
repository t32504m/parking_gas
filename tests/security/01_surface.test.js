'use strict';
// 侵入試験 面A：公開関数（docs/PENTEST.md 2.1）。全て「攻撃が成功しないこと」を期待する
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GasHost } = require('../../harness/emulator/host');
const { H, R, ADMIN, call, v, adminAuth, snapshot, internalLeaks, allPii } = require('./sec-helpers');

const ROOT = path.join(__dirname, '..', '..');
const SURFACE = H.CONTRACT.surface.functions;
const ADMIN_FNS = Object.keys(SURFACE).filter((f) => SURFACE[f] === 'admin' && f !== 'api_admin_login');
const OWNER_FNS = Object.keys(SURFACE).filter((f) => SURFACE[f] === 'operator' || SURFACE[f] === 'job');
const EXCEPT = H.CONTRACT.surface.auditSheetsWritableOnDenied || [];

const BAD_AUTH = [
  undefined, null, [], ['token'], 'token', 12345, true, {},
  { token: '' }, { token: {} }, { token: ['x'] }, { token: 'x'.repeat(200) },
  { token: 'fail:' + ADMIN.email }, { token: '00000000-0000-0000-0000-000000000000' },
  { email: ADMIN.email }, { email: ADMIN.email, secret: '' }, { email: ADMIN.email, secret: ['x'] },
  { email: ADMIN.email, secret: { toString: 'x' } }, { secret: ADMIN.secret },
  JSON.parse('{"__proto__": {"token": "x", "email": "kanri1@example.org"}}'),
  { email: [ADMIN.email], secret: [ADMIN.secret] },
];
const ATTACK_ARG = { reservationId: '100000', date: H.DAY, slotId: 'S1', quantity: 1, name: '攻撃', building: 'A棟', room: '1', phone: '0900000000', reason: 'x', requestId: 'rq-attack-0001', from: H.DAY, to: H.DAY, confirm: true, blockId: '1', month: '2026-10' };

test('[PT-A1] 管理者用の関数を、壊れた auth・偽のトークンで呼んでも、何も見えず何も変わらない', async (t) => H.withEnv(t, async (env) => {
  const own = await v(env, 'api_submitReservation', [env.req(R[0])]);
  assert.equal(own.status, 'CONFIRMED');
  const pii = allPii();
  for (const fn of ADMIN_FNS) {
    for (const auth of BAD_AUTH) {
      for (const who of [null, R[3].email]) {
        const before = snapshot(env.host, EXCEPT);
        const r = await v(env, fn, [auth, ATTACK_ARG], who);
        assert.equal(snapshot(env.host, EXCEPT), before, `${fn}(${JSON.stringify(auth)}) で台帳などが変わった`);
        assert.equal(r.status, 'DENIED', `${fn}(${JSON.stringify(auth)}) の応答が ${r.status}`);
        assert.deepEqual(H.findLeaks(r, pii), [], `${fn} の拒否の応答に個人情報`);
      }
    }
  }
}));

test('[PT-A2] 持ち主用の関数（setup_*・job_*）を、匿名・住民・同じドメインの人が呼んでも、何も変わらない', async (t) => H.withEnv(t, async (env) => {
  await v(env, 'api_submitReservation', [env.req(R[0], { email: R[0].email })]);
  env.host.sameDomain = 'example.com'; // 持ち主 owner@example.com と同じ Workspace の人
  const evil = [{ residentBooking: true, capacityPerSlot: 3 }, [{ email: 'evil@example.net', name: '攻撃者', secret: 'evil-passcode-1' }]];
  for (const who of [null, R[1].email, 'neighbor@example.com']) {
    for (const fn of OWNER_FNS) {
      const before = snapshot(env.host, []);
      const r = await v(env, fn, evil, who);
      assert.equal(snapshot(env.host, []), before, `${who || '匿名'} が ${fn} を呼ぶと、台帳・設定・トリガー・メールが変わった`);
      assert.equal(r.status, 'DENIED', `${who || '匿名'} が ${fn} を呼んだ応答が ${r.status}`);
    }
  }
  const login = await v(env, 'api_admin_login', [{ email: 'evil@example.net', secret: 'evil-passcode-1' }]);
  assert.notEqual(login.status, 'OK', '攻撃者が管理者として足された');
}));

test('[PT-A3] 持ち主がログインしたまま開いた画面の中から呼ばれても、setup_*・job_* は動かない（エディタ・トリガーからだけ動く）', async (t) => H.withEnv(t, async (env) => {
  await v(env, 'api_submitReservation', [env.req(R[0], { email: R[0].email })]);
  const owner = H.ACTORS.owner.email;
  const tries = [
    ['setup_init', [{ residentBooking: true }, [{ email: 'evil@example.net', name: '攻撃者', secret: 'evil-passcode-1' }]]],
    ['job_processNotifications', []],
    ['job_archiveLedger', []],
  ];
  const ran = [];
  for (const [fn, args] of tries) {
    const before = snapshot(env.host, []);
    const r = await v(env, fn, args, owner);
    if (r.status !== 'DENIED' || snapshot(env.host, []) !== before) ran.push(`${fn} → ${r.status}`);
  }
  const login = await v(env, 'api_admin_login', [{ email: 'evil@example.net', secret: 'evil-passcode-1' }]);
  assert.deepEqual(ran, [], `画面の中（google.script.run）から、持ち主用の関数が動いた。攻撃者の管理者のログイン：${login.status}`);
}));

/** src/ と tools/real-gas/TestSeed.gs を合わせた、試験用のプロジェクト（本物の試験の形） */
function seedProjectDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-seed-'));
  for (const f of fs.readdirSync(path.join(ROOT, 'src'))) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(dir, f));
  fs.copyFileSync(path.join(ROOT, 'tools', 'real-gas', 'TestSeed.gs'), path.join(dir, 'TestSeed.gs'));
  return dir;
}
function topLevelPublic(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map((m) => m[1]).filter((n) => !n.endsWith('_'));
}

test('[PT-A4] 試験用の testSeed_* を、匿名・住民・持ち主の画面から呼んでも、試験の台帳が変わらない', async (t) => {
  const dir = seedProjectDir();
  const host = new GasHost({ projectDir: dir, now: H.NOW, latency: { min: 0, max: 0 } });
  t.after(async () => { await host.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  host.createSpreadsheet({ id: 'SS_SEED', name: '駐車場予約 台帳（試験）' });
  await H.adapter.setup(host, { spreadsheetId: 'SS_SEED', rules: H.RULES, admins: [ADMIN], contract: H.CONTRACT });
  const env = { host, spreadsheetId: 'SS_SEED' };
  // 住民の画面から「seed-」で始まる受付要求ID で申し込む（testSeed_clear が消す対象になる）
  const seeded = await v(env, 'api_submitReservation', [H.reqFor(R[0], { requestId: 'seed-attacker-0001' })]);
  assert.equal(seeded.status, 'CONFIRMED');
  const fns = topLevelPublic(path.join(ROOT, 'tools', 'real-gas', 'TestSeed.gs'));
  assert.ok(fns.includes('testSeed_clear'));
  const ran = [];
  for (const who of [null, R[2].email, H.ACTORS.owner.email]) {
    for (const fn of ['testSeed_clear', 'testSeed_status', 'testSeed_nightArchive']) {
      const before = snapshot(host, []);
      const r = await v(env, fn, [], who);
      if (r.status !== 'DENIED' || snapshot(host, []) !== before) ran.push(`${who || '匿名'}: ${fn} → ${r.status}`);
    }
  }
  assert.deepEqual(ran, [], 'google.script.run から試験用の関数が動いた');
});

test('[PT-A5] contract.json の surface と、src/ の公開関数が食い違わない', () => {
  const dir = path.join(ROOT, 'src');
  const pub = fs.readdirSync(dir).filter((f) => f.endsWith('.gs')).flatMap((f) => topLevelPublic(path.join(dir, f))).sort();
  assert.deepEqual(pub, Object.keys(SURFACE).sort(), 'surface に無い公開関数、または src に無い宣言がある');
  // 管理者用と宣言した関数は、名前で分かる（api_admin_*）。それ以外の名前の管理者用の関数が無い
  const odd = Object.keys(SURFACE).filter((f) => (SURFACE[f] === 'admin') !== f.startsWith('api_admin_'));
  assert.deepEqual(odd, [], '区分と名前が合わない');
});

const WEIRD = [
  null, undefined, [], [1, 2], 'x', '', 0, -1, 1e308, true, {},
  { requestId: ['rq-aaaaaaaa'], date: ['2026-10-26'], slotId: ['S1'], quantity: [1] },
  { requestId: { a: 1 }, date: { a: 1 }, slotId: { a: 1 }, quantity: { a: 1 }, from: {}, to: {}, month: {} },
  { from: '2026-10-19', to: '2027-10-19' }, { from: '2026-10-26', to: '2026-10-19' }, { month: '2026-13' },
  { requestId: 'x'.repeat(100000), name: 'あ'.repeat(100000), text: 'x'.repeat(100000) },
  JSON.parse('{"__proto__": {"status": "OK", "date": "2026-10-26"}, "constructor": {"prototype": {"x": 1}}}'),
  { reservationId: { $ne: null }, phoneTail: ['1234'], blockId: ['1'] },
];

test('[PT-A6] 全ての公開関数に型・形の違う引数を送っても、例外で落ちず、内部の情報も出ず、台帳も変わらない', async (t) => H.withEnv(t, async (env) => {
  await v(env, 'api_submitReservation', [env.req(R[0], { email: R[0].email })]);
  const pii = allPii();
  const thrown = [];
  const publicFns = ['api_getAvailability', 'api_submitReservation', 'api_getRequestStatus', 'api_lookupReservation', 'api_admin_login'];
  for (const fn of publicFns.concat(ADMIN_FNS)) {
    for (const arg of WEIRD) {
      const args = fn.startsWith('api_admin_') && fn !== 'api_admin_login' ? [adminAuth(), arg] : [arg];
      const before = snapshot(env.host, EXCEPT);
      const r = await call(env, fn, args, null);
      const label = `${fn}(${String(JSON.stringify(arg)).slice(0, 50)})`;
      if (!r.ok || !r.value || r.value.status === 'ERROR') thrown.push(`${label} → ${r.ok ? r.value && r.value.status : r.error && r.error.message}`);
      assert.deepEqual(internalLeaks(env, r.ok ? r.value : null), [], `${label} の応答に内部の情報`);
      if (!fn.startsWith('api_admin_')) assert.deepEqual(H.findLeaks(r.value, pii), [], `${label} の応答に個人情報`);
      assert.equal(snapshot(env.host, EXCEPT), before, `${label} で台帳などが変わった`);
    }
  }
  assert.deepEqual(thrown, [], '形の違う引数で、検査をすり抜けて例外（ERROR）になった');
}));

test('[PT-A7] コマID に Object の名前（constructor・__proto__・toString・hasOwnProperty）を送ると、入力の誤りとして断る', async (t) => H.withEnv(t, async (env) => {
  const bad = [];
  for (const slotId of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    const a = await v(env, 'api_submitReservation', [env.req(R[0], { slotId })]);
    const b = await v(env, 'api_admin_register', [adminAuth(), env.req(R[1], { slotId, channel: 'PHONE' })]);
    for (const [who, r] of [['住民', a], ['管理者', b]]) if (!(r.status === 'REJECTED' && r.reason === 'INVALID')) bad.push(`${who} slotId=${slotId} → ${r.status} ${r.reason || ''}`);
  }
  assert.equal(env.table('reservations').rows.length, 0, '予約の行が書かれた');
  assert.deepEqual(bad, [], 'Object の名前のコマID が、入力の検査を通った');
}));

test('[PT-A8] 日付・台数・コマ・区画の形を変えても、範囲の外の予約・割当ては作れない', async (t) => H.withEnv(t, async (env) => {
  const dates = ['2026-02-30', '2026-10-26T00:00', '2026-10-26 ', ' 2026-10-26', '２０２６-10-26', '2026/10/26', '20261026', 20261026, '+02026-10-26', '2026-10-6', '9999-12-31', '0000-01-01'];
  for (const date of dates) {
    const r = await v(env, 'api_submitReservation', [env.req(R[0], { date })]);
    assert.equal(r.status, 'REJECTED', `date=${JSON.stringify(date)} → ${r.status}`);
  }
  const over = Math.min(Number(env.rules.maxQuantityPerRequest) || 1, Number(env.rules.capacityPerSlot) || 3) + 1; // 設定の上限より1台多い
  for (const quantity of [-1, 0, 0.5, 1.5, '1', over, 1e9, NaN, Infinity, null]) {
    const r = await v(env, 'api_submitReservation', [env.req(R[0], { quantity })]);
    assert.equal(r.status, 'REJECTED', `quantity=${quantity} → ${r.status}`);
  }
  for (const slotId of ['S5', 's1', 'S1 ', '', 1]) {
    const r = await v(env, 'api_submitReservation', [env.req(R[0], { slotId })]);
    assert.equal(r.status, 'REJECTED', `slotId=${slotId} → ${r.status}`);
  }
  for (const preferSpace of ['94', '0', '91,92', ['91', '92'], '__proto__']) {
    await v(env, 'api_submitReservation', [env.req(R[0], { preferSpace, slotId: 'S2' })]);
  }
  const spaces = env.table('allocations').rows.map((a) => String(a.space_id));
  assert.ok(spaces.every((s) => ['91', '92', '93'].includes(s)), `区画の外の割当て: ${spaces}`);
}));
