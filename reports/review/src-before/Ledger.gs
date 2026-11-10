/**
 * 台帳（スプレッドシート）の読み書き。
 * ・文字列は先頭にアポストロフィを付けて書き、日付・数値への自動変換を防ぐ（電話番号の先頭0、日付文字列など）。
 * ・1実行の中ではスプレッドシートを1回だけ開く。
 */
var ledgerCache_ = { ss: null, sheets: {} };

function sheet_(name) {
  if (!ledgerCache_.ss) ledgerCache_.ss = spreadsheet_();
  if (!ledgerCache_.sheets[name]) {
    var sh = ledgerCache_.ss.getSheetByName(name);
    if (!sh) throw new Error('シート「' + name + '」がありません。初期設定を実行してください');
    ledgerCache_.sheets[name] = sh;
  }
  return ledgerCache_.sheets[name];
}

/** シートがあれば返す。無ければ null（保管のシートは、前の版の初期設定では作っていないため） */
function sheetOrNull_(name) {
  try { return sheet_(name); } catch (e) { return null; }
}

/** 何行かをまとめて末尾に書く（1回の書込み）。足りない行は先に足す */
function appendRows_(name, objs) {
  if (!objs.length) return;
  var cols = COLS[name];
  var sh = sheet_(name);
  var last = Math.max(sh.getLastRow(), 1);
  var lack = last + objs.length - sh.getMaxRows();
  if (lack > 0) sh.insertRowsAfter(sh.getMaxRows(), lack);
  sh.getRange(last + 1, 1, objs.length, cols.length).setValues(objs.map(function (o) { return cols.map(function (c) { return cellValue_(o[c]); }); }));
}

/** 見出しの下を keep の行で書き直し、余った行を空にする（oldCount は書き直す前の行数） */
function rewriteRows_(name, keep, oldCount) {
  var cols = COLS[name];
  var sh = sheet_(name);
  if (keep.length) sh.getRange(2, 1, keep.length, cols.length).setValues(keep.map(function (o) { return cols.map(function (c) { return cellValue_(o[c]); }); }));
  if (oldCount > keep.length) sh.getRange(2 + keep.length, 1, oldCount - keep.length, cols.length).clearContent();
}

/** シートの全行を {列名: 値, _row: 行番号} の配列で返す */
function readAll_(name) {
  var sh = sheet_(name);
  var cols = COLS[name];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, cols.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    var o = { _row: i + 2 };
    for (var j = 0; j < cols.length; j++) o[cols[j]] = normCell_(values[i][j]);
    out.push(o);
  }
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

function appendRow_(name, obj) {
  var cols = COLS[name];
  sheet_(name).appendRow(cols.map(function (c) { return cellValue_(obj[c]); }));
}

/** 既存の行の一部の列を更新する */
function updateRow_(name, row, obj) {
  var cols = COLS[name];
  var sh = sheet_(name);
  Object.keys(obj).forEach(function (k) {
    var c = cols.indexOf(k);
    if (c < 0) throw new Error('列「' + k + '」がありません');
    sh.getRange(row, c + 1).setValue(cellValue_(obj[k]));
  });
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
