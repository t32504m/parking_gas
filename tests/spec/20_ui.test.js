'use strict';
// N. 画面（D-019, D-020, D-021, D-022, REQ 9）。本番の既定の設定で開く。
const test = require('node:test');
const assert = require('node:assert/strict');
const { openSpecApp } = require('./spec-ui');
const { PEOPLE, ADMIN } = require('./spec-env');

test('[S-200] 住民の一覧：○×と A〜D だけ。△・個人情報・申込みが無く、11/14〜1/9 を出す', async (t) => {
  const ui = await openSpecApp({
    before: async (env) => {
      await env.register({ date: '2026-11-20', slotId: 'S1', person: PEOPLE[0] });
      await env.register({ date: '2026-11-20', slotId: 'S1', person: PEOPLE[1] });
      await env.register({ date: '2026-11-21', slotId: 'S4', person: PEOPLE[2] });
    },
  });
  t.after(() => ui.close());
  const f = ui.frame();
  let txt = await ui.text();
  assert.ok(txt.includes('11/14') && !txt.includes('11/13') && !txt.includes('11/9\n'), '最初の日が 11/14 でない');
  for (const m of ['A', 'B', 'C', 'D', '○', '×']) assert.ok(txt.includes(m), `${m} が無い`);
  assert.ok(!txt.includes('△'));
  for (const p of PEOPLE.slice(0, 3)) assert.ok(!txt.includes(p.name) && !txt.includes(p.phone) && !txt.includes(p.room), '個人情報が出た');
  assert.ok(!/申し込む|申込み|予約の確認/.test(txt), '申込み・予約の確認の入口が出た');
  // 11/20 の A は×、B は○
  const row20 = await f.evaluate(() => { const r = [...document.querySelectorAll('tr')].find((x) => x.innerText.includes('11/20')); return r ? r.innerText : ''; });
  const marks = row20.match(/[○×]/g) || [];
  assert.deepEqual(marks, ['×', '○', '○', '○'], row20);
  // 住民の画面から押して申し込める枠が無い
  const clickable = await f.evaluate(() => [...document.querySelectorAll('td button:not([disabled]), td a[href]')].length);
  assert.equal(clickable, 0, '時間帯の枠が押せる');
  // 次の月へ進むと、1/9 が最後
  await f.getByRole('button', { name: '次の月' }).click(); await ui.waitIdle();
  await f.getByRole('button', { name: '次の月' }).click(); await ui.waitIdle();
  txt = await ui.text();
  assert.ok(txt.includes('1/9') && !txt.includes('1/10'), '最後の日が 1/9 でない');
  const nx = f.getByRole('button', { name: '次の月' });
  if (await nx.count()) {
    const dis = await nx.isDisabled().catch(() => true);
    if (!dis) { await nx.click(); await ui.waitIdle(); assert.ok(!(await ui.text()).match(/\b2\/\d+\b/), '2か月より先へ進めた'); }
  }
  assert.deepEqual(ui.errors, []);
});

test('[S-201] 住民のカレンダー：範囲の外の日に記号が無く押せない。今日が分かる', async (t) => {
  const ui = await openSpecApp({ path: '/exec?layout=calendar' });
  t.after(() => ui.close());
  const f = ui.frame();
  const cells = await f.evaluate(() => [...document.querySelectorAll('td')].map((td) => ({ t: td.innerText.trim(), btn: !!td.querySelector('button:not([disabled])') })).filter((x) => /^\d+/.test(x.t)));
  assert.ok(cells.length >= 28, `カレンダーの日が見つからない: ${cells.length}`);
  for (const c of cells) {
    const d = Number(c.t.match(/^\d+/)[0]);
    const sym = /[○×]/.test(c.t);
    if (d < 14) { assert.ok(!sym, `11/${d} に記号がある`); assert.ok(!c.btn, `11/${d} が押せる`); }
    else assert.ok(sym, `11/${d} に記号が無い`);
  }
  const today = cells.find((c) => c.t.startsWith('9'));
  assert.ok(today && today.t.includes('今日'), '今日が分からない');
  assert.ok(!(await ui.text()).includes('△'));
});

async function adminLogin(ui) {
  const f = ui.frame();
  await f.fill('#lg-email', ADMIN.email); await f.fill('#lg-pass', ADMIN.secret); await f.click('#lg-go'); await ui.waitIdle();
}

test('[S-202] 管理者の登録の入力は、閉じても・別の枠を押しても残り、登録できたら空になる', async (t) => {
  const ui = await openSpecApp({ device: 'Desktop Chrome', path: '/exec?page=admin' });
  t.after(() => ui.close());
  const f = ui.frame();
  await adminLogin(ui);
  const slot = (d, s, sp) => f.locator(`button[data-date="${d}"][data-slot="${s}"][data-space="${sp}"]`);
  await slot('2026-11-12', 'S2', '91').click(); await ui.waitIdle();
  await f.fill('#r-name', '電話 花子'); await f.fill('#r-room', '305'); await f.fill('#r-phone', '09011112222');
  // 閉じる
  const closeBtn = f.getByRole('button', { name: /閉じる|やめる/ }).first();
  await closeBtn.click(); await ui.waitIdle();
  // 別の枠を押す
  await slot('2026-11-13', 'S4', '92').click(); await ui.waitIdle();
  assert.equal(await f.inputValue('#r-name'), '電話 花子', '閉じて別の枠を押したら、名前が消えた');
  assert.equal(await f.inputValue('#r-room'), '305');
  assert.equal(await f.inputValue('#r-phone'), '09011112222');
  // 登録する
  await f.getByRole('button', { name: /確かめる|次へ|確認/ }).first().click(); await ui.waitIdle();
  await f.click('#r-send'); await ui.waitIdle();
  assert.ok((await ui.text()).includes('登録しました'));
  assert.equal(ui.env.reservations().filter((r) => r['氏名'] === '電話 花子').length, 1);
  await f.click('#r-done'); await ui.waitIdle();
  await slot('2026-11-14', 'S1', '91').click(); await ui.waitIdle();
  assert.equal(await f.inputValue('#r-name'), '', '登録した後も入力が残っている');
  assert.deepEqual(ui.errors, []);
});

test('[S-203] 管理者の画面を資格なしで開いても、台帳の情報が出ない', async (t) => {
  const ui = await openSpecApp({
    device: 'Desktop Chrome', path: '/exec?page=admin',
    before: async (env) => { await env.register({ date: '2026-11-12', person: PEOPLE[5] }); },
  });
  t.after(() => ui.close());
  const f = ui.frame();
  let txt = await ui.text();
  assert.ok(!txt.includes(PEOPLE[5].name));
  await f.fill('#lg-email', ADMIN.email); await f.fill('#lg-pass', 'wrong-pass-0000'); await f.click('#lg-go'); await ui.waitIdle();
  txt = await ui.text();
  assert.ok(!txt.includes(PEOPLE[5].name) && !txt.includes(PEOPLE[5].phone), '違うパスコードで台帳が出た');
  // 画面の切替え（隠した部分を出す）だけでは、台帳の中身は無い
  const hidden = await f.evaluate(() => document.body.innerHTML);
  assert.ok(!hidden.includes(PEOPLE[5].name), '隠れた部分に台帳の情報がある');
});
