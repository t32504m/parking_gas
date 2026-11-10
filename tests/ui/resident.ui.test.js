'use strict';
// 利用者画面の試験（contract/ui-tests-required.json の UI-01〜UI-06、と本番の設定での表示 UI-12）
//
// 住民の画面の既定は縦の一覧（会合で評判が良かった）。画面の切替えでカレンダーの形も選べる（D-021）。
// UI-01〜UI-06 は「住民が画面から申し込める」設定（受入試験の前提。contract/adapter.js の HARNESS_PREMISE）で、
// 住民の受付を開いたときの申込みの流れを確かめる。今の本番（住民の受付は閉じる・1コマ2台）は UI-12 で確かめる（D-014・D-015）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./ui-helpers');
const { RULES } = require('../helpers');

const WD = '日月火水木金土';
const SLOT_LABEL = { S1: 'A 朝', S2: 'B 昼', S3: 'C 午後', S4: 'D 夜' };
/** 2026-10-26 → 10月26日（月） */
function md(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}月${d}日（${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}
/** 一覧の枠（押せる・押せないにかかわらず。読み上げの名前で探す） */
const slotAt = (f, date, slot) => f.locator(`#sheet [aria-label^="${md(date)} ${SLOT_LABEL[slot]} "]`);
/** 申し込める枠（押せる） */
const cell = (f, date, slot) => f.locator(`#sheet button[data-date="${date}"][data-slot="${slot}"]`);

/** 一覧で時間帯を押す */
async function pickSlot(f, date, slot) {
  await cell(f, date, slot).click();
}

/** 枠を選び、入力して確認画面まで進める */
async function fillUntilConfirm(ui, { date, slot, quantity = 1, name = '試験 太郎', room = '101', phone = '090-1111-2222', email = '' }) {
  const f = ui.frame();
  await pickSlot(f, date, slot);
  if (quantity > 1) await f.getByRole('button', { name: `${quantity}台`, exact: true }).click();
  await f.getByLabel('お名前').fill(name);
  await f.getByLabel('部屋番号').fill(room);
  await f.getByLabel('電話番号').fill(phone);
  if (email) await f.getByLabel(/^メール/).fill(email);
  await f.getByRole('button', { name: '確認へ進む' }).click();
  await f.getByRole('heading', { name: 'この内容で申し込みますか' }).waitFor();
}

function confirmedRows(ui, name) {
  return ui.app.host.dumpSheet(ui.app.spreadsheetId, '予約').rows.filter((r) => r['氏名'] === name && r['状態'] === '確定');
}

test('[UI-01] スマホで一覧の時間帯を押して申し込むと、予約番号つきの確定表示が出る', async (t) => {
  const ui = await openApp({ device: 'iPhone SE' });
  t.after(() => ui.close());
  const f = ui.frame();
  await ui.waitIdle();
  // 1行が1日。時間帯ごとに空き具合の記号（台数は出さない）。見出しに時間と料金
  const head = await f.locator('#sheet thead').innerText();
  assert.match(head, /朝[\s\S]*8〜[\s\S]*11時[\s\S]*300円[\s\S]*夜[\s\S]*17時〜[\s\S]*翌朝8時[\s\S]*600円/);
  // 記号は○と×の2つだけ（△は分かりにくいため使わない）。1台入っているコマも、空きがあれば○
  assert.match(await slotAt(f, '2026-10-26', 'S1').getAttribute('aria-label'), /空き$/);
  assert.match(await slotAt(f, '2026-10-26', 'S1').innerText(), /○/);
  assert.match(await slotAt(f, '2026-10-26', 'S4').getAttribute('aria-label'), /空き$/);
  assert.match(await slotAt(f, '2026-10-26', 'S4').innerText(), /○/);
  assert.doesNotMatch(await f.locator('#sheet').innerText(), /\d台/, '台数が出ている');
  assert.doesNotMatch(await f.locator('#sheet').innerText(), /△/, '△が出ている');
  await fillUntilConfirm(ui, { date: '2026-10-26', slot: 'S1', name: '試験 一郎' });
  await f.getByRole('button', { name: '申し込む', exact: true }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '予約が確定しました' }).waitFor();
  const no = (await f.locator('.ticket .no').innerText()).trim();
  assert.match(no, /^\d{6}$/);
  const rows = confirmedRows(ui, '試験 一郎');
  assert.equal(rows.length, 1);
  assert.equal(String(rows[0]['予約番号']), no);
  // 閉じると一覧に戻る（3台中2台が埋まったが、まだ空きがあるので○）
  await ui.waitIdle();
  await f.locator('#close').click();
  await ui.waitIdle();
  assert.match(await slotAt(f, '2026-10-26', 'S1').getAttribute('aria-label'), /空き$/);
  // 予約の確認（予約番号＋電話番号の下4けた）は住民の画面から外した（D-014）
  assert.equal(await f.getByRole('button', { name: '予約の確認' }).count(), 0);
  assert.deepEqual(ui.pageErrors, []);
  await ui.shot('UI-01-確定');
});

test('[UI-02] 送信前に日付・翌朝までの時間帯・料金・台数を確認でき、直せる', async (t) => {
  const ui = await openApp({ device: 'iPhone SE' });
  t.after(() => ui.close());
  const f = ui.frame();
  await ui.waitIdle();
  await fillUntilConfirm(ui, { date: '2026-10-25', slot: 'S4', quantity: 2, name: '確認 花子' });
  const text = await f.locator('.kv').innerText();
  assert.match(text, /2026年10月25日（日）/);
  assert.match(text, /夜 17:00〜翌朝8:00（10月26日（月）の朝まで）/);
  assert.match(text, /2台/);
  assert.match(text, /1,200円/);
  assert.match(text, /確認 花子/);
  await ui.shot('UI-02-確認');
  await f.getByRole('button', { name: '直す' }).click();
  assert.equal(await f.getByLabel('お名前').inputValue(), '確認 花子', '直すときに入力が消えている');
  await f.getByRole('button', { name: '1台', exact: true }).click();
  await f.getByRole('button', { name: '確認へ進む' }).click();
  assert.match(await f.locator('.kv').innerText(), /600円/);
  assert.equal(ui.serverCalls().filter((c) => c.fn === 'api_submitReservation').length, 0, '確認の前に申し込みが送られている');
});

test('[UI-03] 満車の枠は「満車」と示され、選べない', async (t) => {
  const ui = await openApp({ device: 'iPhone SE' });
  t.after(() => ui.close());
  const f = ui.frame();
  await ui.waitIdle();
  assert.equal(await cell(f, '2026-10-24', 'S4').count(), 0, '満車の枠が申し込める');
  assert.match(await slotAt(f, '2026-10-24', 'S4').getAttribute('aria-label'), /満車$/);
  assert.match(await slotAt(f, '2026-10-24', 'S4').innerText(), /×/);
  assert.match(await slotAt(f, '2026-10-24', 'S1').getAttribute('aria-label'), /空き$/);
  // 満車を押すと、近くの空いている枠がそのまま選べる形で出る（申込みフォームには進まない）
  await f.locator('#sheet button[data-full="2026-10-24"][data-slot="S4"]').click();
  await f.getByRole('heading', { name: '満車です' }).waitFor();
  assert.equal(await f.getByLabel('お名前').count(), 0, '満車なのに申込みフォームが出た');
  // 同じ時間帯のほかの日が先頭に出る。問合せ先は押せば電話がかかる
  assert.equal(await f.locator('#panel button[data-alt]').first().getAttribute('data-slot'), 'S4');
  assert.match(await f.locator('#panel a.call').getAttribute('href'), /^tel:\d{10,11}$/);
  await ui.shot('UI-03-満車');
  await f.locator('#panel button[data-alt="2026-10-25"][data-slot="S4"]').click();
  await f.getByRole('heading', { name: '申し込み' }).waitFor();
  assert.match(await f.locator('#panel .pick').innerText(), /10月25日/);
});

test('[UI-04] 選んだ後に満車になったら「予約できませんでした」と表示し、確定と誤表示しない', async (t) => {
  const ui = await openApp({ device: 'iPhone SE' });
  t.after(() => ui.close());
  const f = ui.frame();
  await ui.waitIdle();
  await fillUntilConfirm(ui, { date: '2026-10-25', slot: 'S2', name: '古い 画面' });
  const other = await ui.bookBehindTheScenes({ date: '2026-10-25', slotId: 'S2' });
  assert.equal(other.status, 'CONFIRMED');
  await f.getByRole('button', { name: '申し込む', exact: true }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '予約できませんでした' }).waitFor();
  assert.match(await f.locator('#panel').innerText(), /満車/);
  assert.equal(await f.getByText('予約が確定しました').count(), 0);
  assert.equal(confirmedRows(ui, '古い 画面').length, 0);
  await ui.waitIdle();
  assert.equal(await cell(f, '2026-10-25', 'S2').count(), 0, '表が満車に更新されていない');
  await ui.shot('UI-04-不成立');
});

test('[UI-05] 応答が届かないときは「結果が分からない」と示し、確かめると確定済みと分かる（二重にならない）', async (t) => {
  const ui = await openApp({ device: 'iPhone 13' });
  t.after(() => ui.close());
  const f = ui.frame();
  await ui.waitIdle();
  await fillUntilConfirm(ui, { date: '2026-10-21', slot: 'S2', name: '電波 弱子' });
  ui.dropNextResponse('api_submitReservation');
  await f.getByRole('button', { name: '申し込む', exact: true }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '結果が分かりませんでした' }).waitFor();
  await ui.shot('UI-05-結果不明');
  await f.getByRole('button', { name: '結果を確かめる' }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '予約が確定しました' }).waitFor();
  assert.equal(confirmedRows(ui, '電波 弱子').length, 1);
  // 申し込み自体が届かなかった場合は、同じ内容でもう一度申し込める（入力は覚えている）
  await f.getByRole('button', { name: '閉じる' }).first().click();
  await ui.waitIdle();
  await pickSlot(f, '2026-10-22', 'S1');
  assert.equal(await f.getByLabel('お名前').inputValue(), '電波 弱子', '前回の入力が残っていない');
  await f.getByRole('button', { name: '確認へ進む' }).click();
  ui.dropNextRequest('api_submitReservation');
  await f.getByRole('button', { name: '申し込む', exact: true }).click();
  await ui.waitIdle();
  await f.getByRole('button', { name: '結果を確かめる' }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '申し込みは届いていません' }).waitFor();
  await f.getByRole('button', { name: 'もう一度申し込む' }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '予約が確定しました' }).waitFor();
  assert.equal(confirmedRows(ui, '電波 弱子').length, 2);
});

test('[UI-06] 処理中は「申し込んでいます」と表示し、ボタンを連打しても予約は1件', async (t) => {
  const ui = await openApp({ device: 'iPhone SE' });
  t.after(() => ui.close());
  const f = ui.frame();
  await ui.waitIdle();
  await fillUntilConfirm(ui, { date: '2026-10-23', slot: 'S3', name: '連打 する' });
  ui.slowServer(1500, 'api_submitReservation');
  await f.evaluate(() => { const b = document.getElementById('send'); b.click(); b.click(); b.click(); });
  await f.getByText('申し込んでいます').waitFor({ timeout: 1000 });
  await ui.shot('UI-06-処理中');
  await ui.waitIdle(10000);
  await f.getByRole('heading', { name: '予約が確定しました' }).waitFor();
  assert.equal(ui.serverCalls().filter((c) => c.fn === 'api_submitReservation').length, 1, '申し込みが複数回送られた');
  assert.equal(confirmedRows(ui, '連打 する').length, 1);
});

test('[UI-01][8スマホ対応] PC幅では一覧の右に電話のボタンが並び、申し込むと入力が右に出る', async (t) => {
  const ui = await openApp({ device: 'Desktop Chrome' });
  t.after(() => ui.close());
  const f = ui.frame();
  await ui.waitIdle();
  const list = await f.locator('#monthview').boundingBox();
  const dv = await f.locator('#dayview').boundingBox();
  assert.ok(dv.x > list.x + list.width - 1, '電話のボタンが一覧の右に出ていない');
  await pickSlot(f, '2026-10-25', 'S1');
  const panel = await f.locator('#panel').boundingBox();
  assert.ok(panel.x > list.x + list.width - 1, '入力の枠が一覧の右に出ていない');
  await ui.shot('UI-01-PC');
});

/** 本番の設定（src/Config.gs の DEFAULT_RULES：住民の受付は閉じる・1コマ2台・1回1台・3か月先まで）に切り替える */
async function toProduction(ui) {
  const r = await ui.app.host.run('setup_init', [{ ...RULES, maxQuantityPerRequest: 1, capacityPerSlot: 2, residentBooking: false, viewMonths: 3 }, []], { kind: 'editor' });
  assert.ok(r.ok && r.value.status === 'OK');
  await ui.page.reload();
  await ui.waitIdle();
}

test('[UI-12] 本番の設定では、今日から5日後〜2か月先の○×の一覧と電話のボタンだけが出て、申し込みの入口は無い', async (t) => {
  const ui = await openApp({ device: 'iPhone SE' });
  t.after(() => ui.close());
  await toProduction(ui);
  const f = ui.frame();
  assert.match(await f.locator('#h-month').innerText(), /2026年10月/);
  // 今日は 10/19。一覧は5日後の 10/24 から始まる（当日・直前の分は見せない）
  assert.match(await f.locator('#sheet tbody tr').first().innerText(), /10\/24/);
  for (const d of ['2026-10-19', '2026-10-20', '2026-10-23']) assert.equal(await f.locator(`#sheet [aria-label^="${md(d)}"]`).count(), 0, `${d} が見えている`);
  // 1コマ2台：3台入っている 10/24 夜も、2台入っている 10/25 昼も満車。1台の 10/25 午後・10/26 朝は空きがあるので○
  assert.match(await slotAt(f, '2026-10-24', 'S4').getAttribute('aria-label'), /満車$/);
  assert.match(await slotAt(f, '2026-10-25', 'S2').getAttribute('aria-label'), /満車$/);
  assert.match(await slotAt(f, '2026-10-25', 'S3').getAttribute('aria-label'), /空き$/);
  assert.match(await slotAt(f, '2026-10-26', 'S1').getAttribute('aria-label'), /空き$/);
  assert.match(await slotAt(f, '2026-10-26', 'S2').getAttribute('aria-label'), /空き$/);
  assert.doesNotMatch(await f.locator('#sheet').innerText(), /△/, '△が出ている');
  // 時間帯の呼び名 A〜D（電話口・予約表と同じ）が、見出しに添えてある
  const heads = await f.locator('#sheet thead th[scope="col"]').allInnerTexts();
  assert.deepEqual(heads.slice(1).map((x) => x.replace(/\s+/g, '').slice(0, 2)), ['A朝', 'B昼', 'C午', 'D夜']);
  // 枠は押せない。入力欄も、予約の確認も無い。電話をかけるボタンがある
  assert.equal(await f.locator('#sheet button').count(), 0, '枠が押せる');
  assert.equal(await f.locator('input').count(), 0);
  assert.equal(await f.getByRole('button', { name: '予約の確認' }).count(), 0);
  const tel = f.locator('#dayview a.tel');
  assert.match(await tel.getAttribute('href'), /^tel:\d{10,11}$/);
  assert.match(await tel.innerText(), /電話で予約する/);
  assert.doesNotMatch(await f.locator('main').innerText(), /\d台/, '台数が出ている');
  // 一覧は長いので、電話のボタンは下まで送らなくても画面の中にある（月の終わりまで送っても同じ）
  const vh = ui.page.viewportSize().height;
  let box = await tel.boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= vh + 1, `電話のボタンが画面の外にある（${Math.round(box.y)}px）`);
  await f.locator('#sheet tbody tr').last().scrollIntoViewIfNeeded();
  box = await tel.boundingBox();
  assert.ok(box.y >= 0 && box.y + box.height <= vh + 1, '下まで送ると電話のボタンが見えない');
  // 電話のボタンが、一覧の最後の行を隠さない
  const lastRow = await f.locator('#sheet tbody tr').last().boundingBox();
  assert.ok(lastRow.y + lastRow.height <= box.y + 1, '電話のボタンが一覧の最後の行に重なっている');
  // 前の月へは戻れない
  assert.ok(await f.locator('#prev').isDisabled(), '前の月へ戻れる');
  await ui.page.evaluate(() => window.scrollTo(0, 0));
  await ui.shot('UI-12-本番の設定');
  // 2か月先（2026年12月19日）まで。その後の日は出ず、その先の月へは進めない
  for (let i = 0; i < 2; i++) { await f.locator('#next').click(); await ui.waitIdle(); }
  assert.match(await f.locator('#h-month').innerText(), /2026年12月/);
  assert.equal(await f.locator(`#sheet [aria-label^="${md('2026-12-19')}"]`).count(), 4, '2か月先の日が出ていない');
  assert.equal(await f.locator(`#sheet [aria-label^="${md('2026-12-20')}"]`).count(), 0, '2か月先より後の日が出ている');
  assert.ok(await f.locator('#next').isDisabled(), '2か月先より後の月へ進める');
  // 画面を通さず直接呼んでも、住民の申込みは受け付けず、台帳に何も書かない
  const before = ui.app.host.dumpSheet(ui.app.spreadsheetId, '予約').rows.length;
  const r = await ui.app.host.run('api_submitReservation', [{ requestId: 'rq-direct-call-1', date: '2026-10-27', slotId: 'S1', quantity: 1, name: '直接 呼出', room: '101', phone: '090-0000-0000' }], { kind: 'client', user: null });
  assert.equal(r.value.status, 'REJECTED');
  assert.equal(r.value.reason, 'CLOSED');
  assert.equal(ui.app.host.dumpSheet(ui.app.spreadsheetId, '予約').rows.length, before);
  assert.deepEqual(ui.pageErrors, []);
});

test('[UI-12] 一覧とカレンダーを切り替えられる。カレンダーでは過ぎた日・今日・直前の日は灰色で押せず、今日は分かる。選んだ形は覚える', async (t) => {
  const ui = await openApp({ device: 'iPhone SE' });
  t.after(() => ui.close());
  await toProduction(ui);
  let f = ui.frame();
  const btnList = () => f.getByRole('button', { name: '一覧', exact: true });
  const btnCal = () => f.getByRole('button', { name: 'カレンダー', exact: true });
  assert.equal(await btnList().getAttribute('aria-pressed'), 'true', '既定が一覧でない');
  await btnCal().click();
  await ui.waitIdle();
  assert.equal(await btnCal().getAttribute('aria-pressed'), 'true');
  const day = (date) => f.locator(`#sheet button.cday[data-day="${date}"]`);
  // 10/18（過ぎた日）・10/19（今日）・10/23（直前の日）は押せない
  for (const d of ['2026-10-18', '2026-10-19', '2026-10-23']) assert.equal(await day(d).count(), 0, `${d} が押せる`);
  // 今日は「今日」と分かる（灰色で押せないまま）
  const today = f.locator('#sheet span.cday.out.today');
  assert.equal(await today.count(), 1, '今日が分からない');
  assert.equal(await today.getAttribute('aria-label'), `${md('2026-10-19')} 今日`);
  assert.match(await today.innerText(), /19[\s\S]*今日/);
  assert.equal(await f.locator('#sheet span.cday.out').filter({ hasText: /今日/ }).count(), 1);
  // 灰色：押せる日より薄い文字
  const colors = await f.evaluate(() => {
    const out = document.querySelector('#sheet span.cday.out:not(.today) .dn');
    const on = document.querySelector('#sheet button.cday .dn');
    return [getComputedStyle(out).color, getComputedStyle(on).color];
  });
  assert.notEqual(colors[0], colors[1], '押せない日が灰色になっていない');
  assert.doesNotMatch(await f.locator('#sheet').innerText(), /△/, 'カレンダーに△が出ている');
  // 10/24 から押せる。夜は満車
  await day('2026-10-24').click();
  assert.match(await f.locator('#dayview .slot').nth(3).innerText(), /×[\s\S]*満車/);
  assert.equal(await f.locator('#dayview button').count(), 0, '時間帯が押せる');
  assert.match(await f.locator('#dayview a.tel').getAttribute('href'), /^tel:\d{10,11}$/);
  await ui.shot('UI-12-カレンダーの形');
  // 開き直しても、カレンダーのまま
  await ui.page.reload();
  await ui.waitIdle();
  f = ui.frame();
  assert.equal(await btnCal().getAttribute('aria-pressed'), 'true', '選んだ形を覚えていない');
  assert.equal(await f.locator('#sheet span.cday.out.today').count(), 1);
  // 一覧に戻すと、一覧の形（10/24 から）
  await btnList().click();
  await ui.waitIdle();
  assert.match(await f.locator('#sheet tbody tr').first().innerText(), /10\/24/);
  // ?layout=calendar で開くと、カレンダーで始まる
  await ui.page.goto(ui.app.userUrl + '?layout=calendar');
  await ui.waitIdle();
  f = ui.frame();
  assert.equal(await btnCal().getAttribute('aria-pressed'), 'true');
  assert.deepEqual(ui.pageErrors, []);
});
