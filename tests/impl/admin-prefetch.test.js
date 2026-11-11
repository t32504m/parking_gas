'use strict';
// 管理者の週の表：2か月分を先に読む・週が月をまたぐときは表を分ける・「次の月」（D-038）
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startStatic } = require('../../tools/serve-static');

const DESKTOP = { width: 1280, height: 720 };
const gasCalls = (s, fn) => s.calls.filter((c) => !fn || (c.body && c.body.fn === fn)).length;

async function openAdmin(s, browser, viewport) {
  const page = await browser.newPage({ viewport: viewport || DESKTOP });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(s.url + 'admin/');
  await page.fill('#lg-email', s.admin.email);
  await page.fill('#lg-pass', s.admin.secret);
  await page.click('#lg-go');
  await page.waitForSelector('#board table.sheet', { timeout: 15000 });
  return { page, errors };
}
const weekText = (page) => page.locator('#h-week .only-wide').innerText();

test('開いたときに今月と来月を読み、その範囲の週の移動では GAS を呼ばない', async () => {
  const s = await startStatic({}); // 今日は 2026-11-09（月）
  const browser = await chromium.launch();
  try {
    const { page, errors } = await openAdmin(s, browser);
    assert.equal(gasCalls(s, 'api_admin_week'), 1, '開いたときの読込みが1回でない');
    const q = s.calls.find((c) => c.body.fn === 'api_admin_week').body.args[1];
    assert.deepEqual(q, { from: '2026-11-01', to: '2026-12-31' });
    const before = s.calls.length;
    for (let i = 0; i < 5; i++) await page.click('#next'); // 12/14 の週まで
    assert.match(await weekText(page), /12月14日/);
    assert.equal(s.calls.length, before, '読んである月の中で週を送ったのに、GAS を呼んだ');
    await page.click('#this');
    assert.match(await weekText(page), /11月9日/);
    assert.equal(s.calls.length, before);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await s.close(); }
});

test('週が月をまたぐときは、月ごとに表を分けて見出しを付ける。またがない週は表1つで見出しなし', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page } = await openAdmin(s, browser);
    assert.equal(await page.locator('#board table.sheet').count(), 1);
    assert.equal(await page.locator('#board .month-h').count(), 0);
    for (let i = 0; i < 3; i++) await page.click('#next'); // 11/30（月）〜12/6（日）
    assert.match(await weekText(page), /11月30日/);
    assert.equal(await page.locator('#board table.sheet').count(), 2);
    assert.deepEqual(await page.locator('#board .month-h').allInnerTexts(), ['11月', '12月']);
    const rows = await page.locator('#board table.sheet').evaluateAll((ts) => ts.map((t) => t.querySelectorAll('tbody tr').length));
    assert.deepEqual(rows, [1, 6], '11月の表に1日、12月の表に6日でない');
    // 2つの表は離れている
    const [a, b] = await page.locator('#board table.sheet').evaluateAll((ts) => ts.map((t) => t.getBoundingClientRect()));
    assert.ok(b.top - a.bottom >= 16, '月の表どうしが離れていない');
  } finally { await browser.close(); await s.close(); }
});

test('スマホ幅で週が月をまたぐときは、日のタブの月が変わる所に月の札が入る', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page } = await openAdmin(s, browser, { width: 375, height: 812 });
    for (let i = 0; i < 3; i++) await page.click('#next');
    await page.waitForSelector('.daytabs .dt-month');
    assert.deepEqual(await page.locator('.daytabs .dt-month').allInnerTexts(), ['12月']);
  } finally { await browser.close(); await s.close(); }
});

test('「次の月」：来月の1日がある週へ移る。読んでいない月へ行くときだけ1か月分を読み、その後の週送りは待たない', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page } = await openAdmin(s, browser);
    const n0 = gasCalls(s, 'api_admin_week');
    await page.click('#nextm'); // 11/9 の週 → 12/1（火）がある 11/30 の週
    assert.match(await weekText(page), /11月30日/);
    assert.equal(gasCalls(s, 'api_admin_week'), n0, '読んである来月へ移るのに GAS を呼んだ');
    await page.click('#nextm'); // 週の終わりは 12/6 → 1/1（金）がある 12/28 の週
    await page.waitForFunction(() => /12月28日/.test(document.querySelector('#h-week').innerText));
    await page.waitForSelector('#board .month-h');
    assert.equal(gasCalls(s, 'api_admin_week'), n0 + 1);
    const q = s.calls.filter((c) => c.body.fn === 'api_admin_week').pop().body.args[1];
    assert.deepEqual(q, { from: '2027-01-01', to: '2027-01-31' }, '読んでいない1月だけを読んでいない');
    await page.click('#next');
    assert.match(await weekText(page), /1月4日/);
    assert.equal(gasCalls(s, 'api_admin_week'), n0 + 1);
    // 予約表（月の表）では「次の月」のボタンは出ない（前の月・次の月が既にある）
    await page.getByRole('button', { name: '予約表', exact: true }).click();
    await page.waitForSelector('table.xsheet');
    assert.equal(await page.isVisible('#nextm'), false);
  } finally { await browser.close(); await s.close(); }
});

test('登録したら、見ている週の月を読み直し、表は消さずに新しい予約を出す', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page } = await openAdmin(s, browser);
    const n0 = gasCalls(s, 'api_admin_week');
    await page.click('button[aria-label="11月13日（金） A 朝 8〜11時 92番 空き"]');
    await page.fill('#r-name', '先読 試験');
    await page.fill('#r-room', '201');
    await page.fill('#r-phone', '０９０１１１１２２２２');
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await page.getByRole('button', { name: '登録する', exact: true }).click();
    await page.waitForSelector('button[aria-label="11月13日（金） A 朝 8〜11時 92番 先読 試験さん"]', { timeout: 15000 });
    assert.equal(gasCalls(s, 'api_admin_week'), n0 + 1, '登録の後に読み直していない');
    assert.equal(await page.locator('#board table.sheet').count(), 1);
    // 電話番号はそろえて保存される（D-039）
    const row = s.app.host.dumpSheet(s.app.spreadsheetId, '予約').rows.find((r) => r['氏名'] === '先読 試験');
    assert.equal(row['電話番号'], '090-1111-2222');
  } finally { await browser.close(); await s.close(); }
});

test('読んでいる間に予約表へ切り替えても、後から届いた週の表で月の表を上書きしない', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: DESKTOP });
    let release;
    const gate = new Promise((ok) => { release = ok; });
    await page.route('**/gas', async (route) => {
      const body = route.request().postData() || '';
      if (body.includes('api_admin_week')) await gate;
      await route.continue();
    });
    await page.goto(s.url + 'admin/');
    await page.fill('#lg-email', s.admin.email);
    await page.fill('#lg-pass', s.admin.secret);
    await page.click('#lg-go');
    await page.waitForSelector('#sheetview:visible');
    await page.click('#sheetview');
    await page.waitForSelector('table.xsheet', { timeout: 15000 });
    release();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('table.xsheet').count(), 1, '月の表が上書きされた');
    assert.equal(await page.locator('#board table.sheet').count(), 0);
  } finally { await browser.close(); await s.close(); }
});

test('予約表を読んでいる間に「今週」へ戻っても、後から届いた予約表で週の表を上書きしない', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page } = await openAdmin(s, browser);
    let release;
    const gate = new Promise((ok) => { release = ok; });
    await page.route('**/gas', async (route) => {
      if ((route.request().postData() || '').includes('api_admin_monthTable')) await gate;
      await route.continue();
    });
    await page.click('#sheetview');
    await page.waitForFunction(() => /予約表/.test(document.querySelector('#h-week').innerText));
    await page.click('#this');
    await page.waitForSelector('#board table.sheet');
    release();
    await page.waitForTimeout(800);
    assert.equal(await page.locator('#board table.sheet').count(), 1, '週の表が予約表で上書きされた');
    assert.equal(await page.locator('table.xsheet').count(), 0);
  } finally { await browser.close(); await s.close(); }
});
