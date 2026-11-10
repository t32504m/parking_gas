/**
 * 保管（D-023）。利用日が古い予約を「予約（保管）」などのシートへ移し、日々使うシートの行数を増やさない。
 * ・申込み・空き状況・通知は、日々使うシートだけを読む。行が年々増えても、1件の処理が重くならない。
 * ・移すのは、利用日が今日から archiveAfterDays 日（既定 60日）より前の予約と、その割当て・通知。
 *   確定している予約で、電話連絡がまだ済んでいない・メールがまだ送れていないものは移さない（一覧から消えないように）。
 * ・管理者が探すとき・古い月の予約表を出すときは、保管のシートも読む。
 * ・保管した日付には、管理者も登録・取消しができない（数え直しができないため）。
 * ・毎日、時間主導トリガー（job_archiveLedger）で動く。止まっていても、次に動いたときにまとめて移す。
 */
// ファイルの読み込み順に頼らないよう、他のファイルの定数は関数の中で使う
function archiveOf_(name) {
  var m = {};
  m[SHEETS.RES] = SHEETS.RES_ARC; m[SHEETS.ALC] = SHEETS.ALC_ARC; m[SHEETS.NTF] = SHEETS.NTF_ARC;
  return m[name];
}
/**
 * 通知がこの状態の予約は、まだ用があるので移さない（電話連絡がまだ）。
 * メールは利用日の前日の案内なので（D-030）、利用日を過ぎた予約の「未送信」「再送待ち」には、もう用がない
 */
function archiveHold_() { return [NTF_ST.PHONE]; }

function job_archiveLedger() {
  if (!isOwnerRun_()) return { status: 'DENIED' };
  return archiveLedger_();
}

function archiveLedger_() {
  return withLock_(function () {
    tidyAllocs_(); // 止まった実行の残骸を、毎晩ここで片付ける（D-026）
    var boundary = archiveBoundary_(todayYmd_());
    var res = readAll_(SHEETS.RES);
    var alc = readAll_(SHEETS.ALC);
    var ntf = readAll_(SHEETS.NTF);
    // 確定している予約で、電話連絡やメールがまだのものは移さない（取り消した予約は、連絡が残っていても移す）
    var confirmed = {};
    res.forEach(function (r) { if (r['状態'] === ST.CONFIRMED) confirmed[String(r['予約番号'])] = true; });
    var hold = {}, holdSt = archiveHold_();
    ntf.forEach(function (n) { var id = String(n['予約番号']); if (confirmed[id] && holdSt.indexOf(String(n['状態'])) >= 0) hold[id] = true; });
    var move = {}, count = 0;
    res.forEach(function (r) {
      var id = String(r['予約番号']);
      if (String(r['利用日']) < boundary && !hold[id] && !move[id]) { move[id] = true; count++; }
    });
    if (!count) return { status: 'OK', moved: 0, boundary: boundary };
    var out = {};
    [[SHEETS.ALC, alc], [SHEETS.NTF, ntf], [SHEETS.RES, res]].forEach(function (p) {
      // 前回が途中で止まり、このシートの保管の側に書き終えていた予約は、二重に書かない
      // （シートごとに見る。割当て・通知を書いた後、予約を書く前に止まることがあるため）
      var done = archiveKeys_(archiveOf_(p[0])).ids;
      var keep = [], moved = [];
      p[1].forEach(function (x) { (move[String(x['予約番号'])] ? moved : keep).push(x); });
      // 保管の側へ先に書き、反映してから、日々使うシートを書き直す（途中で止まっても、予約が消えることはない）
      appendRows_(archiveOf_(p[0]), moved.filter(function (x) { return !done[String(x['予約番号'])]; }));
      SpreadsheetApp.flush();
      rewriteRows_(p[0], keep, p[1].length);
      out[p[0]] = moved.length;
    });
    audit_('保管', 'システム', '', '', boundary + ' より前の予約 ' + count + '件を保管のシートへ移した');
    return { status: 'OK', moved: count, boundary: boundary, rows: out };
  });
}

/** 保管の境目：この日より前の利用日は、保管のシートにある（または、次に移す） */
function archiveBoundary_(today) {
  var n = Number(rules_().archiveAfterDays);
  return addDaysYmd_(today, -(n > 0 ? n : 60));
}

/**
 * 保管のシートの予約番号（1列目）。予約（保管）は受付要求ID（2列目）も。全ての列は読まない。
 * 1回の実行の中では1回だけ読む（置き場所は readAll_ と同じで、ロックの出入りで捨てる）
 */
function archiveKeys_(arcName) {
  var key = '#keys:' + arcName;
  if (ledgerCache_.rows[key]) return ledgerCache_.rows[key];
  var out = { ids: {}, requestIds: {} };
  var sh = sheetOrNull_(arcName);
  var last = sh ? sh.getLastRow() : 0;
  var nc = arcName === SHEETS.RES_ARC ? 2 : 1;
  if (last >= 2) sh.getRange(2, 1, last - 1, nc).getValues().forEach(function (v) { out.ids[String(v[0])] = true; if (nc === 2) out.requestIds[String(v[1])] = true; });
  ledgerCache_.rows[key] = out;
  return out;
}

/** 保管の予約番号（予約番号を作るときの重複よけ） */
function archivedIds_() { return archiveKeys_(SHEETS.RES_ARC).ids; }

/** 受付要求IDで、保管した予約を探す（無ければ null）。保管の受付要求IDの列に無ければ、全ての列は読まない */
function archivedByRequestId_(requestId) {
  if (!archiveKeys_(SHEETS.RES_ARC).requestIds[requestId]) return null;
  return readArchive_(SHEETS.RES).filter(function (x) { return String(x['受付要求ID']) === requestId; })[0] || null;
}

/** 保管のシートの全行（_arc: true を付ける。シートが無ければ空） */
function readArchive_(name) {
  var arc = archiveOf_(name);
  if (!sheetOrNull_(arc)) return [];
  return readAll_(arc).map(function (x) { x._arc = true; return x; });
}

/**
 * 日々使うシートと保管のシートを合わせて読む。
 * 同じ予約番号が両方にあるとき（移す途中で止まったとき）は、日々使うシートの方を使う。
 */
function readWithArchive_(name) {
  var rows = readAll_(name);
  var seen = {};
  rows.forEach(function (r) { seen[String(r['予約番号'])] = true; });
  return rows.concat(readArchive_(name).filter(function (r) { return !seen[String(r['予約番号'])]; }));
}
