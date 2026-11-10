'use strict';
// 管理者画面（台帳）の試験（UI-07〜UI-11 と検索）
const test = require('node:test');
const assert = require('node:assert/strict');
const { openApp } = require('./ui-helpers');
const { ACTORS, reqFor } = require('../helpers');

async function login(ui, secret, email) {
  const f = ui.frame();
  await f.getByLabel('メールアドレス').fill(email || ui.actor.email);
  await f.getByLabel('パスコード').fill(secret === undefined ? ui.actor.secret : secret);
  await f.getByRole('button', { name: '確認して進む' }).click();
  await ui.waitIdle();
}
const board = (f) => f.locator('#board');

test('[UI-07][A-01] 台帳の空き枠を押して、電話受付の予約をメールなしで代行登録できる', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'iPhone SE' });
  t.after(() => ui.close());
  const f = ui.frame();
  await login(ui);
  // 確認後の台帳で、スマホの画面幅からはみ出さない（横スクロールしない）
  await board(f).locator('.cell').first().waitFor();
  const sw = await f.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  assert.ok(sw[0] <= sw[1] + 1, `台帳の画面が横にはみ出す（${sw[0]}px > ${sw[1]}px）`);
  // スマホでは日付を選ぶと、その日の台帳に予約者の名字が並ぶ
  await f.getByRole('button', { name: /^10月25日（日） 空き\d+$/ }).click();
  assert.equal(await f.getByRole('button', { name: /^10月25日（日） 空き\d+$/ }).getAttribute('aria-pressed'), 'true');
  assert.ok(await board(f).locator('button.cell.taken').count() > 0, '選んだ日の予約者が台帳に出ない');
  await f.getByRole('button', { name: '10月25日（日） B 昼 11〜14時 93番 空き' }).click();
  assert.equal(await f.getByRole('button', { name: '電話', exact: true }).getAttribute('aria-pressed'), 'true', '受付の既定は電話');
  await f.getByLabel('お名前').fill('中村 実');
  await f.getByLabel('棟').fill('B棟');
  await f.getByLabel('部屋番号').fill('205');
  await f.getByLabel('電話番号').fill('090-1212-3434');
  await f.getByRole('button', { name: '確認へ進む' }).click();
  const sum = await f.locator('#panel .kv').innerText();
  assert.match(sum, /電話/); assert.match(sum, /中村 実/); assert.match(sum, /メール\s*なし/);
  await f.getByRole('button', { name: '登録する', exact: true }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '登録しました' }).waitFor();
  const no = (await f.locator('.ticket .no').innerText()).trim();
  assert.match(no, /^\d{6}$/);
  assert.match(await f.locator('#panel').innerText(), new RegExp(no.split('').join(' ')));
  const row = ui.app.host.dumpSheet(ui.app.spreadsheetId, '予約').rows.find((r) => String(r['予約番号']) === no);
  assert.equal(row['受付経路'], 'PHONE');
  assert.equal(row['電話番号'], '090-1212-3434');
  assert.match(String(row['登録者']), /管理 一郎/);
  const alc = ui.app.host.dumpSheet(ui.app.spreadsheetId, '割当て').rows.find((r) => String(r['予約番号']) === no);
  assert.equal(String(alc['駐車場']), '93', '押した区画に割り当てられていない');
  // 電話口で伝えたら「本人に伝えた」。予約番号は画面に残り、電話連絡の数は増えない
  await f.getByRole('button', { name: '本人に伝えた' }).click();
  await ui.waitIdle();
  assert.match(await f.locator('#panel .ticket .no').innerText(), new RegExp(no));
  assert.equal((await f.locator('#calls-n').innerText()).trim(), '0');
  await f.locator('#r-done').click(); // スマホでは閉じると台帳に戻る
  await ui.waitIdle();
  assert.ok(await f.getByRole('button', { name: /10月25日（日） B 昼 11〜14時 93番 中村 実さん/ }).count(), '台帳に反映されていない');
  assert.deepEqual(ui.pageErrors, []);
  await ui.shot('UI-07-代行登録後の台帳');
});

test('[UI-08][A-06] 台帳の名前を押して理由を選んで取り消すと、枠が空きに戻る', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'Desktop Chrome' });
  t.after(() => ui.close());
  const f = ui.frame();
  await login(ui);
  const who = f.getByRole('button', { name: /10月25日（日） C 午後 14〜17時 91番 .+さん/ });
  const name = (await who.getAttribute('aria-label')).match(/91番 (.+)さん/)[1];
  await who.click();
  await f.getByRole('heading', { name: `${name} さん` }).waitFor();
  await f.getByRole('button', { name: 'この予約を取り消す' }).click();
  assert.equal(await f.getByRole('button', { name: '取り消す', exact: true }).isDisabled(), true, '理由を選ぶ前に取り消せる');
  await f.getByRole('button', { name: '本人から電話' }).click();
  await f.getByRole('button', { name: '取り消す', exact: true }).click();
  await ui.waitIdle();
  await f.getByText('取り消しました').waitFor();
  // 台数の数は管理者向けの空き状況にだけある（D-027）
  const A = ACTORS.admin;
  const av = (await ui.app.host.run('api_admin_availability', [{ email: A.email, secret: A.secret }, { from: '2026-10-25', to: '2026-10-25' }], { kind: 'client', user: A.email })).value;
  assert.equal(av.days[0].slots.find((s) => s.slotId === 'S3').remaining, 3);
  const log = ui.app.host.dumpSheet(ui.app.spreadsheetId, '操作履歴').rows.find((r) => r['操作'] === '取消し');
  assert.equal(log['理由'], '本人から電話');
  await ui.waitIdle();
  assert.ok(await f.getByRole('button', { name: '10月25日（日） C 午後 14〜17時 91番 空き' }).count(), '台帳の枠が空きに戻っていない');
  await ui.shot('UI-08-取消し');
});

test('[UI-09] 資格のない人が管理者画面を開いても、台帳の情報は表示されない', async (t) => {
  const ui = await openApp({ as: 'anonymous', device: 'iPhone SE' });
  t.after(() => ui.close());
  await ui.page.goto(ui.app.adminUrl);
  await ui.waitIdle();
  const f = ui.frame();
  const text = await f.locator('body').innerText();
  for (const r of ACTORS.residents.slice(0, 6)) assert.ok(!text.includes(r.name.split(' ')[0]), `${r.name} が見える`);
  await login(ui, 'wrong-passcode', ACTORS.admin.email);
  await f.getByText('確認できませんでした').waitFor();
  const text2 = await f.locator('body').innerText();
  for (const r of ACTORS.residents.slice(0, 6)) assert.ok(!text2.includes(r.name.split(' ')[0]));
});

test('[UI-09] パスコードの前後の空白は無視され、5回続けて間違えると「しばらく確認できません」と分かる', async (t) => {
  const ui = await openApp({ as: 'anonymous', device: 'iPhone SE' });
  t.after(() => ui.close());
  await ui.page.goto(ui.app.adminUrl);
  await ui.waitIdle();
  const f = ui.frame();
  await login(ui, ` ${ACTORS.admin.secret}\n`, ACTORS.admin.email);
  await f.locator('#board .cell').first().waitFor();
  await f.getByRole('button', { name: '管理を終える' }).click();
  for (let i = 0; i < 5; i++) await login(ui, 'wrong-passcode', ACTORS.admin2.email);
  await login(ui, ACTORS.admin2.secret, ACTORS.admin2.email);
  await f.getByText('しばらく確認できません').waitFor();
});

test('[UI-10][A-07] 電話連絡が必要な件数が常に見え、一覧で連絡済みにできる', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'iPhone SE' });
  t.after(() => ui.close());
  const f = ui.frame();
  const reg = await ui.app.adapter.adminRegister(ui.app.host, { ...reqFor(ACTORS.residents[8], { date: '2026-10-22', slotId: 'S1', channel: 'PHONE' }), email: undefined }, ACTORS.admin);
  assert.equal(reg.status, 'CONFIRMED');
  await login(ui);
  assert.equal((await f.locator('#calls-n').innerText()).trim(), '1');
  await f.getByRole('button', { name: /電話連絡/ }).click();
  await ui.waitIdle();
  await f.getByText('未対応（1件）').waitFor();
  await f.getByRole('button', { name: '電話した' }).click();
  await ui.waitIdle();
  await f.getByText('未対応（0件）').waitFor();
  await f.getByText('対応済み（1件）').waitFor();
  assert.equal((await f.locator('#calls-n').innerText()).trim(), '0');
});

test('[UI-11][A-09][A-05] PC幅で1週間の台帳が1画面に入り、印刷でき、名前で探せる', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'Desktop Chrome' });
  t.after(() => ui.close());
  const f = ui.frame();
  await login(ui);
  const box = await f.locator('#board table').boundingBox();
  const vp = ui.page.viewportSize();
  assert.ok(box.y + box.height <= vp.height, `1週間の台帳が1画面に入らない（下端 ${Math.round(box.y + box.height)}px）`);
  const night24 = f.locator('#board tbody tr', { hasText: '10/24' });
  assert.equal(await night24.locator('button.cell.taken').count(), 3, '10/24 夜の3台が台帳に出ていない');
  assert.ok(await f.getByRole('button', { name: '印刷' }).isVisible());
  const target = ACTORS.residents[6];
  await f.getByRole('searchbox').or(f.locator('#q')).first().fill(target.name.split(' ')[0]);
  await f.getByRole('button', { name: '探す' }).click();
  await ui.waitIdle();
  assert.match(await f.locator('#panel').innerText(), new RegExp(target.name.split(' ')[0]));
  await ui.shot('UI-11-台帳PC');
});

test('[UI-13] 本番の設定（1コマ2台・1回1台）では、2台入ったコマの残りの区画は「満」で押せず、登録に台数の選択が出ない', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'Desktop Chrome' });
  t.after(() => ui.close());
  const { RULES } = require('../helpers');
  const r = await ui.app.host.run('setup_init', [{ ...RULES, maxQuantityPerRequest: 1, capacityPerSlot: 2, residentBooking: false, viewMonths: 3 }, []], { kind: 'editor' });
  assert.ok(r.ok && r.value.status === 'OK');
  await ui.page.reload();
  const f = ui.frame();
  await login(ui);
  // 10/25 昼は2台入っている。区画は3つ（91・92・93）並ぶが、残りの1つは「満」で押せない
  const cap = f.getByLabel('10月25日（日） B 昼 11〜14時 93番 2台で満車');
  assert.equal(await cap.count(), 1, '残りの区画が「満」になっていない');
  assert.equal(await f.getByRole('button', { name: /10月25日（日） B 昼 11〜14時 \d+番 空き/ }).count(), 0, '2台入ったコマにまだ登録できる');
  // 1台入っている 10/25 午後は、あと1台だけ登録できる。台数の選択は出ない
  await f.getByRole('button', { name: '10月25日（日） C 午後 14〜17時 93番 空き' }).click();
  await f.getByRole('heading', { name: '登録' }).waitFor();
  assert.equal(await f.getByRole('button', { name: '2台', exact: true }).count(), 0, '台数の選択が出ている');
  await ui.shot('UI-13-本番の設定の台帳');
});

test('[UI-14] 期間と駐車場を選んで、まとめて使用禁止にでき、台帳に網かけで出て、押すと解除できる', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'Desktop Chrome' });
  t.after(() => ui.close());
  const { RULES } = require('../helpers');
  await ui.app.host.run('setup_init', [{ ...RULES, maxQuantityPerRequest: 1, capacityPerSlot: 2, residentBooking: false, viewMonths: 3 }, []], { kind: 'editor' });
  await ui.page.reload();
  const f = ui.frame();
  await login(ui);
  // 10/22〜10/23 の93番を、終日止める
  await f.getByRole('button', { name: '使用禁止', exact: true }).click();
  await f.getByRole('button', { name: '期間を決めて使用禁止にする' }).click();
  await f.getByLabel('開始日').fill('2026-10-22');
  await f.getByLabel('終了日').fill('2026-10-23');
  assert.equal(await f.getByRole('button', { name: '終日', exact: true }).getAttribute('aria-pressed'), 'true');
  await f.getByRole('button', { name: '93番', exact: true }).click();
  assert.equal(await f.getByRole('button', { name: '全て', exact: true }).getAttribute('aria-pressed'), 'false');
  await f.getByRole('button', { name: '工事・点検', exact: true }).click();
  await f.getByRole('button', { name: '確認へ進む' }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: 'この内容で使用禁止にしますか' }).waitFor();
  const sum = await f.locator('#panel .kv').innerText();
  assert.match(sum, /10月22日（木）〜10月23日（金）/); assert.match(sum, /終日/); assert.match(sum, /93番/);
  assert.equal(ui.app.host.dumpSheet(ui.app.spreadsheetId, '使用禁止').rows.length, 0, '確かめる前に登録された');
  await f.getByRole('button', { name: '使用禁止にする', exact: true }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '使用禁止にしました' }).waitFor();
  await ui.waitIdle();
  assert.equal(await f.locator('#board button.cell.block').count(), 8, '2日×4時間帯の93番が網かけになっていない');
  const row = ui.app.host.dumpSheet(ui.app.spreadsheetId, '使用禁止').rows[0];
  assert.equal(row['駐車場'], '93');
  await ui.shot('UI-14-使用禁止');
  // 2台入っている 10/25 昼の「満」を押すと、管理者が使う形で、その枠だけを止められる
  await f.getByRole('button', { name: '10月25日（日） B 昼 11〜14時 93番 2台で満車' }).click();
  assert.equal(await f.getByRole('button', { name: '管理者が使う', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await f.getByRole('button', { name: 'B 昼', exact: true }).getAttribute('aria-pressed'), 'true');
  await f.getByRole('button', { name: '確認へ進む' }).click();
  await ui.waitIdle();
  await f.getByRole('button', { name: '使用禁止にする', exact: true }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '使用禁止にしました' }).waitFor();
  await ui.waitIdle();
  assert.match(await f.getByRole('button', { name: /10月25日（日） B 昼 11〜14時 93番 使用禁止/ }).innerText(), /管理者/);
  // 網かけを押すと中身が出て、解除できる
  await f.getByRole('button', { name: /10月22日（木） A 朝 8〜11時 93番 使用禁止/ }).click();
  await f.getByRole('button', { name: 'この使用禁止を解除する' }).click();
  await ui.waitIdle();
  await f.getByText('解除しました').waitFor();
  await ui.waitIdle();
  assert.equal(await f.locator('#board button.cell.block').count(), 1, '解除した分が台帳に残っている');
  assert.deepEqual(ui.pageErrors, []);
});

test('[UI-15][A-09] 予約表：これまでの Excel と同じ形（日付・時間帯 × 駐車場枠ごとの申込者・適用）で月の表を出し、印刷とスプレッドシートへの書き出しができる', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'Desktop Chrome' });
  t.after(() => ui.close());
  const f = ui.frame();
  await login(ui);
  await f.getByRole('button', { name: '予約表', exact: true }).click();
  await ui.waitIdle();
  assert.equal(await f.getByRole('button', { name: '予約表', exact: true }).getAttribute('aria-pressed'), 'true');
  const head = await f.locator('table.xsheet thead').innerText();
  assert.match(head, /日付[\s\S]*時間帯[\s\S]*駐車場枠91[\s\S]*駐車場枠92[\s\S]*駐車場枠93[\s\S]*申込者[\s\S]*適用/);
  assert.equal(await f.locator('table.xsheet tbody tr').count(), 31 * 4, '10月の行の数が違う');
  // 10/24 の D（夜）に3台分の名前が並ぶ
  const night = f.locator('table.xsheet tbody tr').nth(23 * 4 + 3);
  assert.match(await night.innerText(), /D\u300017:00〜翌朝8:00/);
  assert.equal(await night.locator('td:not(.note):not(.s)').evaluateAll((els) => els.filter((e) => e.textContent.trim()).length), 3);
  await ui.shot('UI-15-予約表');
  // 印刷の見た目（操作のボタンは出ない）
  await ui.page.emulateMedia({ media: 'print' });
  assert.equal(await f.locator('#export').isVisible(), false);
  assert.ok(await f.locator('table.xsheet caption').isVisible());
  await ui.shot('UI-15-予約表の印刷');
  await ui.page.emulateMedia({ media: 'screen' });
  // スプレッドシートに書き出す
  await f.getByRole('button', { name: 'スプレッドシートに書き出す' }).click();
  await ui.waitIdle();
  await f.getByText('「予約表 2026年10月」に書き出しました').waitFor();
  assert.ok(ui.app.host.dumpSheet(ui.app.spreadsheetId, '予約表 2026年10月'), 'シートが作られていない');
  // 次の月へ移れる。「今週」で台帳に戻る
  await f.getByRole('button', { name: '次の月' }).click();
  await ui.waitIdle();
  assert.match(await f.locator('#h-week').innerText(), /2026年11月/);
  await f.getByRole('button', { name: '今週' }).click();
  await ui.waitIdle();
  assert.ok(await f.locator('#board table.sheet').count(), '1週間の台帳に戻らない');
  assert.deepEqual(ui.pageErrors, []);
});

test('[UI-16][A-09] 予約表をスマホで見ると、日付と時間帯が左に止まったまま、駐車場枠を横に送って名前が読める', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'iPhone SE' });
  t.after(() => ui.close());
  const f = ui.frame();
  await login(ui);
  await f.getByRole('button', { name: '予約表', exact: true }).click();
  await ui.waitIdle();
  const night = f.locator('table.xsheet tbody tr').nth(23 * 4 + 3);
  await night.scrollIntoViewIfNeeded();
  // 申込者の欄が、名前の読める幅で並ぶ（縦に1文字ずつ折り返さない）。適用は申込者の下に出る
  const nameW = await f.locator('table.xsheet col.c-name').first().evaluate((c) => c.getBoundingClientRect().width);
  assert.ok(nameW >= 96, `申込者の欄が狭い（${Math.round(nameW)}px）`);
  const vw = ui.page.viewportSize().width;
  // 右の駐車場枠（93）まで送っても、日付と時間帯は見えたまま
  await f.locator('.xwrap').evaluate((w) => { w.scrollLeft = w.scrollWidth; });
  const day = await f.locator('table.xsheet tbody tr').nth(23 * 4).locator('th.d').boundingBox();
  const slot = await night.locator('td.s').boundingBox();
  assert.ok(day.x >= 0 && day.x < 40, `日付の欄が流れて見えない（x=${Math.round(day.x)}）`);
  assert.ok(slot.x > day.x && slot.x < 130, `時間帯の欄が流れて見えない（x=${Math.round(slot.x)}）`);
  assert.match(await night.locator('td.s').innerText(), /D\s*17時〜翌朝8時/);
  const last = night.locator('td:not(.note):not(.s)').last();
  const lb = await last.boundingBox();
  assert.ok(lb.x >= slot.x + slot.width - 1 && lb.x + lb.width <= vw + 1, `93番の申込者が、止めた欄に隠れずに見えるところまで送れない（x=${Math.round(lb.x)}）`);
  assert.match(await last.innerText(), /電話|窓口|ネット|棟/, '93番の適用（棟・部屋や受け付けた経路）が見えない');
  assert.ok((await last.innerText()).trim(), '93番の申込者の名前が出ていない');
  await ui.shot('UI-16-予約表スマホ');
  assert.deepEqual(ui.pageErrors, []);
});

test('[UI-17] 過ぎた時間のコマも、灰色のまま押して登録できる（台帳をあとから直すため）。棟に「なくても可」は出ない', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'Desktop Chrome' });
  t.after(() => ui.close());
  const f = ui.frame();
  await login(ui);
  await board(f).locator('.cell').first().waitFor();
  // 今は 10/19 9時。10/19 の朝（8時から）は始まっている
  const past = board(f).locator('button.cell.add.past[data-date="2026-10-19"][data-slot="S1"]');
  assert.ok(await past.count() > 0, '過ぎたコマの空きが押せない');
  assert.match(await past.first().getAttribute('aria-label'), /空き（過ぎた時間）$/);
  // まだ始まっていないコマは、灰色にしない
  assert.ok(await board(f).locator('button.cell.add[data-date="2026-10-19"][data-slot="S3"]:not(.past)').count() > 0);
  const bg = await f.evaluate(() => [
    getComputedStyle(document.querySelector('#board button.cell.add.past')).backgroundColor,
    getComputedStyle(document.querySelector('#board button.cell.add:not(.past)')).backgroundColor,
  ]);
  assert.notEqual(bg[0], bg[1], '過ぎたコマが灰色になっていない');
  const space = await past.first().getAttribute('data-space');
  await past.first().click();
  assert.equal(await f.locator('label[for="r-building"]').innerText(), '棟', '棟に「なくても可」が出ている');
  await f.getByLabel('お名前').fill('過去 記録');
  await f.getByLabel('部屋番号').fill('301');
  await f.getByLabel('電話番号').fill('090-5656-7878');
  await f.getByRole('button', { name: '確認へ進む' }).click();
  await f.getByRole('button', { name: '登録する', exact: true }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '登録しました' }).waitFor();
  const no = (await f.locator('.ticket .no').innerText()).trim();
  const alc = ui.app.host.dumpSheet(ui.app.spreadsheetId, '割当て').rows.find((r) => String(r['予約番号']) === no);
  assert.equal(String(alc['駐車場']), space);
  await f.locator('#r-done').click();
  await ui.waitIdle();
  const taken = board(f).getByRole('button', { name: new RegExp(`10月19日（月） A 朝 .* ${space}番 過去 記録さん`) });
  assert.equal(await taken.count(), 1, '台帳に反映されていない');
  assert.match(await taken.getAttribute('class'), /\bpast\b/, '登録した過ぎたコマが灰色でない');
  await ui.shot('UI-17-過ぎたコマの登録');
  assert.deepEqual(ui.pageErrors, []);
});

test('[UI-18] 電話口で先に聞いた名前・部屋番号は、枠を押し直しても、閉じても残り、登録できたら消える', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'Desktop Chrome' });
  t.after(() => ui.close());
  const f = ui.frame();
  await login(ui);
  await board(f).locator('.cell').first().waitFor();
  // まず空いている枠を開いて、名前と部屋番号を聞きながら入れる
  await f.getByRole('button', { name: '10月20日（火） A 朝 8〜11時 91番 空き' }).click();
  await f.getByLabel('お名前').fill('先聞 一郎');
  await f.getByLabel('部屋番号').fill('402');
  // 日と時間帯を聞いて、別の枠を押し直す → 入れた名前は残る
  await f.getByRole('button', { name: '10月21日（水） C 午後 14〜17時 91番 空き' }).click();
  assert.equal(await f.getByLabel('お名前').inputValue(), '先聞 一郎', '枠を押し直すと名前が消える');
  assert.equal(await f.getByLabel('部屋番号').inputValue(), '402');
  assert.match(await f.locator('#panel .pick').innerText(), /10月21日[\s\S]*C 午後/);
  // 閉じてから別の枠を押しても残る
  await f.locator('#close').click();
  await f.getByRole('button', { name: '10月21日（水） D 夜 17時〜翌朝8時 91番 空き' }).click();
  assert.equal(await f.getByLabel('お名前').inputValue(), '先聞 一郎', '閉じると名前が消える');
  await f.getByLabel('電話番号').fill('090-4040-5050');
  await f.getByRole('button', { name: '確認へ進む' }).click();
  await f.getByRole('button', { name: '登録する', exact: true }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '登録しました' }).waitFor();
  assert.match(await f.locator('#panel').innerText(), /先聞 一郎/);
  // 登録できたら、次の電話のために入力は空に戻る
  await f.locator('#r-done').click();
  await ui.waitIdle();
  await f.getByRole('button', { name: '10月22日（木） B 昼 11〜14時 91番 空き' }).click();
  assert.equal(await f.getByLabel('お名前').inputValue(), '', '登録した後も前の名前が残っている');
  assert.equal(await f.getByLabel('電話番号').inputValue(), '');
  assert.deepEqual(ui.pageErrors, []);
});

test('[UI-19] 予約の名前を押して「変更する」で、日・時間帯・区画を変えられる。満車なら変えずに理由を出す。PC幅では台帳の空きを押して変更先を選べる', async (t) => {
  const ui = await openApp({ as: 'admin', device: 'Desktop Chrome' });
  t.after(() => ui.close());
  const f = ui.frame();
  await login(ui);
  await board(f).locator('.cell').first().waitFor();
  const who = f.getByRole('button', { name: /10月25日（日） C 午後 14〜17時 91番 .+さん/ });
  const name = (await who.getAttribute('aria-label')).match(/91番 (.+)さん/)[1];
  await who.click();
  await f.getByRole('button', { name: '変更する', exact: true }).click();
  await f.getByRole('heading', { name: '予約の変更' }).waitFor();
  assert.equal(await f.getByLabel('利用日').inputValue(), '2026-10-25');
  assert.equal(await f.getByRole('button', { name: 'C 午後', exact: true }).getAttribute('aria-pressed'), 'true');
  // 満車の 10/24 D 夜へは変えられない（理由が出て、元のまま）
  await f.getByLabel('利用日').fill('2026-10-24');
  await f.getByRole('button', { name: 'D 夜', exact: true }).click();
  await f.getByRole('button', { name: '確認へ進む' }).click();
  assert.match(await f.locator('#panel .kv').innerText(), /10月25日（日） C 午後[\s\S]*→[\s\S]*10月24日（土） D 夜/);
  await f.getByRole('button', { name: '変更する', exact: true }).click();
  await ui.waitIdle();
  await f.getByRole('heading', { name: '予約の変更' }).waitFor();
  assert.match(await f.locator('#e-out').innerText(), /満車/);
  // 台帳の空き（10/22 D 夜 93番）を押すと、そこが変更先になる
  await f.getByRole('button', { name: '10月22日（木） D 夜 17時〜翌朝8時 93番 空き' }).click();
  assert.equal(await f.getByLabel('利用日').inputValue(), '2026-10-22');
  assert.equal(await f.getByRole('button', { name: 'D 夜', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await f.getByRole('button', { name: '93番', exact: true }).getAttribute('aria-pressed'), 'true');
  await f.getByRole('button', { name: '確認へ進む' }).click();
  await f.getByRole('button', { name: '変更する', exact: true }).click();
  await ui.waitIdle();
  await f.getByText('変更しました').waitFor();
  await f.locator('#d-done').click();
  await ui.waitIdle();
  assert.equal(await f.getByRole('button', { name: new RegExp(`10月22日（木） D 夜 .* 93番 ${name}さん`) }).count(), 1, '変更先に出ない');
  assert.equal(await f.getByRole('button', { name: '10月25日（日） C 午後 14〜17時 91番 空き' }).count(), 1, '元の枠が空かない');
  await ui.shot('UI-19-予約の変更');
  assert.deepEqual(ui.pageErrors, []);
});
