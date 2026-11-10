'use strict';
// tools/real-gas/TestSeed.gs（本物の GAS での試験の道具）を、エミュレータで確かめる。
//   node --test tests/impl/real-gas-seed.test.js
// src/ の全ファイルに TestSeed.gs を足した一時フォルダを作り、tests/helpers.js の createEnv で動かす。
// 確かめること：
//   ・1年分・3年分の行の数と形（tools/measure-growth.js の seed と同じ列・値の形）
//   ・入れた台帳で、主な処理と保管（job_archiveLedger）が動く
//   ・測定がログに出て、測定の予約が残らない
//   ・消すのは試験データだけ（画面から入れた予約は残る）
//   ・持ち主でない人・本番の台帳では、何もしない（貼り忘れても害が無い）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'real-gas-seed-'));
for (const f of fs.readdirSync(path.join(ROOT, 'src'))) fs.copyFileSync(path.join(ROOT, 'src', f), path.join(DIR, f));
fs.copyFileSync(path.join(ROOT, 'tools', 'real-gas', 'TestSeed.gs'), path.join(DIR, 'TestSeed.gs'));
process.env.HARNESS_PROJECT_DIR = DIR;
process.on('exit', () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 一時フォルダ */ } });

const { createEnv, ACTORS } = require('../helpers');

// 手順書の RULES（docs/REAL_TEST_無料アカウント.md 2章）と同じ
const REAL_TEST_RULES = { capacityPerSlot: 2, maxQuantityPerRequest: 1, residentBooking: true, residentLookup: true, residentLeadDays: 0, residentViewMonths: 1, viewMonths: 2, archiveAfterDays: 60 };
const NOW = '2026-11-09T10:00:00+09:00';

const editor = (env, fn) => env.host.run(fn, [], { kind: 'editor' });
const rows = (env, name) => env.host.dumpSheet(env.spreadsheetId, name).rows;
const auth = { email: ACTORS.admin.email, secret: ACTORS.admin.secret };
const asAdmin = (env, fn, ...args) => env.host.run(fn, [auth, ...args], { kind: 'client', user: ACTORS.admin.email });

async function withSeedEnv(fn, opts = {}) {
  const env = await createEnv({ now: NOW, rules: REAL_TEST_RULES, ...opts });
  try { return await fn(env); } finally { await env.host.close(); }
}

test('1年分：2,920件を入れ、行の形が measure-growth の seed と同じ', async () => withSeedEnv(async (env) => {
  const r = await editor(env, 'testSeed_1year');
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.equal(r.value.status, 'OK', JSON.stringify(r.value));
  assert.equal(r.value.added, 365 * 4 * 2);
  for (const name of ['予約', '割当て', '通知', '操作履歴']) assert.equal(rows(env, name).length, 2920, name);

  const res = rows(env, '予約');
  const first = res[0];
  // 最初の行は 365日前の朝。最後の行は昨日の夜
  assert.equal(String(first['利用日']), '2025-11-09');
  assert.equal(String(res[res.length - 1]['利用日']), '2026-11-08');
  assert.equal(first['状態'], '確定');
  assert.equal(first['受付経路'], 'PHONE');
  assert.equal(first['コマID'], 'S1');
  assert.equal(first['時間帯'], 'A 朝 8:00〜11:00'); // 画面からの登録（book_）と同じ書き方（slotText_）
  assert.equal(first['台数'], 1);
  assert.equal(first['料金合計'], 300);
  assert.equal(first['開始日時'], '2025-11-09T08:00:00+09:00');
  assert.equal(first['電話番号'], '090-0000-0000'); // 先頭の 0 が消えない
  assert.match(String(first['予約番号']), /^\d{6}$/);
  assert.match(String(first['受付要求ID']), /^seed-/);
  const night = res.find((x) => x['コマID'] === 'S4');
  assert.equal(night['料金合計'], 600);
  assert.equal(night['終了日時'], '2025-11-10T08:00:00+09:00'); // 夜は翌朝 8時まで
  // 予約番号は重ならない。割当ては 1日1コマに 91・92 の2台
  assert.equal(new Set(res.map((x) => String(x['予約番号']))).size, res.length);
  const alc = rows(env, '割当て');
  assert.deepEqual([...new Set(alc.map((x) => String(x['駐車場'])))].sort(), ['91', '92']);
  assert.ok(alc.every((x) => x['状態'] === '有効'));
  assert.ok(rows(env, '通知').every((x) => x['状態'] === '電話連絡済み'));
  // 台帳の不変条件（二重の割当て・台数の超過など）を満たす
  const inv = env.check();
  assert.ok(inv.ok, JSON.stringify(inv.violations));
}));

test('3年分：8,760件を入れる。入れ直すと前の試験データは消える。保管と主な処理が動く', async () => withSeedEnv(async (env) => {
  await editor(env, 'testSeed_1year');
  const r = await editor(env, 'testSeed_3years');
  assert.equal(r.value.status, 'OK', JSON.stringify(r.value));
  assert.equal(r.value.removed['予約'], 2920);
  assert.equal(r.value.added, 1095 * 4 * 2);
  assert.equal(rows(env, '予約').length, 8760);
  assert.equal(rows(env, '操作履歴').length, 8760);
  assert.ok(env.check().ok, JSON.stringify(env.check().violations));

  // 管理者の画面の処理が、3年分の台帳で動く
  const list = await asAdmin(env, 'api_admin_list', { text: '過去' });
  assert.equal(list.value.status, 'OK');
  assert.equal(list.value.reservations.length, 8760);
  const calls = await asAdmin(env, 'api_admin_callList');
  assert.equal(calls.value.status, 'OK');

  // 保管（job_archiveLedger）：60日より前の分が保管のシートへ移る
  const a = await env.host.run('job_archiveLedger', [], { kind: 'trigger' });
  assert.equal(a.value.status, 'OK', JSON.stringify(a.value));
  assert.equal(a.value.moved, (1095 - 60) * 8);
  assert.equal(rows(env, '予約').length, 60 * 8);
  assert.equal(rows(env, '予約（保管）').length, (1095 - 60) * 8);

  // 保管の後で消すと、保管のシートの分も消える。「保管」の操作履歴は残る
  const c = await editor(env, 'testSeed_clear');
  assert.equal(c.value.status, 'OK');
  for (const name of ['予約', '割当て', '通知', '予約（保管）', '割当て（保管）', '通知（保管）']) assert.equal(rows(env, name).length, 0, name);
  const log = rows(env, '操作履歴');
  assert.equal(log.length, 1);
  assert.equal(log[0]['操作'], '保管');
  assert.equal(c.value.rows.seed, 0);
}));

test('夜中の保管の確かめ用：70〜64日前の7日分を入れ、保管で全て移る', async () => withSeedEnv(async (env) => {
  const r = await editor(env, 'testSeed_nightArchive');
  assert.equal(r.value.status, 'OK', JSON.stringify(r.value));
  assert.equal(r.value.added, 56);
  const dates = rows(env, '予約').map((x) => String(x['利用日']));
  assert.equal(dates[0], '2026-08-31'); // 70日前
  assert.equal(dates[dates.length - 1], '2026-09-06'); // 64日前
  const a = await env.host.run('job_archiveLedger', [], { kind: 'trigger' });
  assert.equal(a.value.moved, 56);
  assert.ok(rows(env, '操作履歴').some((x) => x['操作'] === '保管'));
}));

test('測定：主な処理の時間をログに出し、測定の予約は取消し済みで残り、消すと無くなる', async () => withSeedEnv(async (env) => {
  await editor(env, 'testSeed_1year');
  const r = await editor(env, 'testSeed_measure');
  assert.ok(r.ok, JSON.stringify(r.error));
  const v = r.value;
  assert.equal(v.status, 'OK');
  const names = v.items.map((x) => x.name);
  for (const n of ['住民の空き状況（1か月）', '管理者の台帳（1週間）', '管理者の予約一覧（1週間）', '電話連絡の一覧', '名前で探す', '電話の登録（1件。予約表の作り直しを含む）', '取消し（1件。予約表の作り直しを含む）']) {
    assert.ok(names.includes(n), n);
  }
  for (const x of v.items) {
    assert.ok(x.ok, `${x.name}: ${x.note}`);
    assert.equal(typeof x.medianMs, 'number');
    assert.equal(x.allMs.length, 5);
  }
  assert.ok(r.logs.some((l) => String(l.message || l).includes('| 電話の登録')), 'ログに表の形で出る');
  // 測定の予約（10件）は全て取消し済み。空きは減っていない
  const measure = rows(env, '予約').filter((x) => String(x['受付要求ID']).startsWith('seed-measure'));
  assert.equal(measure.length, 10);
  assert.ok(measure.every((x) => x['状態'] === '取消済み'));
  assert.ok(rows(env, '割当て').filter((x) => String(x['利用日']) === v.target.date).every((x) => x['状態'] === '解放'));
  assert.ok(env.check().ok, JSON.stringify(env.check().violations));

  await editor(env, 'testSeed_clear');
  assert.equal(rows(env, '予約').length, 0);
  assert.equal(rows(env, '操作履歴').length, 0);
}));

test('消すのは試験データだけ。住民・管理者が画面から入れた予約は残る', async () => withSeedEnv(async (env) => {
  const R = ACTORS.residents;
  const mine = await env.adapter.submit(env.host, env.req(R[0], { date: '2026-11-20', slotId: 'S2' }), R[0]);
  assert.equal(mine.status, 'CONFIRMED');
  const phone = await env.adapter.adminRegister(env.host, { ...env.req(R[1], { date: '2026-11-21', slotId: 'S3' }), channel: 'PHONE', email: undefined }, ACTORS.admin);
  assert.equal(phone.status, 'CONFIRMED');
  await editor(env, 'testSeed_1year');
  await editor(env, 'testSeed_measure');
  const c = await editor(env, 'testSeed_clear');
  assert.equal(c.value.status, 'OK');
  const left = rows(env, '予約').map((x) => String(x['予約番号'])).sort();
  assert.deepEqual(left, [mine.reservationId, phone.reservationId].sort());
  assert.equal(rows(env, '割当て').length, 2);
  assert.equal(rows(env, '通知').length, 2);
  assert.deepEqual(rows(env, '操作履歴').map((x) => x['操作']), ['代行登録']);
  assert.ok(env.check().ok, JSON.stringify(env.check().violations));
}));

test('貼り忘れても害が無い：持ち主でない人が画面から呼んでも、何もしない', async () => withSeedEnv(async (env) => {
  await editor(env, 'testSeed_1year');
  const before = rows(env, '予約').length;
  const fns = ['testSeed_clear', 'testSeed_1year', 'testSeed_3years', 'testSeed_nightArchive', 'testSeed_measure', 'testSeed_status'];
  for (const user of [null, ACTORS.residents[0].email, ACTORS.admin.email]) {
    for (const fn of fns) {
      const r = await env.host.run(fn, [], { kind: 'client', user });
      assert.ok(r.ok, `${fn}: ${JSON.stringify(r.error)}`);
      assert.equal(r.value.status, 'DENIED', `${fn} (${user})`);
    }
  }
  // 内部の関数（名前が _ で終わる）は、画面から呼べない
  const hidden = await env.host.run('testSeedClear_', [], { kind: 'client', user: null });
  assert.equal(hidden.ok, false);
  assert.equal(rows(env, '予約').length, before);
  assert.equal(rows(env, '予約').filter((x) => String(x['受付要求ID']).startsWith('seed-measure')).length, 0);
}));

test('貼り忘れても害が無い：台帳の名前に「試験」が無ければ、持ち主が実行しても何もしない', async () => withSeedEnv(async (env) => {
  // 本番の台帳を別に作り、SPREADSHEET_ID をそちらへ向ける
  const prod = 'SS_PROD_1';
  env.host.createSpreadsheet({ id: prod, name: '駐車場予約 台帳（本番）' });
  env.host.setScriptProperties({ SPREADSHEET_ID: prod });
  const s = await env.host.run('setup_init', [REAL_TEST_RULES, []], { kind: 'editor' });
  assert.equal(s.value.status, 'OK');
  const reg = await env.adapter.adminRegister(env.host, { ...env.req(ACTORS.residents[2], { date: '2026-11-22', slotId: 'S1' }), channel: 'PHONE', email: undefined }, ACTORS.admin);
  assert.equal(reg.status, 'CONFIRMED');
  for (const fn of ['testSeed_clear', 'testSeed_1year', 'testSeed_3years', 'testSeed_nightArchive', 'testSeed_measure', 'testSeed_status']) {
    const r = await editor(env, fn);
    assert.equal(r.value.status, 'DENIED', fn);
    assert.match(r.value.reason, /試験/);
    // 持ち主が自分でウェブアプリを開いて呼んだ場合も同じ
    const w = await env.host.run(fn, [], { kind: 'client', user: env.host.owner });
    assert.equal(w.value.status, 'DENIED', `${fn}（持ち主がウェブアプリから）`);
  }
  const p = env.host.dumpSheet(prod, '予約').rows;
  assert.equal(p.length, 1);
  assert.equal(String(p[0]['予約番号']), reg.reservationId);
}));

test('状態の確認：日本時間・設定・メールの残り・行数をログに出す（手順書 T02）', async () => withSeedEnv(async (env) => {
  const r = await editor(env, 'testSeed_status');
  assert.equal(r.value.status, 'OK', JSON.stringify(r.value));
  assert.equal(r.value.today, '2026-11-09');
  assert.equal(r.value.timeZone, 'Asia/Tokyo');
  assert.equal(r.value.rules.residentBooking, true);
  assert.equal(r.value.rules.residentLookup, true);
  assert.equal(typeof r.value.mailRemainingToday, 'number');
  assert.equal(r.value.rows.seed, 0);
  assert.ok(r.logs.some((l) => String(l.message || l).includes('"timeZone":"Asia/Tokyo"')));
}));
