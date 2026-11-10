'use strict';
/**
 * 画面試験（E2E）の共通部品。実装AIは tests/ui/*.ui.test.js をこの部品で書く。
 * 必須の画面試験は contract/ui-tests-required.json。試験名に [UI-xx] を含めること。
 *
 * 例:
 *   const { openApp } = require('./ui-helpers');
 *   test('[UI-01] スマホで予約して予約番号が出る', async (t) => {
 *     const ui = await openApp({ device: 'iPhone SE' });
 *     t.after(() => ui.close());
 *     const f = ui.frame();               // GAS の iframe の中
 *     await f.getByLabel('利用日').fill('2026-10-26');
 *     ...
 *     await ui.waitIdle();                // google.script.run の応答待ち
 *     await ui.shot('UI-01-確定');        // reports/screens/ に保存（後で目で確認できる）
 *   });
 */
const fs = require('fs');
const path = require('path');
const { loadPlaywright } = require('../../harness/web/pw');
const { startApp } = require('../../harness/web/app');

const ROOT = path.join(__dirname, '..', '..');

/**
 * @param {object} o
 * @param {'resident'|'admin'|'anonymous'} [o.as]  誰として開くか（admin は Google ログイン済みの管理者として開く）
 * @param {string} [o.device] Playwright の端末名（'iPhone SE' / 'Pixel 7' など）
 * @param {boolean} [o.scenario] personas/scenario.json の初期予約を入れるか（既定 true）
 */
async function openApp(o = {}) {
  const pw = loadPlaywright();
  const scenario = o.scenario === false ? null : JSON.parse(fs.readFileSync(path.join(ROOT, 'personas', 'scenario.json'), 'utf8'));
  const app = await startApp({ scenario, now: o.now || (scenario && scenario.now), latency: o.latency });
  const b = await pw.chromium.launch();
  const ctx = await b.newContext({ ...pw.devices[o.device || 'iPhone SE'], locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  const actor = o.as === 'admin' ? app.actors.admin : null;
  await ctx.addCookies([{ name: 'harness_user', value: actor ? actor.email : '', url: app.web.url }]);
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(o.as === 'admin' ? app.adminUrl : app.userUrl);
  const ui = {
    app, page, ctx, pageErrors, actor,
    frame: () => page.frame({ name: 'userHtmlFrame' }),
    /** google.script.run の応答が全部返るまで待つ */
    async waitIdle(timeout = 8000) {
      const t0 = Date.now();
      await page.waitForTimeout(50);
      while (Date.now() - t0 < timeout) {
        const n = await ui.frame().evaluate(() => window.__harnessPending || 0).catch(() => 0);
        if (!n) return;
        await page.waitForTimeout(50);
      }
      throw new Error('google.script.run の応答待ちがタイムアウト');
    },
    /** 次のサーバー呼出しの応答を落とす（通信断の再現）。fnPattern で対象を絞れる */
    dropNextResponse(fnPattern) { app.host.faults.bridge = { dropResponse: 1, fnPattern }; },
    /** 次のサーバー呼出しを送る前に落とす */
    dropNextRequest(fnPattern) { app.host.faults.bridge = { dropRequest: 1, fnPattern }; },
    /** サーバー応答を遅らせる（処理中表示・二度押しの確認用） */
    slowServer(ms, fnPattern) { app.host.faults.bridge = { delayMs: ms, fnPattern }; },
    /** 画面の外で別の人が予約する（古い画面の再現） */
    async bookBehindTheScenes(o2) {
      const h = require('../helpers');
      const who = app.actors.residents[11];
      return app.adapter.submit(app.host, h.reqFor(who, o2), who);
    },
    async shot(name) {
      const dir = path.join(ROOT, 'reports', 'screens');
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, `${name.replace(/[\\/:*?"<>|\s]/g, '_')}.png`);
      await page.screenshot({ path: p });
      return p;
    },
    serverCalls: () => app.web.calls.slice(),
    async close() { await ctx.close().catch(() => {}); await b.close().catch(() => {}); await app.close(); },
  };
  return ui;
}

module.exports = { openApp };
