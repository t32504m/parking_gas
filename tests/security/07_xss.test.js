'use strict';
// 侵入試験 面D：管理者の画面の XSS（docs/PENTEST.md PT-D1）。Playwright（tests/ui/ui-helpers.js の openApp）を使う。
// 住民が画面を通さずに入れた名前・棟・部屋・メールと、管理者が入れた使用禁止の理由・メモが、
// 管理者の画面のどこに出ても、HTML・スクリプトとして動かないことを確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('../ui/ui-helpers');
const { reqFor } = require('../helpers');

const P = {
  name: '<img src=x onerror=__x=1>',
  name2: '"><svg/onload=__x=2>',
  building: '<svg onload=__x=3>',
  room: "'><b id=pwn>",
  email: '"><img/src=x/onerror=__x=4>@a.jp',
  reason: '<svg onload=__x=6>',
  memo: '</td><img src=x onerror=__x=5>',
};

async function probe(f) {
  await f.waitForTimeout(150); // 画像の onerror は少し後に起きる
  return f.evaluate(() => ({ x: window.__x || 0, pwn: !!document.getElementById('pwn'), tags: document.querySelectorAll('img[src="x"], svg[onload], img[onerror]').length }));
}

test('[PT-D1] 住民・管理者が入れた文字は、管理者の画面のどこに出ても HTML・スクリプトとして動かない', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'Desktop Chrome' });
  t.after(() => ui.close());
  const { app } = ui;
  const A = app.actors.admin;
  // 住民の申込み（画面を通さずに直接）と、管理者の電話の登録（メールなし → 電話連絡の一覧に出る）
  const who = app.actors.residents[10];
  const r1 = await app.adapter.submit(app.host, reqFor(who, { date: '2026-10-20', slotId: 'S1', name: P.name, building: P.building, room: P.room, email: P.email }), who);
  const r2 = await app.adapter.adminRegister(app.host, reqFor(who, { date: '2026-10-20', slotId: 'S2', name: P.name2, building: P.building, room: P.room, email: undefined, channel: 'PHONE' }), A);
  assert.equal(r2.status, 'CONFIRMED');
  const blk = await app.host.run('api_admin_addBlock', [{ email: A.email, secret: A.secret }, { requestId: 'rq-xss-block-1', from: '2026-10-21', to: '2026-10-21', slots: ['S3'], spaces: ['93'], reason: P.reason, memo: P.memo, confirm: true }], { kind: 'client', user: A.email });
  assert.equal(blk.value.status, 'OK');
  const seen = [];
  const check = async (where) => { const p = await probe(ui.frame()); if (p.x || p.pwn || p.tags) seen.push(`${where}: ${JSON.stringify(p)}`); };

  const f = ui.frame();
  await f.getByLabel('メールアドレス').fill(A.email);
  await f.getByLabel('パスコード').fill(A.secret);
  await f.getByRole('button', { name: '確認して進む' }).click();
  await ui.waitIdle();
  await f.locator('#board .cell').first().waitFor();
  await check('週の台帳');

  for (const rid of [r1.reservationId, r2.reservationId].filter(Boolean)) {
    await f.locator(`#board button[data-rid="${rid}"]`).first().click();
    await ui.waitIdle();
    await check(`予約の詳細 ${rid}`);
    const text = await f.locator('#panel').innerText();
    assert.ok(text.includes(P.building) && (text.includes(P.name) || text.includes(P.name2)), `詳細に、入れた文字が文字として出ていない（試験の前提）: ${text.slice(0, 120)}`);
    const edit = f.locator('#e-start');
    if (await edit.count()) { await edit.click(); await ui.waitIdle(); await check(`予約の変更の入力 ${rid}`); }
  }
  await f.locator('#q').fill('img');
  await f.locator('#sf button[type=submit]').click();
  await ui.waitIdle();
  await check('名前で探す');
  await f.locator('#calls').click();
  await ui.waitIdle();
  await check('電話連絡の一覧');
  await f.locator('#blocks').click();
  await ui.waitIdle();
  await check('使用禁止の一覧');
  const rel = f.locator('#panel button[data-release]').first();
  if (await rel.count()) { await rel.click(); await ui.waitIdle(); await check('使用禁止の詳細'); }
  await f.locator('#sheetview').click();
  await ui.waitIdle();
  await f.locator('table.xsheet').first().waitFor();
  await check('予約表（月）');

  assert.deepEqual(seen, [], '管理者の画面で、入れた文字が HTML・スクリプトとして動いた');
  assert.deepEqual(ui.pageErrors, []);
});
