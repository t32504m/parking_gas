'use strict';
// 外に置く住民の画面（D-034・D-035）：tools/build-static.js が作る HTML と、GAS の doPost（webApi_）
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startStatic } = require('../../tools/serve-static');
const { buildPage } = require('../../tools/build-static');
const build = (o) => buildPage('resident', o);

const post = (s, body) => fetch(s.url + 'gas', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).then((r) => r.json());

test('doPost：住民向けの関数と設定を答え、運用・内部の関数は断る。管理者の関数は印が無ければ断る', async () => {
  const s = await startStatic({});
  try {
    const c = await post(s, { fn: 'config' });
    assert.equal(c.status, 'OK');
    assert.match(c.today, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(c.viewFrom > c.today, '住民に見せる最初の日は今日より後');
    const a = await post(s, { fn: 'api_getAvailability', arg: { from: c.viewFrom, to: c.viewFrom } });
    assert.equal(a.status, 'OK');
    const raw = JSON.stringify(a);
    assert.ok(!raw.includes('"remaining"') && !raw.includes('"capacity"'), '住民向けに台数の数を返している');
    for (const fn of ['setup_run', 'setup_init', 'job_archiveLedger', 'job_processNotifications', 'testSeed_all', 'webApi_', 'residentConfig_', 'doGet', 'doPost', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'api_admin_unknown']) {
      assert.equal((await post(s, { fn, args: [{}] })).status, 'DENIED', `${fn} を断らない`);
    }
    for (const fn of ['api_admin_list', 'api_admin_week', 'api_admin_register', 'api_admin_cancel', 'api_admin_exportMonth']) {
      assert.equal((await post(s, { fn, args: [{ token: 'forged' }, {}] })).status, 'DENIED', `${fn} を偽の印で通した`);
    }
    for (const bad of [null, 'x', [], { fn: 1 }, {}]) assert.equal((await post(s, bad)).status, 'DENIED');
    // 本番の設定では、住民の申込みは閉じている
    const sub = await post(s, { fn: 'api_submitReservation', arg: { requestId: 'rq-static-1', date: c.viewFrom, slotId: 'S1', quantity: 1, name: '試験', room: '101', phone: '090-0000-0000' } });
    assert.notEqual(sub.status, 'CONFIRMED');
  } finally { await s.close(); }
});

test('作った HTML に、テンプレートの式と GAS の呼び出しが残らない。GAS の URL の形を確かめる', () => {
  const html = build({ gasUrl: 'https://script.google.com/macros/s/AKfy_abc-123/exec' });
  assert.ok(!/<\?/.test(html));
  assert.ok(html.includes("credentials: 'omit'"), 'ログイン情報を送らない設定が無い');
  assert.ok(html.includes('<meta name="viewport"'));
  for (const bad of ['https://script.google.com/macros/s/abc/dev', 'https://script.google.com/macros/u/0/s/abc/exec', 'https://example.com/exec']) {
    assert.throws(() => build({ gasUrl: bad }), /ウェブアプリ/);
  }
});

test('外の画面：空き状況（○×）・電話のボタン・案内・利用約款が出て、Google のクッキーを送らない', async () => {
  const s = await startStatic({ props: { TERMS: '第1条 試験の約款' } });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(s.url);
    await page.waitForSelector('.sheet tbody tr', { timeout: 15000 });
    const text = await page.textContent('body');
    assert.match(text, /電話で予約する/);
    assert.match(text, /予約時に通知して頂くこと/);
    assert.match(text, /受付時間/);
    const marks = await page.$$eval('.sheet tbody td', (tds) => tds.map((td) => td.textContent + (td.getAttribute('aria-label') || '')).join(''));
    assert.ok(/空き|満車|○|×/.test(marks) || (await page.$$('.sheet tbody td svg, .sheet tbody td .mk')).length > 0, '○×が出ていない');
    // 利用約款
    await page.click('#terms-open');
    assert.match(await page.textContent('#terms-body'), /試験の約款/);
    await page.click('#terms-close');
    // 次の月へ（2回目の読込みも fetch で動く）
    await page.click('#next');
    await page.waitForTimeout(500);
    assert.deepEqual(errors, [], '画面のエラー: ' + errors.join(' / '));
    assert.ok(s.calls.length >= 2, 'GAS を呼んでいない');
    assert.ok(s.calls.every((c) => c.cookie === ''), 'クッキーを送っている');
    // カレンダーの形でも開ける
    await page.goto(s.url + '?layout=calendar');
    await page.waitForSelector('#sheet table, #sheet .cday', { timeout: 15000 });
  } finally { await browser.close(); await s.close(); }
});

test('外の画面：GAS につながらないときは、読み直しのボタンと電話の案内を出す', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    s.failNext(10);
    const page = await browser.newPage();
    await page.goto(s.url);
    await page.waitForSelector('text=空き状況を読み込めませんでした', { timeout: 15000 });
    assert.match(await page.textContent('main'), /理事会事務局/);
  } finally { await browser.close(); await s.close(); }
});
