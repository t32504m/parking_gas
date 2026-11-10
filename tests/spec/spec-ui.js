'use strict';
// 画面試験の部品（本番の既定の設定で開く）。tests/ui/ui-helpers.js は受入試験の前提で開くので使わない。
const { loadPlaywright } = require('../../harness/web/pw');
const { startWebApp } = require('../../harness/web/server');
const { createSpecEnv, CONTRACT } = require('./spec-env');

async function openSpecApp(o = {}) {
  const env = await createSpecEnv(o);
  if (o.before) await o.before(env);
  const web = await startWebApp(env.host, { adminPath: CONTRACT.ui.adminPath });
  const pw = loadPlaywright();
  const b = await pw.chromium.launch();
  const ctx = await b.newContext({ ...pw.devices[o.device || 'iPhone SE'], locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
  await ctx.addCookies([{ name: 'harness_user', value: '', url: web.url }]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(web.url + (o.path || CONTRACT.ui.userPath));
  const ui = {
    env, page, errors,
    frame: () => page.frame({ name: 'userHtmlFrame' }),
    async waitIdle(timeout = 8000) {
      const t0 = Date.now();
      await page.waitForTimeout(80);
      while (Date.now() - t0 < timeout) {
        const n = await ui.frame().evaluate(() => window.__harnessPending || 0).catch(() => 0);
        if (!n) return;
        await page.waitForTimeout(50);
      }
      throw new Error('応答待ちがタイムアウト');
    },
    async text() { return ui.frame().evaluate(() => document.body.innerText); },
    async close() { await ctx.close().catch(() => {}); await b.close().catch(() => {}); await web.close(); await env.host.close(); },
  };
  await ui.waitIdle();
  return ui;
}
module.exports = { openSpecApp };
