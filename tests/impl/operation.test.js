'use strict';
// 本番の運用（2026-11-07 に依頼者が決めたこと。docs/DECISIONS.md D-014）をサーバーで確かめる。
//   ・住民は画面から予約しない（申込みはサーバーで断り、台帳に何も書かない）
//   ・区画は 91・92・93 の3つだが、住民には1コマ2台で見せる。管理者は3台目（全ての区画）まで入れられる（D-040）。1回の予約は1台
//   ・電話（管理者の登録）は今日から3か月先まで受け付ける
//   ・住民の画面に見せるのは、今日から5日後〜2か月先だけ（D-020。下の PROD_VIEW で試す）
// 受入試験（tests/acceptance、保護）は「1コマ3台・住民が申し込める」前提のため、ここで本番の設定を試す（D-015）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS, DAY } = require('../helpers');

const PROD = { rules: { maxQuantityPerRequest: 1, capacityPerSlot: 2, residentBooking: false, viewMonths: 3 } };
const R = ACTORS.residents;
const adm = (env, fn, q, actor = ACTORS.admin) => env.host.run(fn, [{ email: actor.email, secret: actor.secret }, q], { kind: 'client', user: actor.email }).then((r) => r.value);
/** 台数の数は管理者向けの空き状況で確かめる（住民向けには数を返さない。D-027） */
const avail = async (env, date, slotId) => (await adm(env, 'api_admin_availability', { from: date, to: date })).days[0].slots.find((s) => s.slotId === slotId);
const phone = (env, who, o) => env.adapter.adminRegister(env.host, { ...env.req(who, o), channel: 'PHONE', email: undefined }, ACTORS.admin);

test('住民の申込みは受け付けず、台帳に何も書かない（再送しても同じ）', async (t) => withEnv(t, PROD, async (env) => {
  const req = env.req(R[0], { slotId: 'S1' });
  const a = await env.adapter.submit(env.host, req, R[0]);
  const b = await env.adapter.submit(env.host, req, R[0]);
  assert.equal(a.status, 'REJECTED');
  assert.equal(a.reason, 'CLOSED');
  assert.equal(b.reason, 'CLOSED');
  assert.equal(env.host.dumpSheet(env.spreadsheetId, '予約').rows.length, 0);
  assert.equal(env.host.dumpSheet(env.spreadsheetId, '割当て').rows.length, 0);
  // 管理者の電話受付はできる
  const c = await phone(env, R[1], { slotId: 'S1' });
  assert.equal(c.status, 'CONFIRMED');
}));

test('管理者の電話受付は1コマ3台（全ての区画）まで。4台目は満車で断る。住民には2台で満車と見せる（D-040）', async (t) => withEnv(t, PROD, async (env) => {
  const a = await phone(env, R[0], { slotId: 'S2' });
  const b = await phone(env, R[1], { slotId: 'S2' });
  let res = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  assert.equal(res.days[0].slots.find((s) => s.slotId === 'S2').available, false, '2台で住民に満車と見せていない');
  const c = await phone(env, R[2], { slotId: 'S2' });
  const e4 = await phone(env, R[4], { slotId: 'S2' });
  assert.equal(a.status, 'CONFIRMED');
  assert.equal(b.status, 'CONFIRMED');
  assert.equal(c.status, 'CONFIRMED', '管理者が3台目を入れられない');
  assert.equal(e4.status, 'REJECTED');
  assert.equal(e4.reason, 'FULL');
  const spaces = env.host.dumpSheet(env.spreadsheetId, '割当て').rows.filter((x) => x['状態'] === '有効').map((x) => String(x['駐車場'])).sort();
  assert.deepEqual(spaces, ['91', '92', '93']);
  res = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  assert.equal(res.days[0].slots.find((s) => s.slotId === 'S2').available, false);
  // 表で93番を押して登録したときは93番に入る（区画の指定は残す）
  const d = await phone(env, R[3], { slotId: 'S3', preferSpace: '93' });
  assert.deepEqual(d.raw.spaces, ['93']);
}));

test('空き状況：住民向けは上限2で数え、申し込めないことを返す。管理者向けは3つの区画で数える（D-040）', async (t) => withEnv(t, PROD, async (env) => {
  await phone(env, R[0], { slotId: 'S4' });
  const av = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  const s4 = av.days[0].slots.find((s) => s.slotId === 'S4');
  const s1 = av.days[0].slots.find((s) => s.slotId === 'S1');
  // 住民には「空きがある／ない」だけを返し、台数の数は返さない（D-027）
  assert.equal(s4.available, true);
  assert.equal(s1.available, true);
  av.days[0].slots.forEach((s) => { assert.ok(!('remaining' in s) && !('capacity' in s), `${s.slotId} に台数の数がある`); });
  assert.ok(!('capacity' in av.raw), '住民の応答に台数がある');
  assert.equal(s1.online, false);
  assert.equal(av.raw.residentBooking, false);
  // 管理者には数を返す
  assert.equal((await avail(env, DAY, 'S4')).capacity, 3);
  assert.equal((await avail(env, DAY, 'S4')).remaining, 2);
  assert.equal((await avail(env, DAY, 'S1')).remaining, 3);
  assert.equal(av.raw.maxQuantity, 1);
}));

test('1回の予約は1台（2台は入力の誤りとして断る）', async (t) => withEnv(t, PROD, async (env) => {
  const r = await phone(env, R[0], { slotId: 'S1', quantity: 2 });
  assert.equal(r.status, 'REJECTED');
  assert.equal(r.reason, 'INVALID');
}));

test('電話受付は今日から3か月先の日まで。その先は受け付けない', async (t) => withEnv(t, PROD, async (env) => {
  // 今日（仮想時刻）は 2026-10-19。住民の申込みの受付期間（30日）を超えても、電話なら3か月先まで登録できる
  const av = await adm(env, 'api_admin_availability', { from: '2027-01-18', to: '2027-01-20' });
  assert.equal(av.until, '2027-01-19');
  assert.deepEqual(av.days.map((d) => d.slots[0].closed), [false, false, true]);
  const inside = await phone(env, R[0], { date: '2027-01-19', slotId: 'S1' });
  const outside = await phone(env, R[1], { date: '2027-01-20', slotId: 'S1' });
  assert.equal(inside.status, 'CONFIRMED');
  assert.equal(outside.status, 'REJECTED');
  assert.equal(outside.reason, 'WINDOW');
}));

test('3か月先の日は、月末を越えない（11月30日の3か月先は2月28日）', async (t) => withEnv(t, { ...PROD, now: '2026-11-30T09:00:00+09:00' }, async (env) => {
  const av = await env.adapter.getAvailability(env.host, { from: '2026-11-30', to: '2026-11-30' }, ACTORS.anonymous);
  assert.equal(av.raw.until, '2027-02-28');
}));

// ---------------------------------------------------------------- 使用禁止（D-016）
let seq = 0;
const block = (env, o, confirm = true) => adm(env, 'api_admin_addBlock', { requestId: `rq-block-${++seq}-${Date.now()}`, reason: '工事・点検', ...o, confirm });

test('期間・時間帯・駐車場をまとめて使用禁止にすると、その間は空き状況から除かれ、電話でも登録できない', async (t) => withEnv(t, PROD, async (env) => {
  // 10/26〜10/28、全ての時間帯、全ての駐車場
  const r = await block(env, { from: '2026-10-26', to: '2026-10-28' });
  assert.equal(r.status, 'OK');
  assert.equal(r.cells, 3 * 4 * 3);
  assert.equal((await avail(env, '2026-10-27', 'S4')).remaining, 0);
  assert.equal((await avail(env, '2026-10-29', 'S4')).remaining, 3, '期間の外まで止まっている');
  const p = await phone(env, R[0], { date: '2026-10-27', slotId: 'S2' });
  assert.equal(p.status, 'REJECTED');
  assert.equal(p.reason, 'FULL');
  // 台帳のシートは管理者が読める形
  const row = env.host.dumpSheet(env.spreadsheetId, '使用禁止').rows[0];
  assert.equal(row['時間帯'], '終日');
  assert.equal(row['駐車場'], '全て');
  assert.equal(row['状態'], '有効');
  // 解除すると戻る
  const rel = await adm(env, 'api_admin_releaseBlock', { blockId: r.blockId });
  assert.equal(rel.status, 'OK');
  assert.equal((await avail(env, '2026-10-27', 'S4')).remaining, 3);
  assert.equal(env.host.dumpSheet(env.spreadsheetId, '使用禁止').rows[0]['状態'], '解除');
  const log = env.host.dumpSheet(env.spreadsheetId, '操作履歴').rows.map((x) => x['操作']);
  assert.ok(log.includes('使用禁止') && log.includes('使用禁止の解除'));
}));

test('一部の駐車場だけを止めると、残りの区画で受け付ける（91・92を止めると、93の1台だけ）', async (t) => withEnv(t, PROD, async (env) => {
  await block(env, { from: DAY, to: DAY, slots: ['S1', 'S4'], spaces: ['91', '92'] });
  assert.equal((await avail(env, DAY, 'S1')).remaining, 1);
  assert.equal((await avail(env, DAY, 'S2')).remaining, 3, '止めていない時間帯まで減った');
  const a = await phone(env, R[0], { slotId: 'S1' });
  const b = await phone(env, R[1], { slotId: 'S1' });
  assert.deepEqual(a.raw.spaces, ['93']);
  assert.equal(b.reason, 'FULL');
}));

test('93番を「管理者が使う」で止めても、住民には残りの1台が空きと見え、電話で2台目まで入る。3台目は止めた93には入らない', async (t) => withEnv(t, PROD, async (env) => {
  await phone(env, R[0], { slotId: 'S4' });
  assert.equal((await avail(env, DAY, 'S4')).remaining, 2);
  const r = await block(env, { from: DAY, to: DAY, slots: ['S4'], spaces: ['93'], reason: '管理者が使う' });
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.conflicts, []);
  assert.equal((await avail(env, DAY, 'S4')).remaining, 1);
  const res = await env.adapter.getAvailability(env.host, { from: DAY, to: DAY }, ACTORS.anonymous);
  assert.equal(res.days[0].slots.find((s) => s.slotId === 'S4').available, true, '住民に空きが見えない');
  const b = await phone(env, R[1], { slotId: 'S4' });
  assert.equal(b.status, 'CONFIRMED');
  assert.notDeepEqual(b.raw.spaces, ['93']);
  const c = await phone(env, R[2], { slotId: 'S4' });
  assert.equal(c.reason, 'FULL', '止めた93番に入った');
}));

test('予約がある枠を止めるときは、確かめる段階で重なる予約を返し、予約は取り消さない', async (t) => withEnv(t, PROD, async (env) => {
  const a = await phone(env, R[0], { slotId: 'S3' });
  const pv = await block(env, { from: DAY, to: DAY }, false);
  assert.equal(pv.status, 'PREVIEW');
  assert.equal(pv.conflicts.length, 1);
  assert.equal(pv.conflicts[0].reservationId, a.reservationId);
  assert.equal(env.host.dumpSheet(env.spreadsheetId, '使用禁止').rows.length, 0, '確かめる段階で書いた');
  const r = await block(env, { from: DAY, to: DAY });
  assert.equal(r.conflicts.length, 1);
  const rows = env.host.dumpSheet(env.spreadsheetId, '予約').rows.filter((x) => String(x['予約番号']) === a.reservationId);
  assert.equal(rows[0]['状態'], '確定');
}));

test('同じ受付要求IDで送り直しても、使用禁止は1件だけ', async (t) => withEnv(t, PROD, async (env) => {
  const q = { requestId: 'rq-block-same-0001', from: DAY, to: DAY, reason: '行事', confirm: true };
  const a = await adm(env, 'api_admin_addBlock', q);
  const b = await adm(env, 'api_admin_addBlock', q);
  assert.equal(a.blockId, b.blockId);
  assert.equal(env.host.dumpSheet(env.spreadsheetId, '使用禁止').rows.length, 1);
}));

test('入力の誤り（終了日が開始日より前・知らない駐車場・過ぎた期間）は登録しない', async (t) => withEnv(t, PROD, async (env) => {
  assert.equal((await block(env, { from: '2026-10-28', to: '2026-10-27' })).reason, 'INVALID');
  assert.equal((await block(env, { from: DAY, to: DAY, spaces: ['94'] })).reason, 'INVALID');
  assert.equal((await block(env, { from: '2026-10-01', to: '2026-10-02' })).reason, 'INVALID');
  assert.equal(env.host.dumpSheet(env.spreadsheetId, '使用禁止').rows.length, 0);
}));

test('使用禁止の関数は、管理者でない人が直接呼んでも何も変えられない', async (t) => withEnv(t, PROD, async (env) => {
  const anon = async (fn, q) => (await env.host.run(fn, [{ email: R[0].email, secret: 'wrong-secret-123' }, q], { kind: 'client', user: R[0].email })).value;
  assert.equal((await anon('api_admin_addBlock', { requestId: 'rq-anon-00001', from: DAY, to: DAY, reason: 'x', confirm: true })).status, 'DENIED');
  assert.equal((await anon('api_admin_blockList', {})).status, 'DENIED');
  const r = await block(env, { from: DAY, to: DAY });
  assert.equal((await anon('api_admin_releaseBlock', { blockId: r.blockId })).status, 'DENIED');
  assert.equal(env.host.dumpSheet(env.spreadsheetId, '使用禁止').rows[0]['状態'], '有効');
}));

// ---------------------------------------------------------------- 予約表（これまでの Excel と同じ形。D-017）
/** シートの全セルを、行の配列（文字列）で読む（見出しが2行あるため、列名で読まない） */
function sheetValues(env, name) {
  const st = env.host.store;
  const sh = st.book(env.spreadsheetId).sheets.find((x) => x.name === name);
  if (!sh) return null;
  const { lastRow, lastCol } = st.dims(env.spreadsheetId, sh.sheetId);
  return st.getValues(env.spreadsheetId, sh.sheetId, 1, 1, lastRow, lastCol).map((r) => r.map(String));
}

test('管理者が登録すると、その月の「予約表」シートが Excel と同じ形で作り直される', async (t) => withEnv(t, PROD, async (env) => {
  const a = await phone(env, R[0], { date: '2026-10-26', slotId: 'S4', preferSpace: '92' });
  assert.equal(a.status, 'CONFIRMED');
  const values = sheetValues(env, '予約表 2026年10月');
  assert.ok(values, '予約表のシートが無い');
  // 1行目・2行目が見出し
  assert.deepEqual(values[0], ['', '', '駐車場枠91', '', '駐車場枠92', '', '駐車場枠93', '']);
  assert.deepEqual(values[1], ['日付', '時間帯', '申込者', '適用', '申込者', '適用', '申込者', '適用']);
  // 10月は31日×4コマ＝124行
  assert.equal(values.length - 2, 31 * 4);
  assert.deepEqual(values.slice(2, 6).map((v) => v[0] + '|' + v[1]), ['10月1日|A　8:00〜11:00', '|B　11:00〜14:00', '|C　14:00〜17:00', '|D　17:00〜翌朝8:00']);
  const row = values.find((v, i) => i > 3 && v[1].startsWith('D') && values[i - 3][0] === '10月26日');
  assert.ok(row, '10月26日の D（夜）の行が無い');
  assert.match(row[1], /^D\u300017:00〜翌朝8:00$/);
  assert.equal(row[4], R[0].name, '92番の申込者に名前が出ていない');
  assert.match(row[5], /電話/);
  assert.equal(row[2], '');
}));

test('使用禁止は予約表に「使用禁止」（管理者が使うときは「管理者」）と理由で出る。取り消すと消える', async (t) => withEnv(t, PROD, async (env) => {
  await block(env, { from: '2026-10-27', to: '2026-10-27', slots: ['S1'], spaces: ['93'], reason: '管理者が使う', memo: '清掃' });
  await block(env, { from: '2026-10-28', to: '2026-10-28', slots: ['S2'], reason: '工事・点検' });
  const a = await phone(env, R[1], { date: '2026-10-29', slotId: 'S3' });
  let tb = (await adm(env, 'api_admin_monthTable', { month: '2026-10' }));
  const cell = (tb2, d, s, sp) => tb2.rows.find((r) => r.date === d && r.slotId === s).cells[['91', '92', '93'].indexOf(sp)];
  assert.equal(cell(tb, '2026-10-27', 'S1', '93').name, '管理者');
  assert.match(cell(tb, '2026-10-27', 'S1', '93').note, /管理者が使う 清掃/);
  assert.equal(cell(tb, '2026-10-28', 'S2', '91').name, '使用禁止');
  assert.equal(cell(tb, '2026-10-29', 'S3', a.raw.spaces[0]).name, R[1].name);
  await adm(env, 'api_admin_cancel', { reservationId: a.reservationId, reason: '本人から電話', requestId: 'rq-cancel-sheet-1' });
  tb = await adm(env, 'api_admin_monthTable', { month: '2026-10' });
  assert.equal(cell(tb, '2026-10-29', 'S3', a.raw.spaces[0]).name, '');
  // シートも作り直されている
  assert.ok(!sheetValues(env, '予約表 2026年10月').some((v) => v.includes(R[1].name)), '取り消した予約が予約表のシートに残っている');
}));

test('予約表の書き出しは、まだシートの無い月でも作れる。管理者でない人は呼べない', async (t) => withEnv(t, PROD, async (env) => {
  const r = await adm(env, 'api_admin_exportMonth', { month: '2026-12' });
  assert.equal(r.status, 'OK');
  assert.equal(r.sheetName, '予約表 2026年12月');
  assert.match(r.url, /^https:\/\//);
  assert.equal(sheetValues(env, '予約表 2026年12月').length - 2, 31 * 4);
  const bad = (await env.host.run('api_admin_monthTable', [{ email: R[0].email, secret: 'wrong-secret-123' }, { month: '2026-12' }], { kind: 'client', user: R[0].email })).value;
  assert.equal(bad.status, 'DENIED');
}));

// ---------------------------------------------------------------- 住民の画面に見せる範囲（D-020）
// 今日から5日後〜2か月先だけを見せる。当日・直前の分は、見せず、申し込ませない（いま借りている人が「空いているから延ばそう」と考えないように）
const PROD_VIEW = { rules: { ...PROD.rules, residentLeadDays: 5, residentViewMonths: 2, bookingWindowDays: null } };

test('住民の画面には、今日から5日後〜2か月先の日だけを返す（その外の日は返さない）', async (t) => withEnv(t, PROD_VIEW, async (env) => {
  // 今日は 2026-10-19。5日後は 10-24、2か月先は 12-19
  const av = await env.adapter.getAvailability(env.host, { from: '2026-10-19', to: '2026-12-19' }, ACTORS.anonymous);
  assert.equal(av.raw.from, '2026-10-24');
  assert.equal(av.raw.until, '2026-12-19');
  assert.equal(av.days[0].date, '2026-10-24');
  assert.equal(av.days[av.days.length - 1].date, '2026-12-19');
  const near = await env.adapter.getAvailability(env.host, { from: '2026-10-19', to: '2026-10-23' }, ACTORS.anonymous);
  assert.equal(near.days.length, 0, '直前の日の空き具合が住民に返っている');
  const far = await env.adapter.getAvailability(env.host, { from: '2026-12-20', to: '2026-12-31' }, ACTORS.anonymous);
  assert.equal(far.days.length, 0, '2か月より先の日が住民に返っている');
}));

test('管理者の台帳には、今日から3か月先まで返す（住民に見せない直前の日も）。管理者でなければ断る', async (t) => withEnv(t, PROD_VIEW, async (env) => {
  const av = await adm(env, 'api_admin_availability', { from: '2026-10-19', to: '2026-10-25' });
  assert.equal(av.status, 'OK');
  assert.equal(av.days.length, 7);
  assert.equal(av.days[0].date, '2026-10-19');
  assert.equal(av.until, '2027-01-19');
  const denied = await env.host.run('api_admin_availability', [{ email: ACTORS.admin.email, secret: 'wrong-pass' }, { from: '2026-10-19', to: '2026-10-19' }], { kind: 'client', user: null });
  assert.equal(denied.value.status, 'DENIED');
}));

test('Web予約を始めても、住民の申込みは今日から5日後〜2か月先だけ受け付ける（電話はその外も受け付ける）', async (t) => withEnv(t, { rules: { ...PROD_VIEW.rules, residentBooking: true } }, async (env) => {
  const sub = (who, date) => env.adapter.submit(env.host, env.req(who, { date, slotId: 'S2' }), who);
  const tooSoon = await sub(R[0], '2026-10-23');
  const first = await sub(R[1], '2026-10-24');
  const last = await sub(R[2], '2026-12-19');
  const tooFar = await sub(R[3], '2026-12-20');
  assert.equal(tooSoon.status, 'REJECTED');
  assert.equal(tooSoon.reason, 'WINDOW');
  assert.equal(first.status, 'CONFIRMED');
  assert.equal(last.status, 'CONFIRMED');
  assert.equal(tooFar.status, 'REJECTED');
  assert.equal(tooFar.reason, 'WINDOW');
  // 管理者は、直前の日も電話で登録できる
  const p = await phone(env, R[4], { date: '2026-10-20', slotId: 'S2' });
  assert.equal(p.status, 'CONFIRMED');
}));

test('管理者は、過ぎた日・始まったコマも電話で登録できる（台帳をあとから直すため）。住民の申込みは断る', async (t) => withEnv(t, { rules: { ...PROD.rules, residentBooking: true, residentLeadDays: 0 } }, async (env) => {
  // 今は 2026-10-19 09:00。10-19 の第1コマは始まっている
  const av = await adm(env, 'api_admin_availability', { from: '2026-10-19', to: '2026-10-19' });
  const s1 = av.days[0].slots.find((s) => s.slotId === 'S1');
  const s3 = av.days[0].slots.find((s) => s.slotId === 'S3');
  assert.equal(s1.past, true, '始まったコマが「過ぎた」になっていない');
  assert.equal(s3.past, false);
  const started = await phone(env, R[0], { date: '2026-10-19', slotId: 'S1' });
  const yesterday = await phone(env, R[1], { date: '2026-10-18', slotId: 'S2' });
  assert.equal(started.status, 'CONFIRMED');
  assert.equal(yesterday.status, 'CONFIRMED');
  const rows = env.host.dumpSheet(env.spreadsheetId, '予約').rows;
  assert.ok(rows.some((r) => String(r['予約番号']) === String(started.reservationId)), '台帳に書かれていない');
  // 取り消しもできる
  const c = await adm(env, 'api_admin_cancel', { reservationId: yesterday.reservationId, reason: '記録の誤り', requestId: 'rq-cancel-past-1' });
  assert.equal(c.status, 'CANCELLED');
  // 住民の申込みは、過ぎた日・始まったコマを断る
  const sub = (who, o) => env.adapter.submit(env.host, env.req(who, o), who);
  const a = await sub(R[2], { date: '2026-10-18', slotId: 'S2' });
  const b = await sub(R[3], { date: '2026-10-19', slotId: 'S1' });
  assert.equal(a.status, 'REJECTED'); assert.equal(a.reason, 'PAST');
  assert.equal(b.status, 'REJECTED'); assert.equal(b.reason, 'CUTOFF');
}));

test('予約の確認の入口は、既定では閉じている（直接呼んでも何も返さない）。設定で開けると、予約番号と電話番号の下4けたで答える', async (t) => withEnv(t, PROD, async (env) => {
  const p = await phone(env, R[0], { date: '2026-10-27', slotId: 'S2' });
  assert.equal(p.status, 'CONFIRMED');
  const tail = String(env.req(R[0], {}).phone).replace(/\D/g, '').slice(-4);
  const look = (q) => env.host.run('api_lookupReservation', [q], { kind: 'client', user: null }).then((r) => r.value);
  const closed = await look({ reservationId: p.reservationId, phoneTail: tail });
  assert.equal(closed.status, 'CLOSED');
  assert.equal(closed.summary, undefined, '閉じているのに予約の中身を返している');
  // 試験のときは設定で開ける
  const r = await env.host.run('setup_init', [{ ...PROD.rules, residentLookup: true }, []], { kind: 'editor' });
  assert.equal(r.value.status, 'OK');
  const ok = await look({ reservationId: p.reservationId, phoneTail: tail });
  assert.equal(ok.status, 'OK');
  assert.equal(ok.summary.date, '2026-10-27');
  assert.equal(ok.summary.name, undefined, '名前を返している');
  const ng = await look({ reservationId: p.reservationId, phoneTail: tail === '0000' ? '1111' : '0000' });
  assert.equal(ng.status, 'NOT_FOUND');
}));

test('時間帯の呼び名 A〜D：空き状況・予約の記録・予約表に出る（A＝朝、B＝昼、C＝午後、D＝夜）', async (t) => withEnv(t, PROD, async (env) => {
  const av = await adm(env, 'api_admin_availability', { from: '2026-10-27', to: '2026-10-27' });
  assert.deepEqual(av.days[0].slots.map((s) => s.mark + s.label), ['A朝', 'B昼', 'C午後', 'D夜']);
  const p = await phone(env, R[0], { date: '2026-10-27', slotId: 'S4' });
  const row = env.host.dumpSheet(env.spreadsheetId, '予約').rows.find((x) => String(x['予約番号']) === String(p.reservationId));
  assert.match(String(row['時間帯']), /^D 夜 /);
  const tb = await adm(env, 'api_admin_monthTable', { month: '2026-10' });
  const marks = [...new Set(JSON.stringify(tb).match(/"slotText":"[A-D]/g))].map((x) => x.slice(-1)).sort();
  assert.deepEqual(marks, ['A', 'B', 'C', 'D']);
}));

test('電話連絡の一覧：未対応は全て出す。対応済みは利用日が1週間前より後の分だけ出す（一覧が年々長くならない）', async (t) => withEnv(t, PROD, async (env) => {
  const old = await phone(env, R[0], { date: '2026-10-05', slotId: 'S1' });
  const recent = await phone(env, R[1], { date: '2026-10-27', slotId: 'S1' });
  const oldTodo = await phone(env, R[2], { date: '2026-10-04', slotId: 'S2' });
  for (const p of [old, recent, oldTodo]) assert.equal(p.status, 'CONFIRMED');
  for (const p of [old, recent]) assert.equal((await adm(env, 'api_admin_markCalled', { reservationId: p.reservationId })).status, 'OK');
  const list = await adm(env, 'api_admin_callList');
  const ids = list.items.map((x) => x.reservationId);
  assert.ok(ids.includes(recent.reservationId), '最近の対応済みが出ない');
  assert.ok(!ids.includes(old.reservationId), '過ぎた対応済みがいつまでも出る');
  assert.ok(ids.includes(oldTodo.reservationId), '未対応は日付にかかわらず出す');
  const it = list.items.find((x) => x.reservationId === recent.reservationId);
  assert.equal(it.contactDone, true);
  assert.equal(it.spaces.length, 1, '区画が出ない');
}));

// ---------------------------------------------------------------- 保管（D-023）
test('保管：利用日が60日より前の予約を、割当て・通知とともに保管のシートへ移す。電話連絡が済んでいない予約は残す。2回目は何もしない', async (t) => withEnv(t, PROD, async (env) => {
  const pending = await phone(env, R[0], { date: '2026-10-20', slotId: 'S1' });   // 電話連絡がまだ
  const done = await phone(env, R[1], { date: '2026-10-21', slotId: 'S2' });      // 電話連絡が済んだ
  const later = await phone(env, R[2], { date: '2026-12-20', slotId: 'S1' });     // まだ新しい
  const cancelled = await phone(env, R[3], { date: '2026-10-22', slotId: 'S3' }); // 取り消した（連絡は残っている）
  for (const p of [pending, done, later, cancelled]) assert.equal(p.status, 'CONFIRMED');
  for (const p of [done, later]) assert.equal((await adm(env, 'api_admin_markCalled', { reservationId: p.reservationId })).status, 'OK');
  assert.equal((await adm(env, 'api_admin_cancel', { reservationId: cancelled.reservationId, reason: '本人から電話', requestId: 'rq-arc-cancel-1' })).status, 'CANCELLED');
  // 2027-01-01 になった。60日前は 2026-11-02
  env.host.setClock('2027-01-01T09:00:00+09:00');
  const denied = await env.host.run('job_archiveLedger', [], { kind: 'client', user: null });
  assert.equal(denied.value.status, 'DENIED', '誰でも保管を動かせる');
  const r = await env.host.run('job_archiveLedger', [], { kind: 'trigger' });
  assert.equal(r.value.status, 'OK');
  assert.equal(r.value.boundary, '2026-11-02');
  assert.equal(r.value.moved, 2);
  const ids = (name) => env.host.dumpSheet(env.spreadsheetId, name).rows.map((x) => String(x['予約番号']));
  assert.deepEqual(ids('予約').sort(), [pending.reservationId, later.reservationId].map(String).sort());
  assert.deepEqual(ids('予約（保管）').sort(), [done.reservationId, cancelled.reservationId].map(String).sort());
  assert.ok(ids('割当て（保管）').includes(String(done.reservationId)));
  assert.ok(!ids('割当て').includes(String(done.reservationId)), '割当てが残っている');
  assert.ok(ids('通知（保管）').includes(String(done.reservationId)));
  assert.ok(ids('通知').includes(String(pending.reservationId)), '電話連絡がまだの予約まで移した');
  // 移した行の中身はそのまま（電話番号の先頭の0も）
  const arcRow = env.host.dumpSheet(env.spreadsheetId, '予約（保管）').rows.find((x) => String(x['予約番号']) === String(done.reservationId));
  assert.match(String(arcRow['電話番号']), /^0\d/);
  assert.equal(String(arcRow['利用日']), '2026-10-21');
  // 2回目は何もしない（二重に書かない）
  const again = await env.host.run('job_archiveLedger', [], { kind: 'trigger' });
  assert.equal(again.value.moved, 0);
  assert.equal(ids('予約（保管）').length, 2);
  assert.ok(env.host.dumpSheet(env.spreadsheetId, '操作履歴').rows.some((x) => x['操作'] === '保管'), '操作履歴に残っていない');
}));

test('保管した予約も、管理者が探すと見つかり、その月の予約表にも出る。保管した日付には登録・取消しができない', async (t) => withEnv(t, PROD, async (env) => {
  const done = await phone(env, R[1], { date: '2026-10-21', slotId: 'S2' });
  await adm(env, 'api_admin_markCalled', { reservationId: done.reservationId });
  env.host.setClock('2027-01-01T09:00:00+09:00');
  await env.host.run('job_archiveLedger', [], { kind: 'trigger' });
  const name = env.req(R[1], {}).name;
  // 予約番号・名前で探すと見つかる（保管の印つき）
  const byId = await adm(env, 'api_admin_list', { reservationId: done.reservationId });
  assert.equal(byId.reservations.length, 1);
  assert.equal(byId.reservations[0].archived, true);
  assert.equal(byId.reservations[0].spaces.length, 1, '保管した割当てが読めていない');
  const byName = await adm(env, 'api_admin_list', { text: name });
  assert.ok(byName.reservations.some((x) => x.reservationId === String(done.reservationId)));
  // その週の台帳（保管した日付）にも名前が出る
  const week = await adm(env, 'api_admin_list', { from: '2026-10-19', to: '2026-10-25' });
  assert.ok(week.reservations.some((x) => x.reservationId === String(done.reservationId)));
  // 予約表（2026年10月）に出る
  const tb = await adm(env, 'api_admin_monthTable', { month: '2026-10' });
  assert.ok(JSON.stringify(tb).includes(name), '保管した予約が予約表に出ない');
  // 保管した日付には、管理者も登録・取消しができない。台帳でも「過ぎた（直せる）」にしない
  const reg = await phone(env, R[2], { date: '2026-10-25', slotId: 'S1' });
  assert.equal(reg.status, 'REJECTED');
  assert.equal(reg.reason, 'ARCHIVED');
  const can = await adm(env, 'api_admin_cancel', { reservationId: done.reservationId, reason: '本人から電話', requestId: 'rq-arc-cancel-2' });
  assert.equal(can.status, 'REJECTED');
  assert.equal(can.reason, 'ARCHIVED');
  const av = await adm(env, 'api_admin_availability', { from: '2026-10-31', to: '2026-11-03' });
  const at = (d) => av.days.find((x) => x.date === d).slots[0];
  assert.equal(at('2026-11-01').past, false, '保管した日付が直せる形になっている');
  assert.equal(at('2026-11-02').past, true, '保管していない過ぎた日付は直せる形のまま');
  // 保管していない日付（60日以内の過去）には、これまでどおり登録できる
  const ok = await phone(env, R[3], { date: '2026-11-10', slotId: 'S1' });
  assert.equal(ok.status, 'CONFIRMED');
  assert.notEqual(String(ok.reservationId), String(done.reservationId));
}));

// ---------------------------------------------------------------- 予約の変更（D-024）
test('予約の変更：日・時間帯を変えると、新しい枠を取ってから古い枠を放す。料金・時間帯の記録も変わる。同じ内容の送り直しは何も変えない', async (t) => withEnv(t, PROD, async (env) => {
  const a = await phone(env, R[0], { date: '2026-10-27', slotId: 'S2' });
  const base = env.req(R[0], {});
  const chg = (q) => adm(env, 'api_admin_change', { reservationId: a.reservationId, name: base.name, building: base.building, room: base.room, phone: base.phone, email: '', ...q });
  const r = await chg({ date: '2026-10-28', slotId: 'S4' });
  assert.equal(r.status, 'CHANGED');
  assert.equal(r.reservation.date, '2026-10-28');
  const row = env.host.dumpSheet(env.spreadsheetId, '予約').rows.find((x) => String(x['予約番号']) === String(a.reservationId));
  assert.equal(String(row['利用日']), '2026-10-28');
  assert.equal(String(row['コマID']), 'S4');
  assert.match(String(row['時間帯']), /^D 夜 /);
  assert.equal(Number(row['料金合計']), 600);
  assert.equal(String(row['状態']), '確定');
  const alc = env.host.dumpSheet(env.spreadsheetId, '割当て').rows.filter((x) => String(x['予約番号']) === String(a.reservationId));
  assert.equal(alc.filter((x) => x['状態'] === '有効').length, 1, '有効な割当てが1つでない');
  assert.equal(String(alc.find((x) => x['状態'] === '有効')['利用日']), '2026-10-28');
  assert.ok(alc.some((x) => x['状態'] === '解放' && String(x['利用日']) === '2026-10-27'), '古い枠が放されていない');
  // 空き状況：古い枠が空き、新しい枠が埋まる
  const av = await adm(env, 'api_admin_availability', { from: '2026-10-27', to: '2026-10-28' });
  assert.equal(av.days[0].slots.find((s) => s.slotId === 'S2').remaining, 3);
  assert.equal(av.days[1].slots.find((s) => s.slotId === 'S4').remaining, 2);
  // 同じ内容の送り直し
  const again = await chg({ date: '2026-10-28', slotId: 'S4' });
  assert.equal(again.status, 'CHANGED');
  assert.equal(again.already, true);
  assert.equal(env.host.dumpSheet(env.spreadsheetId, '割当て').rows.filter((x) => String(x['予約番号']) === String(a.reservationId)).length, 2, '送り直しで割当てが増えた');
  assert.ok(env.host.dumpSheet(env.spreadsheetId, '操作履歴').rows.some((x) => x['操作'] === '変更' && /2026-10-27 B→2026-10-28 D/.test(String(x['内容']))), '操作履歴に変更が残っていない');
}));

test('予約の変更：変更先が満車なら何も変えずに断る。同じコマの中で区画だけ変えるときは、自分の分を数えない', async (t) => withEnv(t, PROD, async (env) => {
  const a = await phone(env, R[0], { date: '2026-10-27', slotId: 'S1', preferSpace: '91' });
  const b = await phone(env, R[1], { date: '2026-10-27', slotId: 'S1', preferSpace: '92' });
  const c = await phone(env, R[2], { date: '2026-10-27', slotId: 'S3' });
  const d = await phone(env, R[3], { date: '2026-10-27', slotId: 'S3' });
  const e = await phone(env, R[4], { date: '2026-10-27', slotId: 'S3' }); // 管理者は3台目まで（D-040）
  for (const p of [a, b, c, d, e]) assert.equal(p.status, 'CONFIRMED');
  const base = env.req(R[0], {});
  const chg = (q) => adm(env, 'api_admin_change', { reservationId: a.reservationId, name: base.name, room: base.room, phone: base.phone, ...q });
  const full = await chg({ date: '2026-10-27', slotId: 'S3' });
  assert.equal(full.status, 'REJECTED');
  assert.equal(full.reason, 'FULL');
  const row = env.host.dumpSheet(env.spreadsheetId, '予約').rows.find((x) => String(x['予約番号']) === String(a.reservationId));
  assert.equal(String(row['コマID']), 'S1', '断ったのに予約が変わった');
  // 91・92 が埋まっていても、自分の区画を 91→93 に移すことはできる
  const sp = await chg({ date: '2026-10-27', slotId: 'S1', preferSpace: '93' });
  assert.equal(sp.status, 'CHANGED');
  assert.deepEqual(sp.reservation.spaces, ['93']);
  // 名前だけ直す：割当ては変えない
  const before = env.host.dumpSheet(env.spreadsheetId, '割当て').rows.length;
  const nm = await chg({ date: '2026-10-27', slotId: 'S1', preferSpace: '93', name: '直した 名前' });
  assert.equal(nm.status, 'CHANGED');
  assert.equal(env.host.dumpSheet(env.spreadsheetId, '割当て').rows.length, before, '名前だけの変更で割当てが動いた');
  assert.equal(env.host.dumpSheet(env.spreadsheetId, '予約').rows.find((x) => String(x['予約番号']) === String(a.reservationId))['氏名'], '直した 名前');
}));

test('予約の変更：取り消した予約・管理者でない人・入力の誤りは断る', async (t) => withEnv(t, PROD, async (env) => {
  const a = await phone(env, R[0], { date: '2026-10-27', slotId: 'S1' });
  const base = env.req(R[0], {});
  const q = { reservationId: a.reservationId, date: '2026-10-29', slotId: 'S1', name: base.name, room: base.room, phone: base.phone };
  const denied = await env.host.run('api_admin_change', [{ email: ACTORS.admin.email, secret: 'wrong-pass' }, q], { kind: 'client', user: null });
  assert.equal(denied.value.status, 'DENIED');
  const bad = await adm(env, 'api_admin_change', { ...q, name: '' });
  assert.equal(bad.status, 'REJECTED');
  assert.equal(bad.reason, 'INVALID');
  await adm(env, 'api_admin_cancel', { reservationId: a.reservationId, reason: '本人から電話', requestId: 'rq-chg-cancel-1' });
  const gone = await adm(env, 'api_admin_change', q);
  assert.equal(gone.status, 'REJECTED');
  assert.equal(gone.reason, 'NOT_CONFIRMED');
}));
