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
    var salt = Utilities.getUuid();
    store[email] = { name: String(a.name || email), salt: salt, hash: hashSecret_(salt, normSecret_(String(a.secret))) };
  });
  p.setProperty('ADMINS', JSON.stringify(store));
  var merged = {};
  Object.keys(DEFAULT_RULES).forEach(function (k) { merged[k] = rules && rules[k] !== undefined ? rules[k] : DEFAULT_RULES[k]; });
  p.setProperty('RULES', JSON.stringify(merged));
  if (installTriggers) {
    var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'job_processNotifications'; });
    if (!has) ScriptApp.newTrigger('job_processNotifications').timeBased().everyMinutes(5).create();
    // 保管（D-023）：毎日、夜中に古い予約を保管のシートへ移す
    var hasArc = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'job_archiveLedger'; });
    if (!hasArc) ScriptApp.newTrigger('job_archiveLedger').timeBased().everyDays(1).atHour(3).create();
  }
  SpreadsheetApp.flush();
  return { status: 'OK', admins: Object.keys(store).length, rules: merged, version: APP_VERSION };
}
