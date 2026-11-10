'use strict';
// 画面試験の部品(ui-helpers)が動くことの確認。最小実装の画面を相手に、通信断を再現する。
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('../../tests/ui/ui-helpers');

test('ui-helpers: 応答を落とすと画面は「結果不明」を示し、台帳には1件だけ確定している', async (t) => {
  const ui = await openApp({ device: 'iPhone SE' });
  t.after(() => ui.close());
  const f = ui.frame();
  await f.getByLabel('利用日').fill('2026-10-27');
  await f.getByRole('button', { name: '空きを見る' }).click();
  await ui.waitIdle();
  await f.getByRole('button', { name: /S2/ }).click();
  await f.getByLabel('お名前').fill('井上真理');
  await f.getByLabel('部屋番号').fill('110');
  ui.dropNextResponse('submit');
  await f.getByRole('button', { name: '申し込む' }).click();
  await ui.waitIdle();
  assert.match(await f.locator('#result').innerText(), /不明/);
  const rows = ui.app.host.dumpSheet(ui.app.spreadsheetId, 'Reservations').rows.filter((r) => r.name === '井上真理');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'CONFIRMED');
  assert.deepEqual(ui.pageErrors, []);
  await ui.shot('selftest-ui-drop');
});
