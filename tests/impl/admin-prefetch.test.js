'use strict';
// 管理者の台帳の頁（D-038・D-040）：
//   最初の頁だけが特別で、今日を含む週の月曜から来月の終わりまで（今月と来月の表を縦に並べる）。2か月分を1回で読む。
//   「次の月」で来月だけ → 再来月だけ、と1か月ずつ移る（住民の画面と同じ導線）。読んでいない月だけを1か月ずつ読む。
//   来月から「前の月」で最初の頁に戻る。最初の頁から「前の月」で先月だけ。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startStatic } = require('../../tools/serve-static');

const DESKTOP = { width: 1280, height: 720 };
const PHONE = { width: 375, height: 812 };
const gasCalls = (s, fn) => s.calls.filter((c) => !fn || (c.body && c.body.fn === fn)).length;

async function openAdmin(s, browser, viewport) {
  const page = await browser.newPage({ viewport: viewport || DESKTOP });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(s.url + 'admin/');
  await page.fill('#lg-email', s.admin.email);
  await page.fill('#lg-pass', s.admin.secret);
  await page.click('#lg-go');
  await page.waitForSelector('#board table.sheet, #board .daytabs', { timeout: 15000 });
  return { page, errors };
}
const title = (page) => page.locator('#h-week').innerText().then((t) => t.replace(/\s+/g, ''));
const firstDays = (page) => page.locator('#board table.sheet').evaluateAll((ts) => ts.map((t) => {
  const r = t.tBodies[0].rows; return [r[0].cells[0].innerText.split(/\s/)[0], r[r.length - 1].cells[0].innerText.split(/\s/)[0], r.length];
}));

test('最初の頁：今日を含む週の月曜から来月の終わりまで、今月と来月の表を離して縦に並べる。読むのは1回', async () => {
  const s = await startStatic({}); // 今日は 2026-11-09（月）
  const browser = await chromium.launch();
  try {
    const { page, errors } = await openAdmin(s, browser);
    assert.equal(await title(page), '11月・12月');
    assert.equal(gasCalls(s, 'api_admin_week'), 1, '開いたときの読込みが1回でない');
    assert.deepEqual(s.calls.find((c) => c.body.fn === 'api_admin_week').body.args[1], { from: '2026-11-01', to: '2026-12-31' });
    assert.deepEqual(await page.locator('#board .month-h').allInnerTexts(), ['11月', '12月']);
    assert.deepEqual(await firstDays(page), [['11/9', '11/30', 22], ['12/1', '12/31', 31]]);
    const [a, b] = await page.locator('#board table.sheet').evaluateAll((ts) => ts.map((t) => t.getBoundingClientRect()));
    assert.ok(b.top - a.bottom >= 24, '月の表どうしが離れていない');
    // 週を送るボタンは無い
    for (const n of ['前の週', '今週', '次の週']) assert.equal(await page.getByRole('button', { name: n, exact: true }).count(), 0, `「${n}」が残っている`);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await s.close(); }
});

test('「次の月」「前の月」：最初の頁 → 12月だけ → 1月だけ → 12月だけ → 最初の頁 → 10月だけ。読むのは読んでいない月だけ、1か月ずつ', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page, errors } = await openAdmin(s, browser);
    const n0 = gasCalls(s, 'api_admin_week');
    const step = async (id, want, reads) => {
      await page.click(id);
      await page.waitForFunction((w) => document.querySelector('#h-week').innerText.replace(/\s+/g, '') === w, want);
      await page.waitForSelector('#board table.sheet');
      assert.equal(gasCalls(s, 'api_admin_week') - n0, reads, `${want} で読んだ回数が違う`);
    };
    await step('#next', '2026年12月', 0);
    assert.deepEqual(await firstDays(page), [['12/1', '12/31', 31]]);
    assert.equal(await page.locator('#board .month-h').count(), 0, '1か月の頁に月の見出しが出ている');
    await step('#next', '2027年1月', 1);
    assert.deepEqual(s.calls.filter((c) => c.body.fn === 'api_admin_week').pop().body.args[1], { from: '2027-01-01', to: '2027-01-31' }, '1月だけを読んでいない');
    await step('#prev', '2026年12月', 1);
    await step('#prev', '11月・12月', 1);
    assert.equal(await page.locator('#board table.sheet').count(), 2);
    await step('#prev', '2026年10月', 2);
    assert.deepEqual(s.calls.filter((c) => c.body.fn === 'api_admin_week').pop().body.args[1], { from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual(await firstDays(page), [['10/1', '10/31', 31]]);
    await step('#next', '11月・12月', 2);
    // 「今月」はどこからでも最初の頁へ
    await step('#next', '2026年12月', 2);
    await step('#next', '2027年1月', 2);
    await step('#this', '11月・12月', 2);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await s.close(); }
});

test('PC：長い表でも、時間帯と区画の見出しが画面の上に残る', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page } = await openAdmin(s, browser);
    const top = await page.evaluate(async () => {
      const t = document.querySelector('#board table.sheet');
      window.scrollTo(0, t.getBoundingClientRect().top + window.scrollY + 700);
      await new Promise((r) => setTimeout(r, 100));
      return t.tHead.getBoundingClientRect().top;
    });
    assert.ok(Math.abs(top) < 2, `見出しが上に残っていない（${top}）`);
  } finally { await browser.close(); await s.close(); }
});

test('スマホ：日付の札を月ごとに並べ、押した日の表は、その札の列のすぐ下に開く', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page, errors } = await openAdmin(s, browser, PHONE);
    assert.deepEqual(await page.locator('#board .month-h').allInnerTexts(), ['11月', '12月']);
    assert.equal(await page.locator('.daytabs').count(), 2);
    // 最初は今日（11/9）が選ばれ、その列（9〜12日）のすぐ下に表がある
    const after = (d) => page.evaluate((day) => {
      const tab = document.querySelector(`button[data-day="${day}"]`);
      const box = document.getElementById('dt-day');
      const tabs = [...tab.parentElement.querySelectorAll('button.dt')];
      const prev = box.previousElementSibling;
      return { prev: prev && prev.getAttribute('data-day'), sameGrid: box.parentElement === tab.parentElement, row: tabs.indexOf(tab) >> 2, rowOfPrev: tabs.indexOf(prev) >> 2, title: box.querySelector('h3').innerText };
    }, d);
    let a = await after('2026-11-09');
    assert.equal(a.prev, '2026-11-12');
    assert.match(a.title, /11月9日/);
    await page.click('button[data-day="2026-11-18"]'); // 3列目（17〜20日）
    a = await after('2026-11-18');
    assert.ok(a.sameGrid);
    assert.equal(a.row, a.rowOfPrev, '押した札の列の下に開いていない');
    assert.match(a.title, /11月18日/);
    await page.click('button[data-day="2026-12-03"]');
    a = await after('2026-12-03');
    assert.ok(a.sameGrid, '12月の札の下に開いていない');
    assert.match(a.title, /12月3日/);
    assert.equal(await page.locator('#dt-day').count(), 1, '表が2つ開いている');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await s.close(); }
});

test('登録したら、見ている頁の月を読み直し、表は消さずに新しい予約を出す', async () => {
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
    assert.equal(await page.locator('#board table.sheet').count(), 2);
    // 電話番号はそろえて保存される（D-039）
    const row = s.app.host.dumpSheet(s.app.spreadsheetId, '予約').rows.find((r) => r['氏名'] === '先読 試験');
    assert.equal(row['電話番号'], '090-1111-2222');
  } finally { await browser.close(); await s.close(); }
});

test('読んでいる間に予約表へ切り替えても、後から届いた台帳で月の表を上書きしない', async () => {
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

test('予約表を読んでいる間に「今月」へ戻っても、後から届いた予約表で台帳を上書きしない', async () => {
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
    assert.equal(await page.locator('#board table.sheet').count(), 2, '台帳が予約表で上書きされた');
    assert.equal(await page.locator('table.xsheet').count(), 0);
  } finally { await browser.close(); await s.close(); }
});
