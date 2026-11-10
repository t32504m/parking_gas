/**
 * 台帳（スプレッドシート）の読み書き。
 * ・文字列は先頭にアポストロフィを付けて書き、日付・数値への自動変換を防ぐ（電話番号の先頭0、日付文字列など）。
 * ・1実行の中ではスプレッドシートを1回だけ開き、シートも1回だけ探す。
 * ・1実行の中で読んだシートの行は置いておき、同じシートを読み直さない（rows）。
 *   ロックに入るとき・出るときに捨てる（ロックの外で読んだ行で、ロックの中の判定をしないため）。
 *   この実行で書いた行は、置いてある行にも同じ変更をする。
 */
var ledgerCache_ = { ss: null, sheets: {}, rows: {} };

function ss_() {
  if (!ledgerCache_.ss) ledgerCache_.ss = spreadsheet_();
  return ledgerCache_.ss;
}

/** シートを返す。無ければ null（保管・使用禁止のシートは、前の版の初期設定では作っていないため） */
function sheetOrNull_(name) {
  if (!(name in ledgerCache_.sheets)) ledgerCache_.sheets[name] = ss_().getSheetByName(name);
  return ledgerCache_.sheets[name];
}

function sheet_(name) {
  var sh = sheetOrNull_(name);
  if (!sh) throw new Error('シート「' + name + '」がありません。初期設定を実行してください');
  return sh;
}

/** 置いてある行を捨てる（ロックに入るとき・出るとき） */
function forgetRows_() { ledgerCache_.rows = {}; }

function rowValues_(name, o) { return COLS[name].map(function (c) { return cellValue_(o[c]); }); }

/** 何行かをまとめて末尾に書く（1回の書込み）。足りない行は先に足す */
function appendRows_(name, objs) {
  if (!objs.length) return;
  var sh = sheet_(name);
  var last = Math.max(sh.getLastRow(), 1);
  var lack = last + objs.length - sh.getMaxRows();
  if (lack > 0) sh.insertRowsAfter(sh.getMaxRows(), lack);
  sh.getRange(last + 1, 1, objs.length, COLS[name].length).setValues(objs.map(function (o) { return rowValues_(name, o); }));
  delete ledgerCache_.rows[name];
  delete ledgerCache_.rows['#keys:' + name];
}

/** 見出しの下を keep の行で書き直し、余った行を空にする（oldCount は書き直す前の行数） */
function rewriteRows_(name, keep, oldCount) {
  var n = COLS[name].length;
  var sh = sheet_(name);
  if (keep.length) sh.getRange(2, 1, keep.length, n).setValues(keep.map(function (o) { return rowValues_(name, o); }));
  if (oldCount > keep.length) sh.getRange(2 + keep.length, 1, oldCount - keep.length, n).clearContent();
  delete ledgerCache_.rows[name];
}

/** シートの全行を {列名: 値, _row: 行番号} の配列で返す（1実行の中では1回だけ読む） */
function readAll_(name) {
  if (ledgerCache_.rows[name]) return ledgerCache_.rows[name];
  var sh = sheet_(name);
  var cols = COLS[name];
  var last = sh.getLastRow();
  var out = [];
  var values = last < 2 ? [] : sh.getRange(2, 1, last - 1, cols.length).getValues();
  for (var i = 0; i < values.length; i++) {
    var o = { _row: i + 2 };
    for (var j = 0; j < cols.length; j++) o[cols[j]] = normCell_(values[i][j]);
    out.push(o);
  }
  ledgerCache_.rows[name] = out;
  return out;
}

/** 読んだ値を扱いやすい形にする（日付型が来た場合も文字列に戻す） */
function normCell_(v) {
  if (v instanceof Date) {
    var hms = Utilities.formatDate(v, TZ, 'HH:mm:ss');
    return hms === '00:00:00' ? Utilities.formatDate(v, TZ, 'yyyy-MM-dd') : Utilities.formatDate(v, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
  }
  return v;
}

/** 書き込む値を変換（文字列は自動変換されないようにする） */
function cellValue_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return "'" + iso_(v);
  var s = String(v);
  if (s === '') return '';
  return "'" + s;
}

/** 1行を末尾に足す。読んである行にも、読んだときと同じ形（空は ''）で足す */
function appendRow_(name, obj) {
  sheet_(name).appendRow(rowValues_(name, obj));
  var rows = ledgerCache_.rows[name], x = { _row: rows ? rows.length + 2 : 0 };
  COLS[name].forEach(function (c) { x[c] = obj[c] === undefined || obj[c] === null ? '' : obj[c]; });
  if (rows) rows.push(x);
}

/** readAll_ で読んだ行 row の何列かを changes に直す */
function updateRow_(name, row, changes) { updateRows_(name, [{ row: row, set: changes }]); }

/**
 * readAll_ で読んだ行の何列かを直す。items: [{ row, set: { 列名: 値 } }]
 * 直した行の上端〜下端・左端〜右端の四角を、1回で書く（列ごと・行ごとにシートを呼ばない）。
 * 四角の中の直さないセルには、同じロックの中で読んだ値をそのまま書く。
 */
function updateRows_(name, items) {
  if (!items.length) return;
  var cols = COLS[name];
  var r0 = Infinity, r1 = 0, c0 = Infinity, c1 = -1;
  items.forEach(function (it) {
    Object.keys(it.set).forEach(function (k) {
      var c = cols.indexOf(k);
      if (c < 0) throw new Error('列「' + k + '」がありません');
      it.row[k] = it.set[k] === undefined || it.set[k] === null ? '' : it.set[k];
      c0 = Math.min(c0, c); c1 = Math.max(c1, c);
    });
    r0 = Math.min(r0, it.row._row); r1 = Math.max(r1, it.row._row);
  });
  if (c1 < 0) return;
  // 間の行も、読んである行から埋める。読んである行が無い・合わないときは、1行ずつ書く
  var rows = ledgerCache_.rows[name];
  var span = [];
  for (var r = r0; r <= r1; r++) {
    var o = rows && rows[r - 2];
    if (!o || o._row !== r) { span = null; break; }
    span.push(o);
  }
  var sh = sheet_(name);
  var cut = function (o) { return rowValues_(name, o).slice(c0, c1 + 1); };
  if (span) sh.getRange(r0, c0 + 1, span.length, c1 - c0 + 1).setValues(span.map(cut));
  else items.forEach(function (it) { sh.getRange(it.row._row, c0 + 1, 1, c1 - c0 + 1).setValues([cut(it.row)]); });
}

/** 操作履歴（監査） */
function audit_(action, operator, reservationId, reason, detail) {
  appendRow_(SHEETS.LOG, { '日時': iso_(new Date()), '操作': action, '操作者': operator || '', '予約番号': reservationId || '', '理由': reason || '', '内容': detail || '' });
}

// ---------------------------------------------------------------- 日時
function iso_(d) { return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function ymd_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function todayYmd_() { return ymd_(new Date()); }
/** 'yyyy-MM-dd' を日本時間 0:00 の Date に */
function dateOf_(ymd) { return new Date(ymd + 'T00:00:00+09:00'); }
function addDaysYmd_(ymd, n) { return ymd_(new Date(dateOf_(ymd).getTime() + n * 86400000)); }
function isValidYmd_(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var d = dateOf_(s);
  return !isNaN(d.getTime()) && ymd_(d) === s;
}
function slotTimes_(ymd, slotId) {
  var s = SLOTS[slotId];
  var start = new Date(ymd + 'T' + s.start + ':00+09:00');
  var endYmd = addDaysYmd_(ymd, s.endDayOffset);
  var end = new Date(endYmd + 'T' + s.end + ':00+09:00');
  return { start: start, end: end };
}
/** 画面用の時間帯の表示（例: 17:00〜翌朝8:00） */
function slotText_(slotId) {
  var s = SLOTS[slotId];
  var hm = function (x) { return Number(x.slice(0, 2)) + ':' + x.slice(3); };
  return hm(s.start) + '〜' + (s.endDayOffset ? '翌朝' : '') + hm(s.end);
}
function daysBetween_(fromYmd, toYmd) { return Math.round((dateOf_(toYmd).getTime() - dateOf_(fromYmd).getTime()) / 86400000); }
