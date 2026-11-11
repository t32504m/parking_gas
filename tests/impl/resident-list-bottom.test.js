'use strict';
// 住民の画面（D-040）：一覧の下にも時間帯の見出しと、前の月・次の月。カレンダーで日を押すと、その日の空きへ滑らかに動く
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { startStatic } = require('../../tools/serve-static');

const PHONE = { viewport: { width: 393, height: 851 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

test('一覧の一番下に、朝・昼・午後・夜の見出しの行がある（A〜D と料金は付けない）', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(PHONE);
    await page.goto(s.url + '?layout=list');
    await page.waitForSelector('#sheet table.sheet tbody tr');
    assert.deepEqual(await page.locator('#sheet table.sheet tfoot th').allInnerTexts(), ['', '朝', '昼', '午後', '夜']);
    const foot = await page.locator('#sheet table.sheet tfoot').innerText();
    assert.doesNotMatch(foot, /[A-D]|円|時/, '下の見出しに A〜D・料金・時刻が入っている');
    // 上の見出しより小さい（行を低くするため）
    const [top, bottom] = await page.evaluate(() => [
      parseFloat(getComputedStyle(document.querySelector('#sheet thead th:nth-child(2)')).fontSize),
      parseFloat(getComputedStyle(document.querySelector('#sheet tfoot th:nth-child(2)')).fontSize),
    ]);
    assert.ok(bottom < top, `下の見出しが小さくない（${bottom} / ${top}）`);
  } finally { await browser.close(); await s.close(); }
});

test('一覧の下でも前の月・次の月へ移れる。移ったら、その月を上から見せる。端の月では押せない', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(PHONE);
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(s.url + '?layout=list');
    await page.waitForSelector('#sheet table.sheet tbody tr');
    assert.equal(await page.locator('#h-month2').innerText(), await page.locator('#h-month').innerText());
    assert.equal(await page.isDisabled('#prev2'), true, '最初の月で「前の月」が押せる');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.click('#next2');
    await page.waitForFunction(() => /12月/.test(document.getElementById('h-month').textContent));
    await page.waitForTimeout(300);
    assert.ok(await page.evaluate(() => document.getElementById('h-month').getBoundingClientRect().top >= -1 && document.getElementById('h-month').getBoundingClientRect().top < 200), '移った月が上から見えていない');
    assert.match(await page.locator('#h-month2').innerText(), /12月/);
    assert.equal(await page.isDisabled('#prev2'), false);
    // カレンダーのときは、下の前・次は出さない（カレンダーの下は、その日の空き）
    await page.goto(s.url + '?layout=calendar');
    await page.waitForSelector('table.cal');
    assert.equal(await page.isVisible('#bottomnav'), false);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await s.close(); }
});

test('カレンダーで日を押すと、下のその日の空きへ、滑らかに（少しずつ）動く', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(PHONE);
    await page.goto(s.url + '?layout=calendar');
    await page.waitForSelector('table.cal button[data-day]');
    await page.locator('table.cal button[data-day]').nth(10).click();
    const ys = [];
    for (let i = 0; i < 12; i++) { ys.push(await page.evaluate(() => Math.round(window.scrollY))); await page.waitForTimeout(50); }
    const end = ys[ys.length - 1];
    assert.ok(end > 100, `その日の空きへ動いていない（${ys}）`);
    assert.ok(ys.some((y) => y > 0 && y < end - 20), `一度に飛んだ（${ys}）`);
    // その日の見出しが画面の上に来る（ページの終わりで、それ以上は動けないときは、見出しが画面の中に見えている）
    const r = await page.evaluate(() => ({ top: document.getElementById('h-day').getBoundingClientRect().top, atEnd: Math.ceil(window.scrollY + window.innerHeight) >= document.documentElement.scrollHeight - 2, h: window.innerHeight }));
    assert.ok(Math.abs(r.top) < 4 || (r.atEnd && r.top >= 0 && r.top < r.h / 2), `その日の見出しが見えていない（${JSON.stringify(r)}）`);
  } finally { await browser.close(); await s.close(); }
});

test('動きを減らす設定の端末では、滑らかにせず、すぐに動く', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ ...PHONE, reducedMotion: 'reduce' });
    await page.goto(s.url + '?layout=calendar');
    await page.waitForSelector('table.cal button[data-day]');
    await page.locator('table.cal button[data-day]').nth(10).click();
    const y = await page.evaluate(() => Math.round(window.scrollY));
    assert.ok(y > 100, `すぐに動いていない（${y}）`);
  } finally { await browser.close(); await s.close(); }
});
