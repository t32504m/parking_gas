'use strict';
// 外に置く管理者の画面（tools/build-static.js が作る admin/index.html、D-034・D-035）の試験。
// tests/ui/admin.ui.test.js と同じ操作・同じ確かめ方を、GAS の外の画面（tools/serve-static.js の
// startStatic で起こした静的 HTML + doPost への fetch）で行う。
// 日付は tools/preview-scenario.json の now（2026-11-09＝月曜）を今日として選ぶ。
//   この週（11/9〜11/15）の台帳の前提（startStatic の既定設定＝1コマ2台・1回1台）：
//   11/14 A 朝(S1)=1台だけ（91番）、11/14 B 昼(S2)=空、11/14 D 夜(S4)=2台で満、
//   11/15 は全コマ2台で満、11/11・11/12・11/13 は全コマ空。
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium, devices } = require('playwright');
const { startStatic } = require('../../tools/serve-static');
const { ACTORS, reqFor } = require('../helpers');

const DESKTOP = { viewport: { width: 1280, height: 720 }, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };
const PHONE = { ...devices['iPhone SE'], locale: 'ja-JP', timezoneId: 'Asia/Tokyo' };

/** メールアドレスとパスコードを入れて「確認して進む」を押す。前後の空白はサーバー側で無視される */
async function login(page, email, secret) {
  await page.getByLabel('メールアドレス').fill(email);
  await page.getByLabel('パスコード').fill(secret);
  await page.getByRole('button', { name: '確認して進む' }).click();
  // 応答を待つ：成功ならアプリ区が見え、失敗ならフォームが使える状態に戻る
  await page.waitForFunction(() => {
    var app = document.getElementById('app');
    var go = document.getElementById('lg-go');
    return (app && !app.hidden) || (!!go && !go.disabled);
  }, undefined, { timeout: 15000 });
}

/** 画面の印（sessionStorage の adminToken）。サーバー側の関数を確かめるときに使う */
function tokenOf(page) {
  return page.evaluate(() => window.sessionStorage.getItem('adminToken'));
}

/** expect 相当の繰り返し待ち（true になるまで 50ms ごとに見る） */
async function waitUntil(fn, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 試験ごとの開始：静的サーバー＋ブラウザ＋管理者画面。必ず closeAll で閉じる */
async function open(s, browser, device) {
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(s.url + 'admin/');
  return { ctx, page, errors };
}
async function closeAll(browser, s) {
  await browser.close().catch(() => {});
  await s.close().catch(() => {});
}

test('[S-UI-07] 外の画面の台帳の空き枠を押して、電話受付の予約をメールなしで代行登録できる', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(s, browser, PHONE);
    await login(page, s.admin.email, s.admin.secret);
    // 確認後の台帳で、スマホの画面幅からはみ出さない（横スクロールしない）
    await page.locator('#board .cell').first().waitFor();
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(sw[0] <= sw[1] + 1, `台帳の画面が横にはみ出す（${sw[0]}px > ${sw[1]}px）`);
    // スマホでは日付を選ぶと、その日の台帳に予約者の名字が並ぶ
    await page.getByRole('button', { name: /^11月14日（土） 空き\d+$/ }).click();
    assert.equal(await page.getByRole('button', { name: /^11月14日（土） 空き\d+$/ }).getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('#board button.cell.taken').count() > 0, '選んだ日の予約者が台帳に出ない');
    await page.getByRole('button', { name: '11月14日（土） B 昼 11〜14時 93番 空き' }).click();
    assert.equal(await page.getByRole('button', { name: '電話', exact: true }).getAttribute('aria-pressed'), 'true', '受付の既定は電話');
    await page.getByLabel('お名前').fill('中村 実');
    await page.getByLabel('棟').fill('B棟');
    await page.getByLabel('部屋番号').fill('205');
    await page.getByLabel('電話番号').fill('090-1212-3434');
    await page.getByRole('button', { name: '確認へ進む' }).click();
    const sum = await page.locator('#panel .kv').innerText();
    assert.match(sum, /電話/); assert.match(sum, /中村 実/); assert.match(sum, /メール\s*なし/);
    await page.getByRole('button', { name: '登録する', exact: true }).click();
    await page.getByRole('heading', { name: '登録しました' }).waitFor();
    const no = (await page.locator('.ticket .no').innerText()).trim();
    assert.match(no, /^\d{6}$/);
    assert.match(await page.locator('#panel').innerText(), new RegExp(no.split('').join(' ')));
    const row = s.app.host.dumpSheet(s.app.spreadsheetId, '予約').rows.find((r) => String(r['予約番号']) === no);
    assert.equal(row['受付経路'], 'PHONE');
    assert.equal(row['電話番号'], '090-1212-3434');
    assert.match(String(row['登録者']), /手元の管理者/);
    const alc = s.app.host.dumpSheet(s.app.spreadsheetId, '割当て').rows.find((r) => String(r['予約番号']) === no);
    assert.equal(String(alc['駐車場']), '93', '押した区画に割り当てられていない');
    // 電話口で伝えたら「本人に伝えた」。予約番号は画面に残り、電話連絡の数は増えない
    const callReqs = () => s.calls.filter((c) => c.body && c.body.fn === 'api_admin_callList').length;
    const c0 = callReqs();
    await page.getByRole('button', { name: '本人に伝えた' }).click();
    assert.ok(await waitUntil(() => {
      const n = s.app.host.dumpSheet(s.app.spreadsheetId, '通知').rows.find((r) => String(r['予約番号']) === no);
      return !!n && String(n['状態']) === '電話連絡済み';
    }), 'サーバー側で本人に伝えたにならない');
    assert.match(await page.locator('#panel .ticket .no').innerText(), new RegExp(no));
    assert.ok(await waitUntil(() => callReqs() > c0), '電話連絡のバッジを数え直さない');
    assert.equal((await page.locator('#calls-n').innerText()).trim(), '0');
    await page.locator('#r-done').click(); // 閉じると台帳に戻る
    assert.ok(await waitUntil(() => page.getByRole('button', { name: /11月14日（土） B 昼 11〜14時 93番 中村 実さん/ }).count().then((n) => n > 0)), '台帳に反映されていない');
    assert.deepEqual(errors, []);
  } finally { await closeAll(browser, s); }
});

test('[S-UI-08] 外の画面の台帳の名前を押して理由を選んで取り消すと、枠が空きに戻る', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page } = await open(s, browser, DESKTOP);
    await login(page, s.admin.email, s.admin.secret);
    const who = page.getByRole('button', { name: /11月14日（土） A 朝 8〜11時 91番 .+さん/ });
    const name = (await who.getAttribute('aria-label')).match(/91番 (.+)さん/)[1];
    await who.click();
    await page.getByRole('heading', { name: `${name} さん` }).waitFor();
    await page.getByRole('button', { name: 'この予約を取り消す' }).click();
    assert.equal(await page.getByRole('button', { name: '取り消す', exact: true }).isDisabled(), true, '理由を選ぶ前に取り消せる');
    await page.getByRole('button', { name: '本人から電話' }).click();
    await page.getByRole('button', { name: '取り消す', exact: true }).click();
    await page.getByText('取り消しました').waitFor();
    // 台数の数は管理者向けの空き状況にだけある（D-027）。管理者は3つの区画まで数える（D-040）
    const token = await tokenOf(page);
    const av = (await s.app.host.run('api_admin_availability', [{ token }, { from: '2026-11-14', to: '2026-11-14' }], { kind: 'client', user: null })).value;
    assert.equal(av.days[0].slots.find((sl) => sl.slotId === 'S1').remaining, 3, '取り消した枠の残りが戻らない');
    const log = s.app.host.dumpSheet(s.app.spreadsheetId, '操作履歴').rows.find((r) => r['操作'] === '取消し');
    assert.equal(log['理由'], '本人から電話');
    await page.waitForSelector('button[aria-label="11月14日（土） A 朝 8〜11時 91番 空き"]', { timeout: 15000 });
    assert.ok(await page.getByRole('button', { name: '11月14日（土） A 朝 8〜11時 91番 空き' }).count(), '台帳の枠が空きに戻っていない');
  } finally { await closeAll(browser, s); }
});

test('[S-UI-09] 外の画面：資格のない人が管理者画面を開いても、台帳の情報は表示されない', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page } = await open(s, browser, PHONE);
    await page.waitForSelector('#lg-email', { timeout: 15000 });
    const text = await page.locator('body').innerText();
    for (const r of ACTORS.residents.slice(0, 6)) assert.ok(!text.includes(r.name.split(' ')[0]), `${r.name} が見える`);
    await login(page, s.admin.email, 'wrong-passcode');
    await page.getByText('確認できませんでした').waitFor();
    const text2 = await page.locator('body').innerText();
    for (const r of ACTORS.residents.slice(0, 6)) assert.ok(!text2.includes(r.name.split(' ')[0]));
  } finally { await closeAll(browser, s); }
});

/** 締め出し（5回で15分）を入れ直す：スクリプトプロパティ RULES の adminLockout を true にする（D-044） */
function lockoutOn(host) {
  const rules = JSON.parse(host.props.script.get('RULES') || '{}');
  host.setScriptProperties({ RULES: JSON.stringify({ ...rules, adminLockout: true }) });
}

test('[S-UI-09] 外の画面：締め出しを入れたとき（adminLockout: true）、パスコードの前後の空白は無視され、5回続けて間違えると「しばらく確認できません」と分かる', async () => {
  const s = await startStatic({});
  lockoutOn(s.app.host);
  const browser = await chromium.launch();
  try {
    const { page } = await open(s, browser, PHONE);
    await page.waitForSelector('#lg-email', { timeout: 15000 });
    await login(page, s.admin.email, ` ${s.admin.secret}\n`);
    await page.waitForSelector('#board .cell', { timeout: 15000 });
    await page.getByRole('button', { name: '管理を終える' }).click();
    await login(page, s.admin.email, 'wrong-passcode');
    await page.getByText('5回続けて間違えると15分止まります').waitFor();
    for (let i = 1; i < 5; i++) await login(page, s.admin.email, 'wrong-passcode');
    await login(page, s.admin.email, s.admin.secret);
    await page.getByText('しばらく確認できません').waitFor();
  } finally { await closeAll(browser, s); }
});

test('[S-UI-09] 外の画面：既定（締め出しは停止）では、5回続けて間違えた後でも正しいパスコードで入れる', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page } = await open(s, browser, PHONE);
    await page.waitForSelector('#lg-email', { timeout: 15000 });
    for (let i = 0; i < 6; i++) await login(page, s.admin.email, 'wrong-passcode');
    await page.getByText('確認できませんでした').waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes('15分'), '止めていないのに「15分止まります」と出る');
    await login(page, s.admin.email, s.admin.secret);
    await page.waitForSelector('#board .cell', { timeout: 15000 });
  } finally { await closeAll(browser, s); }
});

test('[S-UI-10] 外の画面：電話連絡が必要な件数が見え、一覧で連絡済みにできる', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    // 電話で受けた予約（メール無し）を、外から1件入れておく
    const reg = await s.app.adapter.adminRegister(s.app.host, { ...reqFor(ACTORS.residents[8], { date: '2026-11-12', slotId: 'S1', channel: 'PHONE' }), email: undefined }, s.admin);
    assert.equal(reg.status, 'CONFIRMED');
    const { page } = await open(s, browser, PHONE);
    await login(page, s.admin.email, s.admin.secret);
    await page.waitForFunction(() => document.getElementById('calls-n').textContent === '1', undefined, { timeout: 15000 });
    assert.equal((await page.locator('#calls-n').innerText()).trim(), '1');
    await page.getByRole('button', { name: /電話連絡/ }).click();
    await page.getByText('未対応（1件）').waitFor();
    await page.getByRole('button', { name: '電話した' }).click();
    await page.getByText('未対応（0件）').waitFor();
    await page.getByText('対応済み（1件）').waitFor();
    assert.equal((await page.locator('#calls-n').innerText()).trim(), '0');
  } finally { await closeAll(browser, s); }
});

test('[S-UI-13] 外の画面：住民には2台で満車でも、管理者は残りの93番（3台目）に登録できる。登録に台数の選択は出ない（D-040）', async () => {
  const s = await startStatic({}); // startStatic の既定の設定が本番と同じ（住民には1コマ2台・1回1台）
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(s, browser, DESKTOP);
    await login(page, s.admin.email, s.admin.secret);
    // 11/14 夜は2台入っている。残りの93番は「満」ではなく、押せる空き
    const third = page.getByRole('button', { name: '11月14日（土） D 夜 17時〜翌朝8時 93番 空き' });
    await third.waitFor({ timeout: 15000 });
    assert.equal(await page.locator('#board .cell.cap').count(), 0, '「満」が残っている');
    await third.click();
    await page.getByRole('heading', { name: '登録' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '2台', exact: true }).count(), 0, '台数の選択が出ている');
    assert.equal(await page.getByRole('button', { name: '1台', exact: true }).count(), 0, '台数の選択が出ている');
    assert.equal(await page.getByRole('button', { name: '1台まで', exact: true }).count(), 0, '台数の選択が出ている');
    await page.getByLabel('お名前').fill('三台目 試験');
    await page.getByLabel('部屋番号').fill('303');
    await page.getByLabel('電話番号').fill('090-3333-0003');
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await page.getByRole('button', { name: '登録する', exact: true }).click();
    await page.getByRole('heading', { name: '登録しました' }).waitFor();
    await page.waitForSelector('button[aria-label="11月14日（土） D 夜 17時〜翌朝8時 93番 三台目 試験さん"]', { timeout: 15000 });
    // 住民には、2台の時点から満車のまま
    const res = (await s.app.host.run('api_getAvailability', [{ from: '2026-11-14', to: '2026-11-14' }], { kind: 'client', user: null })).value;
    assert.equal(res.days[0].slots.find((sl) => sl.slotId === 'S4').available, false);
    assert.deepEqual(errors, []);
  } finally { await closeAll(browser, s); }
});

test('[S-UI-14] 外の画面：期間と駐車場を選んで、まとめて使用禁止にでき、台帳に網かけで出て、押すと解除できる', async () => {
  const s = await startStatic({}); // 既定で本番と同じ設定（1コマ2台）
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(s, browser, DESKTOP);
    await login(page, s.admin.email, s.admin.secret);
    // 11/12〜11/13 の93番を、終日止める
    await page.getByRole('button', { name: '使用禁止', exact: true }).click();
    await page.getByRole('button', { name: '期間を決めて使用禁止にする' }).click();
    await page.getByLabel('開始日').fill('2026-11-12');
    await page.getByLabel('終了日').fill('2026-11-13');
    assert.equal(await page.getByRole('button', { name: '終日', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '93番', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '全て', exact: true }).getAttribute('aria-pressed'), 'false');
    await page.getByRole('button', { name: '工事・点検', exact: true }).click();
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await page.getByRole('heading', { name: 'この内容で使用禁止にしますか' }).waitFor();
    const sum = await page.locator('#panel .kv').innerText();
    assert.match(sum, /11月12日（木）〜11月13日（金）/); assert.match(sum, /終日/); assert.match(sum, /93番/);
    assert.equal(s.app.host.dumpSheet(s.app.spreadsheetId, '使用禁止').rows.length, 0, '確かめる前に登録された');
    await page.getByRole('button', { name: '使用禁止にする', exact: true }).click();
    await page.getByRole('heading', { name: '使用禁止にしました' }).waitFor();
    assert.ok(await waitUntil(() => page.locator('#board button.cell.block').count().then((n) => n === 8)), '2日×4時間帯の93番が網かけになっていない');
    assert.equal(await page.locator('#board button.cell.block').count(), 8, '2日×4時間帯の93番が網かけになっていない');
    const row = s.app.host.dumpSheet(s.app.spreadsheetId, '使用禁止').rows[0];
    assert.equal(row['駐車場'], '93');
    // 網かけを押すと中身が出て、解除できる
    await page.getByRole('button', { name: /11月12日（木） A 朝 8〜11時 93番 使用禁止/ }).click();
    await page.getByRole('button', { name: 'この使用禁止を解除する' }).click();
    await page.getByText('解除しました').waitFor();
    assert.ok(await waitUntil(() => page.locator('#board button.cell.block').count().then((n) => n === 0)), '解除した分が台帳に残っている');
    assert.equal(await page.locator('#board button.cell.block').count(), 0, '解除した分が台帳に残っている');
    assert.deepEqual(errors, []);
  } finally { await closeAll(browser, s); }
});

test('[S-UI-15] 外の画面：予約表で月の表を出し、スプレッドシートへの書き出しができる', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(s, browser, DESKTOP);
    await login(page, s.admin.email, s.admin.secret);
    await page.getByRole('button', { name: '予約表', exact: true }).click();
    await page.waitForSelector('table.xsheet thead', { timeout: 15000 });
    assert.equal(await page.getByRole('button', { name: '予約表', exact: true }).getAttribute('aria-pressed'), 'true');
    const head = await page.locator('table.xsheet thead').innerText();
    assert.match(head, /日付[\s\S]*時間帯[\s\S]*駐車場枠91[\s\S]*駐車場枠92[\s\S]*駐車場枠93[\s\S]*申込者[\s\S]*適用/);
    assert.equal(await page.locator('table.xsheet tbody tr').count(), 30 * 4, '11月の行の数が違う');
    // 11/15 の D（夜）は2台満車。2人分の名前が並ぶ
    const night = page.locator('table.xsheet tbody tr').nth(14 * 4 + 3);
    assert.match(await night.innerText(), /D\u300017:00〜翌朝8:00/);
    assert.equal(await night.locator('td:not(.note):not(.s)').evaluateAll((els) => els.filter((e) => e.textContent.trim()).length), 2, '11/15 夜の2人分の名前が並ばない');
    // スプレッドシートに書き出す
    await page.getByRole('button', { name: 'スプレッドシートに書き出す' }).click();
    await page.getByText('「予約表 2026年11月」に書き出しました').waitFor();
    assert.ok(s.app.host.dumpSheet(s.app.spreadsheetId, '予約表 2026年11月'), 'シートが作られていない');
    // 次の月へ移れる。「今月」で台帳（最初の頁）に戻る
    await page.getByRole('button', { name: '次の月' }).click();
    assert.ok(await waitUntil(async () => /2026年12月/.test(await page.locator('#h-week').innerText().catch(() => ''))), '次の月に進めない');
    assert.match(await page.locator('#h-week').innerText(), /2026年12月/);
    await page.getByRole('button', { name: '今月' }).click();
    await page.waitForSelector('#board table.sheet', { timeout: 15000 });
    assert.deepEqual(errors, []);
  } finally { await closeAll(browser, s); }
});

test('[S-UI-18] 外の画面：電話口で先に聞いた名前・部屋番号は、枠を押し直しても、閉じても残り、登録できたら消える', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page, errors } = await open(s, browser, DESKTOP);
    await login(page, s.admin.email, s.admin.secret);
    await page.locator('#board .cell').first().waitFor();
    // まず空いている枠を開いて、名前と部屋番号を聞きながら入れる
    await page.getByRole('button', { name: '11月11日（水） A 朝 8〜11時 91番 空き' }).click();
    await page.getByLabel('お名前').fill('先聞 一郎');
    await page.getByLabel('部屋番号').fill('402');
    // 日と時間帯を聞いて、別の枠を押し直す → 入れた名前は残る
    await page.getByRole('button', { name: '11月12日（木） C 午後 14〜17時 91番 空き' }).click();
    assert.equal(await page.getByLabel('お名前').inputValue(), '先聞 一郎', '枠を押し直すと名前が消える');
    assert.equal(await page.getByLabel('部屋番号').inputValue(), '402');
    assert.match(await page.locator('#panel .pick').innerText(), /11月12日[\s\S]*C 午後/);
    // 閉じてから別の枠を押しても残る
    await page.locator('#close').click();
    await page.getByRole('button', { name: '11月12日（木） D 夜 17時〜翌朝8時 91番 空き' }).click();
    assert.equal(await page.getByLabel('お名前').inputValue(), '先聞 一郎', '閉じると名前が消える');
    await page.getByLabel('電話番号').fill('090-4040-5050');
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await page.getByRole('button', { name: '登録する', exact: true }).click();
    await page.getByRole('heading', { name: '登録しました' }).waitFor();
    assert.match(await page.locator('#panel').innerText(), /先聞 一郎/);
    // 登録できたら、次の電話のために入力は空に戻る
    await page.locator('#r-done').click();
    await page.getByRole('button', { name: '11月11日（水） B 昼 11〜14時 91番 空き' }).click();
    assert.equal(await page.getByLabel('お名前').inputValue(), '', '登録した後も前の名前が残っている');
    assert.equal(await page.getByLabel('電話番号').inputValue(), '');
    assert.deepEqual(errors, []);
  } finally { await closeAll(browser, s); }
});

test('[S-UI-19] 外の画面：予約の名前を押して「変更する」で、日・時間帯・区画を変えられる。満車なら変えずに理由を出す', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    // 11/15 夜は2台入っている。管理者は3台目まで入れられる（D-040）ので、3台目を入れて満車にしておく
    const third = await s.app.adapter.adminRegister(s.app.host, { ...reqFor(ACTORS.residents[9], { date: '2026-11-15', slotId: 'S4', channel: 'PHONE' }), email: undefined }, s.admin);
    assert.equal(third.status, 'CONFIRMED');
    const { page, errors } = await open(s, browser, DESKTOP);
    await login(page, s.admin.email, s.admin.secret);
    await page.locator('#board .cell').first().waitFor();
    const who = page.getByRole('button', { name: /11月14日（土） A 朝 8〜11時 91番 .+さん/ });
    const name = (await who.getAttribute('aria-label')).match(/91番 (.+)さん/)[1];
    await who.click();
    await page.getByRole('button', { name: '変更する', exact: true }).click();
    await page.getByRole('heading', { name: '予約の変更' }).waitFor();
    assert.equal(await page.getByLabel('利用日').inputValue(), '2026-11-14');
    assert.equal(await page.getByRole('button', { name: 'A 朝', exact: true }).getAttribute('aria-pressed'), 'true');
    // 満車の 11/15 D 夜へは変えられない（理由が出て、元のまま）
    await page.getByLabel('利用日').fill('2026-11-15');
    await page.getByRole('button', { name: 'D 夜', exact: true }).click();
    await page.getByRole('button', { name: '確認へ進む' }).click();
    assert.match(await page.locator('#panel .kv').innerText(), /11月14日（土） A 朝[\s\S]*→[\s\S]*11月15日（日） D 夜/);
    await page.getByRole('button', { name: '変更する', exact: true }).click();
    await page.getByRole('heading', { name: '予約の変更' }).waitFor();
    assert.match(await page.locator('#e-out').innerText(), /満車/);
    // 台帳の空き（11/13 D 夜 93番）を押すと、そこが変更先になる
    await page.getByRole('button', { name: '11月13日（金） D 夜 17時〜翌朝8時 93番 空き' }).click();
    assert.equal(await page.getByLabel('利用日').inputValue(), '2026-11-13');
    assert.equal(await page.getByRole('button', { name: 'D 夜', exact: true }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '93番', exact: true }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await page.getByRole('button', { name: '変更する', exact: true }).click();
    await page.getByText('変更しました').waitFor();
    await page.locator('#d-done').click();
    assert.ok(await waitUntil(() => page.getByRole('button', { name: new RegExp(`11月13日（金） D 夜 .* 93番 ${name}さん`) }).count().then((n) => n === 1)), '変更先に出ない');
    assert.equal(await page.getByRole('button', { name: new RegExp(`11月13日（金） D 夜 .* 93番 ${name}さん`) }).count(), 1, '変更先に出ない');
    assert.equal(await page.getByRole('button', { name: '11月14日（土） A 朝 8〜11時 91番 空き' }).count(), 1, '元の枠が空かない');
    assert.deepEqual(errors, []);
  } finally { await closeAll(browser, s); }
});

test('[S-UI-static-1] 外の管理者の画面は、Google のクッキーも、その場所のクッキーも送らない', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext(DESKTOP);
    await ctx.addCookies([{ name: 'probe', value: '1', domain: '127.0.0.1', path: '/' }]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(s.url + 'admin/');
    await login(page, s.admin.email, s.admin.secret);
    await page.waitForSelector('#board .cell', { timeout: 15000 }); // 週の台帳
    await page.getByRole('button', { name: '11月14日（土） B 昼 11〜14時 93番 空き' }).click();
    await page.getByLabel('お名前').fill('外部 太郎');
    await page.getByLabel('棟').fill('C棟');
    await page.getByLabel('部屋番号').fill('901');
    await page.getByLabel('電話番号').fill('090-3456-7890');
    await page.getByRole('button', { name: '確認へ進む' }).click();
    await page.getByRole('button', { name: '登録する', exact: true }).click();
    await page.getByRole('heading', { name: '登録しました' }).waitFor();
    assert.ok((await ctx.cookies()).some((c) => c.name === 'probe'), '試験用のクッキーがページにある（確かめる土台がない）');
    assert.ok(s.calls.length >= 1, 'GAS を呼んでいない');
    for (const c of s.calls) {
      assert.equal(c.cookie, '', 'クッキーを送っている');
      assert.ok(String(c.contentType).startsWith('text/plain'), 'Content-Type が text/plain で始まらない: ' + c.contentType);
      assert.ok(c.body && typeof c.body.fn === 'string', 'fn が文字列でない');
      assert.ok(Array.isArray(c.body.args), 'args が配列でない');
    }
    assert.deepEqual(errors, []);
  } finally { await closeAll(browser, s); }
});

test('[S-UI-static-2] 管理者の印が使えなくなったら、確認の画面に戻る', async () => {
  const s = await startStatic({});
  const browser = await chromium.launch();
  try {
    const { page } = await open(s, browser, DESKTOP);
    await login(page, s.admin.email, s.admin.secret);
    await page.waitForSelector('#board .cell', { timeout: 15000 }); // 週の台帳が出たあと
    // 印を壊す。画面は開いたときに sessionStorage から印を読むので、読み直す（最初の呼び出しで DENIED になる）
    await page.evaluate(() => window.sessionStorage.setItem('adminToken', 'forged'));
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('login').hidden, undefined, { timeout: 15000 });
    assert.ok(await page.locator('#lg-email').isVisible(), 'ログインのフォームが出ない');
    assert.ok(await page.locator('#app').isHidden(), '管理者の画面がまだ見える');
    assert.equal(await page.locator('#board .cell:visible').count(), 0, '台帳の表が見える');
    assert.equal(await page.locator('table.sheet:visible').count(), 0, '台帳の表が見える');
    const text = await page.locator('body').innerText();
    for (const r of ACTORS.residents.slice(0, 6)) assert.ok(!text.includes(r.name.split(' ')[0]), `${r.name} が見える`);
  } finally { await closeAll(browser, s); }
});
