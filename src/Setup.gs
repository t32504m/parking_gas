/**
 * 初期設定（運用担当者がエディタから実行する）。手順は docs/SETUP.md。
 * どちらも所有者本人の実行でなければ何もしない（Webアプリ経由で他人が呼んでも無効）。
 */

/** エディタから実行する初期設定。スクリプトプロパティの SPREADSHEET_ID・ADMIN_INVITES（任意）・RULES（任意）を使う */
function setup_run() {
  if (!isOwnerRun_()) return { status: 'DENIED' };
  var p = props_();
  var invites = String(p.getProperty('ADMIN_INVITES') || '').split(/[;\n]/).map(function (x) { return x.trim(); }).filter(String).map(function (line) {
    var a = line.split(',').map(function (x) { return x.trim(); });
    return { email: a[0], name: a[1], secret: a[2] };
  });
  var r = setupCore_(p.getProperty('RULES') ? JSON.parse(p.getProperty('RULES')) : DEFAULT_RULES, invites, true);
  p.deleteProperty('ADMIN_INVITES'); // パスコードの平文を残さない
  console.log(JSON.stringify(r));
  return r;
}

/** 試験・自動化用の初期設定（内容は setup_run と同じ） */
function setup_init(rules, admins) {
  if (!isOwnerRun_()) return { status: 'DENIED' };
  return setupCore_(rules || DEFAULT_RULES, admins || [], false);
}

function setupCore_(rules, admins, installTriggers) {
  var p = props_();
  var ss = spreadsheet_();
  Object.keys(COLS).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    var cols = COLS[name];
    sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
    sh.setFrozenRows(1);
  });
  var store = admins_();
  (admins || []).forEach(function (a) {
    var email = normEmail_(a.email);
    if (!email || normSecret_(String(a.secret || '')).length < 8) throw new Error('管理者の設定が不正です（メールと8文字以上のパスコードが必要）: ' + email);
    // メールの形を確かめる（D-039。前に、先頭に「(」が付いたまま登録され、ログインできなくなった）
    if (!/^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(email)) throw new Error('管理者のメールアドレスの形が正しくありません（かっこや空白、全角の文字が入っていないか見てください）: ' + email);
    var salt = Utilities.getUuid();
    store[email] = { name: String(a.name || email), salt: salt, hash: hashSecret_(salt, normSecret_(String(a.secret))) };
  });
  p.setProperty('ADMINS', JSON.stringify(store));
  var merged = {};
  Object.keys(DEFAULT_RULES).forEach(function (k) { merged[k] = rules && rules[k] !== undefined ? rules[k] : DEFAULT_RULES[k]; });
  p.setProperty('RULES', JSON.stringify(merged));
  rulesCache_ = null; propsCache_ = null;
  if (installTriggers) {
    // 通知（D-030）：前の版の5分ごとのトリガーを消し、1日1回（RULES.remindHour の時）のトリガーを作り直す。
    // 時刻を変えたときも、setup_run を実行し直せば作り直される
    ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'job_processNotifications') ScriptApp.deleteTrigger(t); });
    ScriptApp.newTrigger('job_processNotifications').timeBased().everyDays(1).atHour(remindHour_()).inTimezone(TZ).create();
    var has = ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
    // 保管（D-023）：毎日、夜中に古い予約を保管のシートへ移す
    if (has.indexOf('job_archiveLedger') < 0) ScriptApp.newTrigger('job_archiveLedger').timeBased().everyDays(1).atHour(3).create();
  }
  SpreadsheetApp.flush();
  return { status: 'OK', admins: Object.keys(store).length, rules: merged, version: APP_VERSION };
}
