'use strict';
// Playwright の読み込み。プロジェクトに入っていなければ、環境に用意されたものを使う。
function loadPlaywright() {
  const tries = ['playwright', '/opt/npm-tools/node_modules/playwright', 'playwright-core'];
  for (const t of tries) {
    try { return require(t); } catch (e) { /* 次へ */ }
  }
  throw new Error('Playwright が見つからない。`npm i -D playwright` の後、`npx playwright install chromium` を実行すること');
}
module.exports = { loadPlaywright };
