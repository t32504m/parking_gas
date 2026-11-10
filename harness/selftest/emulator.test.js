'use strict';
// エミュレータ自体の試験。ASSUMPTIONS.md に書いた「実GASの挙動の仮定」をコードとして固定する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GasHost } = require('../emulator/host');

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gasproj-'));
  fs.writeFileSync(path.join(dir, 'appsscript.json'), JSON.stringify({ timeZone: 'Asia/Tokyo', runtimeVersion: 'V8', webapp: { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' } }));
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
  return dir;
}
async function host(files, opts = {}) {
  const h = new GasHost({ projectDir: project(files), now: '2026-10-19T09:00:00+09:00', ...opts });
  h.createSpreadsheet({ id: 'S', sheets: ['A'] });
  return h;
}
const SH = "function sh_(){ return SpreadsheetApp.openById('S').getSheetByName('A'); }\n";

test('A-01〜A-04 文字列の自動変換（日付・数値・真偽値・年なし日付・ISO形式は文字列のまま）', async () => {
  const h = await host({ 'a.gs': `${SH}function f(){ sh_().appendRow(['2026-10-20','09012345678','TRUE','10/20','2026-10-20T08:00:00+09:00',"'0123",'S1','8:00']); return sh_().getRange(1,1,1,8).getValues()[0].map(function(v){return (v instanceof Date)?'D':typeof v;}); }` });
  const r = await h.run('f', [], { kind: 'editor' });
  assert.deepEqual(r.value, ['D', 'number', 'boolean', 'D', 'string', 'string', 'string', 'D']);
  await h.close();
});

test('A-07 getRange の行数0はエラー（getLastRow()=1 のときの getRange(2,1,0,n) の落とし穴）', async () => {
  const h = await host({ 'a.gs': `${SH}function f(){ return sh_().getRange(2,1,sh_().getLastRow()-1,3).getValues(); }` });
  const r = await h.run('f', [], { kind: 'editor' });
  assert.equal(r.ok, false);
  assert.match(r.error.message, /number of rows in the range must be at least 1/);
  await h.close();
});

test('A-08 シートの最大行(1000)を超える getRange への書込みはエラー、appendRow は伸びる', async () => {
  const h = await host({ 'a.gs': `${SH}function f(){ try { sh_().getRange(1001,1).setValue('x'); return 'no-error'; } catch(e) { sh_().appendRow(['y']); return e.message + '|' + sh_().getMaxRows(); } }` });
  const r = await h.run('f', [], { kind: 'editor' });
  assert.match(r.value, /outside the dimensions/);
  await h.close();
});

test('A-20 google.script.run の戻り値に Date があると null になり、警告が残る', async () => {
  const h = await host({ 'a.gs': 'function f(){ return { a: 1, d: new Date() }; }' });
  const r = await h.run('f', [], { kind: 'client' });
  assert.equal(r.value, null);
  assert.equal(h.warnings[0].code, 'CLIENT_FORBIDDEN_RETURN');
  await h.close();
});

test('A-21 末尾 _ の関数は google.script.run から呼べない（トリガーからは呼べる）', async () => {
  const h = await host({ 'a.gs': 'function p_(){ return 1; }' });
  assert.match((await h.run('p_', [], { kind: 'client' })).error.message, /Script function not found/);
  assert.equal((await h.run('p_', [], { kind: 'trigger' })).value, 1);
  await h.close();
});

test('A-10 USER_DEPLOYING では、所有者以外の利用者のメールは取得できない', async () => {
  const h = await host({ 'a.gs': 'function f(){ return [Session.getActiveUser().getEmail(), Session.getEffectiveUser().getEmail()]; }' });
  assert.deepEqual((await h.run('f', [], { kind: 'client', user: 'someone@gmail.com' })).value, ['', 'owner@example.com']);
  assert.deepEqual((await h.run('f', [], { kind: 'client', user: 'owner@example.com' })).value, ['owner@example.com', 'owner@example.com']);
  await h.close();
});

test('A-11 USER_ACCESSING ではアクセスした本人のメールが取れる', async () => {
  const h = await host({ 'a.gs': 'function f(){ return Session.getActiveUser().getEmail(); }' }, { deployment: { executeAs: 'USER_ACCESSING', access: 'ANYONE' } });
  assert.equal((await h.run('f', [], { kind: 'client', user: 'someone@gmail.com' })).value, 'someone@gmail.com');
  assert.equal((await h.run('f', [], { kind: 'client', user: null })).denied, true);
  await h.close();
});

test('A-30 waitLock はタイムアウトで例外、実行終了でロックは解放される', async () => {
  const h = await host({ 'a.gs': "function hold(){ LockService.getScriptLock().waitLock(1000); Utilities.sleep(400); return 'held'; }\nfunction tryit(){ try { LockService.getScriptLock().waitLock(50); return 'got'; } catch(e) { return e.message; } }" });
  const [a, b] = await h.runConcurrently([{ fn: 'hold' }, { fn: 'tryit' }]);
  assert.equal(a.value, 'held');
  assert.ok(['got', 'Lock timeout: another process was holding the lock for too long.'].includes(b.value));
  assert.equal((await h.run('tryit')).value, 'got', '前の実行が終わればロックは解放される');
  await h.close();
});

test('A-31 実行ごとにグローバル変数は初期化される', async () => {
  const h = await host({ 'a.gs': 'var n = 0; function inc(){ n++; return n; }' });
  assert.equal((await h.run('inc')).value, 1);
  assert.equal((await h.run('inc')).value, 1);
  await h.close();
});

test('A-32 サーバー側に setTimeout・require・process は無い', async () => {
  const h = await host({ 'a.gs': 'function f(){ return [typeof setTimeout, typeof require, typeof process, typeof Buffer, typeof fetch]; }' });
  assert.deepEqual((await h.run('f')).value, ['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  await h.close();
});

test('A-33 Utilities.formatDate は指定タイムゾーンで書式化する', async () => {
  const h = await host({ 'a.gs': "function f(){ var d = new Date('2026-10-26T17:00:00+09:00'); return [Utilities.formatDate(d,'Asia/Tokyo',\"yyyy-MM-dd'T'HH:mm:ssXXX\"), Utilities.formatDate(d,'UTC','yyyy/MM/dd HH:mm EEE'), Utilities.formatDate(new Date(d.getTime()+15*3600000),'Asia/Tokyo','M/d H:mm')]; }" });
  assert.deepEqual((await h.run('f')).value, ['2026-10-26T17:00:00+09:00', '2026/10/26 08:00 Mon', '10/27 8:00']);
  await h.close();
});

test('A-34 仮想時計：new Date() と Date.now() は試験の時刻になる', async () => {
  const h = await host({ 'a.gs': "function f(){ return [Utilities.formatDate(new Date(),'Asia/Tokyo','yyyy-MM-dd HH:mm'), new Date() instanceof Date]; }" });
  assert.deepEqual((await h.run('f')).value, ['2026-10-19 09:00', true]);
  h.advanceClock(3600000);
  assert.equal((await h.run('f')).value[0], '2026-10-19 10:00');
  await h.close();
});

test('A-40 メール：宛先なし・不正な宛先・1日上限はエラー', async () => {
  const h = await host({ 'a.gs': "function f(to){ try { MailApp.sendEmail(to,'s','b'); return 'ok'; } catch(e) { return e.message; } }" }, { mailQuota: 1 });
  assert.match((await h.run('f', [''])).value, /no recipient/);
  assert.match((await h.run('f', ['not-an-address'])).value, /Invalid email/);
  assert.equal((await h.run('f', ['a@example.com'])).value, 'ok');
  assert.match((await h.run('f', ['b@example.com'])).value, /too many times/);
  await h.close();
});

test('A-50 HTMLテンプレート：<?= ?> はエスケープ、<?!= ?> はそのまま、存在しないファイルはエラー', async () => {
  const h = await host({ 'a.gs': "function f(){ var t = HtmlService.createTemplateFromFile('T'); t.x = '<b>'; return t.evaluate().getContent(); }\nfunction g(){ return HtmlService.createHtmlOutputFromFile('Nope').getContent(); }", 'T.html': '<?= x ?>|<?!= x ?>' });
  assert.equal((await h.run('f')).value, '&lt;b&gt;|<b>');
  assert.match((await h.run('g')).error.message, /No HTML file named Nope was found/);
  await h.close();
});

test('A-51 <?= ?> は <script> 内では JavaScript の値として出力される', async () => {
  const h = await host({ 'a.gs': "function f(){ var t = HtmlService.createTemplateFromFile('T'); t.m = 'a\"</script>'; return t.evaluate().getContent(); }", 'T.html': '<p><?= m ?></p><script>var M = <?= m ?>;</script>' });
  assert.equal((await h.run('f')).value, '<p>a&#34;&lt;/script&gt;</p><script>var M = "a\\"\\u003c/script\\u003e";</script>');
  await h.close();
});

test('A-60 同名の最上位関数は後に読み込まれたファイルが勝つ（lint で検出すべき落とし穴）', async () => {
  const h = await host({ 'a.gs': "function f(){ return 'a'; }", 'b.gs': "function f(){ return 'b'; }" });
  assert.equal((await h.run('f')).value, 'b');
  await h.close();
});

test('競合の再現：ロックなしの読込→書込は、並行実行で二重書込みが起きる', async () => {
  const code = `${SH}function book(){ if (sh_().getLastRow() >= 1) return 'FULL'; sh_().appendRow(['x']); return 'OK'; }\nfunction bookSafe(){ var l = LockService.getScriptLock(); l.waitLock(10000); try { return book(); } finally { SpreadsheetApp.flush(); l.releaseLock(); } }`;
  let unsafeDup = 0;
  for (let i = 0; i < 3; i++) {
    const h = await host({ 'a.gs': code }, { latency: { min: 2, max: 15 }, seed: i + 1 });
    const rs = await h.runConcurrently([1, 2, 3, 4].map(() => ({ fn: 'book' })));
    if (rs.filter((r) => r.value === 'OK').length > 1) unsafeDup++;
    await h.close();
  }
  assert.ok(unsafeDup >= 2, `ロックなしでも二重書込みが再現しない（${unsafeDup}/3）。エミュレータが競合を隠している`);
  const h = await host({ 'a.gs': code }, { latency: { min: 2, max: 15 } });
  const rs = await h.runConcurrently([1, 2, 3, 4].map(() => ({ fn: 'bookSafe' })));
  assert.equal(rs.filter((r) => r.value === 'OK').length, 1);
  await h.close();
});

test('A-82 書込みはflush前にロックを解放すると他の実行から見えないことがある（flushすれば防げる）', async () => {
  const code = `${SH}function bookNoFlush(){ var l = LockService.getScriptLock(); l.waitLock(10000); try { if (sh_().getLastRow() >= 1) return 'FULL'; sh_().appendRow(['x']); return 'OK'; } finally { l.releaseLock(); } }\nfunction bookFlush(){ var l = LockService.getScriptLock(); l.waitLock(10000); try { if (sh_().getLastRow() >= 1) return 'FULL'; sh_().appendRow(['x']); SpreadsheetApp.flush(); return 'OK'; } finally { l.releaseLock(); } }`;
  let dup = 0;
  for (let i = 0; i < 3; i++) {
    const h = await host({ 'a.gs': code }, { latency: { min: 2, max: 10 }, seed: 50 + i });
    const rs = await h.runConcurrently([1, 2, 3, 4].map(() => ({ fn: 'bookNoFlush' })));
    if (rs.filter((r) => r.value === 'OK').length > 1) dup++;
    await h.close();
  }
  assert.ok(dup >= 1, 'flush 無しのロック解放で、古い内容の読取りが再現しない');
  const h = await host({ 'a.gs': code }, { latency: { min: 2, max: 10 } });
  const rs = await h.runConcurrently([1, 2, 3, 4].map(() => ({ fn: 'bookFlush' })));
  assert.equal(rs.filter((r) => r.value === 'OK').length, 1);
  await h.close();
});
