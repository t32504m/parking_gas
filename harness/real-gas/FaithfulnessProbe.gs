/**
 * 実環境プローブ：エミュレータの仮定（ASSUMPTIONS.md）が本物の GAS で正しいかを確かめる。
 *
 * 使い方（人が行う。製品とは別の、使い捨ての GAS プロジェクトで行うこと）
 *  1. https://script.google.com で新しいプロジェクトを作り、このファイルと ProbePage.html を貼る。
 *     プロジェクトの設定でタイムゾーンを「(GMT+09:00) 日本標準時」にする。
 *  2. エディタで probe_runAll を実行（初回は権限の許可が必要）。
 *     → 実行ログに出る JSON を harness/real-gas/results/editor.json として保存。
 *  3. probe_setupTrigger を実行し、2分ほど待ってから probe_readTriggerResult を実行。
 *     → ログの JSON を harness/real-gas/results/trigger.json として保存。
 *  4. 「デプロイ > 新しいデプロイ > ウェブアプリ」で、次の2通りを作る。
 *     (a) 実行ユーザー: 自分 ／ アクセス: 全員
 *     (b) 実行ユーザー: ウェブアプリにアクセスしているユーザー ／ アクセス: Google アカウントを持つ全員
 *     それぞれの URL を、自分のアカウントと「別の Google アカウント」でスマホから開き、
 *     画面に出る JSON を results/web-a-owner.json, web-a-other.json, web-b-other.json のように保存。
 *  5. node harness/real-gas/compare.js harness/real-gas/results/*.json で、仮定との一致を確認する。
 */

function probe_runAll() {
  var out = { kind: 'editor', at: new Date().toISOString(), tz: Session.getScriptTimeZone(), results: {}, timings: {} };
  var ss = SpreadsheetApp.create('probe-' + Date.now());
  var sh = ss.getSheets()[0];
  try {
    // A-01〜A-04 自動変換
    sh.getRange(1, 1, 1, 8).setValues([['2026-10-20', '09012345678', 'TRUE', '10/20', '2026-10-20T08:00:00+09:00', "'0123", 'S1', '8:00']]);
    out.results.autoConvert = sh.getRange(1, 1, 1, 8).getValues()[0].map(function (v) { return v instanceof Date ? 'Date:' + Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : typeof v + ':' + v; });
    // A-05 書式なしテキストのセルにアポストロフィ付きで書く
    sh.getRange(2, 1).setNumberFormat('@').setValue("'0123");
    sh.getRange(2, 2).setNumberFormat('@').setValue('0123');
    out.results.plainTextApostrophe = [sh.getRange(2, 1).getValue(), sh.getRange(2, 2).getValue()];
    // A-06 書式を付けた範囲より下に appendRow したときの書式の引継ぎ
    var sh2 = ss.insertSheet('fmt');
    sh2.getRange(1, 1, 3, 1).setNumberFormat('@');
    sh2.getRange(1, 1, 3, 1).setValues([['a'], ['b'], ['c']]);
    sh2.appendRow(['0456']);
    out.results.appendBelowFormatted = { value: sh2.getRange(4, 1).getValue(), type: typeof sh2.getRange(4, 1).getValue(), format: sh2.getRange(4, 1).getNumberFormat() };
    // A-07 行数0の getRange
    try { sh.getRange(2, 1, 0, 1); out.results.zeroRows = 'no-error'; } catch (e) { out.results.zeroRows = e.message; }
    // A-08 最大行を超える getRange
    try { sh.getRange(sh.getMaxRows() + 1, 1).setValue('x'); SpreadsheetApp.flush(); out.results.beyondMaxRows = 'no-error'; } catch (e) { out.results.beyondMaxRows = e.message; }
    // A-30 waitLock のタイムアウト文言は同時実行でしか出ないため、tryLock(0) の挙動のみ
    var lock = LockService.getScriptLock();
    out.results.tryLockFree = lock.tryLock(0); lock.releaseLock();
    // A-33 formatDate
    var d = new Date('2026-10-26T17:00:00+09:00');
    out.results.formatDate = [Utilities.formatDate(d, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ssXXX"), Utilities.formatDate(d, 'UTC', 'yyyy/MM/dd HH:mm EEE'), Utilities.formatDate(new Date(d.getTime() + 15 * 3600000), 'Asia/Tokyo', 'M/d H:mm')];
    out.results.newDateYmd = new Date('2026-10-26').getHours();
    // A-40 メール残り
    out.results.mailQuota = MailApp.getRemainingDailyQuota();
    // A-32 サーバー側に無いもの
    out.results.globals = [typeof setTimeout, typeof require, typeof process, typeof Buffer, typeof fetch, typeof structuredClone];
    // A-50/51 テンプレートの文脈エスケープ
    var t = HtmlService.createTemplate('<p><?= m ?></p><script>var M = <?= m ?>;</script>');
    t.m = 'a"</script>';
    out.results.templateEscape = t.evaluate().getContent();
    // A-70 1操作あたりの所要時間（コストモデルの校正）
    var id = ss.getId();
    var data = []; for (var i = 0; i < 50; i++) data.push(['r' + i, i, 'x']);
    sh2.getRange(10, 1, 50, 3).setValues(data); SpreadsheetApp.flush();
    out.timings = {
      'ss.open': time_(function () { SpreadsheetApp.openById(id); }, 5),
      'sh.get': time_(function () { SpreadsheetApp.openById(id).getSheetByName('fmt').getRange(10, 1, 50, 3).getValues(); }, 5),
      'sh.dims': time_(function () { sh2.getLastRow(); }, 5),
      'sh.set': time_(function () { sh2.getRange(70, 1).setValue('y'); SpreadsheetApp.flush(); }, 5),
      'sh.append': time_(function () { sh2.appendRow(['z', 1, 2]); SpreadsheetApp.flush(); }, 5),
      'sh.find': time_(function () { sh2.createTextFinder('r42').findNext(); }, 5),
      'lock.acquire': time_(function () { var l = LockService.getScriptLock(); l.waitLock(1000); l.releaseLock(); }, 5),
      'props': time_(function () { PropertiesService.getScriptProperties().getProperty('x'); }, 5),
      'cache': time_(function () { CacheService.getScriptCache().get('x'); }, 5),
    };
  } finally {
    try { DriveApp.getFileById(ss.getId()).setTrashed(true); } catch (e) { out.cleanup = '一時スプレッドシートを手で削除してください: ' + ss.getName(); }
  }
  Logger.log(JSON.stringify(out));
  return out;
}

function time_(fn, n) {
  var ts = [];
  for (var i = 0; i < n; i++) { var t0 = Date.now(); fn(); ts.push(Date.now() - t0); }
  ts.sort(function (a, b) { return a - b; });
  return ts[Math.floor(ts.length / 2)];
}

// ---- トリガーの確認（A-12, A-21, A-22）
function probe_setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  PropertiesService.getScriptProperties().deleteProperty('PROBE_TRIGGER');
  ScriptApp.newTrigger('probe_triggerHandler_').timeBased().after(60 * 1000).create();
  Logger.log('1〜2分後に probe_readTriggerResult を実行してください');
}
function probe_triggerHandler_(e) {
  PropertiesService.getScriptProperties().setProperty('PROBE_TRIGGER', JSON.stringify({
    ran: true, activeUser: Session.getActiveUser().getEmail(), effectiveUser: Session.getEffectiveUser().getEmail(),
    hasEvent: !!e, triggerUid: e && e.triggerUid,
  }));
}
function probe_readTriggerResult() {
  var r = PropertiesService.getScriptProperties().getProperty('PROBE_TRIGGER');
  var out = { kind: 'trigger', privateHandlerRan: !!r, detail: r ? JSON.parse(r) : null, remainingTriggers: ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }) };
  Logger.log(JSON.stringify(out));
  return out;
}

// ---- ウェブアプリの確認（A-10, A-11, A-20, A-21, A-52, A-71）
function doGet(e) {
  var t = HtmlService.createTemplateFromFile('ProbePage');
  t.withMeta = !!(e && e.parameter && e.parameter.meta);
  var out = t.evaluate().setTitle('probe');
  if (t.withMeta) out.addMetaTag('viewport', 'width=device-width, initial-scale=1');
  return out;
}
function probe_whoami() {
  return { active: Session.getActiveUser().getEmail(), effective: Session.getEffectiveUser().getEmail(), tempKey: !!Session.getTemporaryActiveUserKey() };
}
function probe_returnDate() { return { n: 1, d: new Date() }; }
function probe_ping() { return 1; }
function probe_hidden_() { return 'private'; }
