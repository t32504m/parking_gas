/**
 * 予約表（D-017）。管理者がこれまで使ってきた Excel の「駐車場予約表」と同じ形で、月ごとの表を作る。
 *
 *   日付 | 時間帯            | 駐車場枠91（申込者・適用） | 駐車場枠92（申込者・適用） | 駐車場枠93（申込者・適用）
 *   11月1日 | A 8:00〜11:00 | …
 *
 * ・元の記録は、これまでどおり台帳のシート（予約・割当て・使用禁止など）。予約表はそこから作る「見せるための表」で、
 *   手で書き換えても台帳には戻らない（次に作り直したときに上書きされる）。
 * ・スプレッドシートには「予約表 2026年11月」のように月ごとのシートで書く。管理者の登録・取消し・使用禁止のたびに、
 *   その月のシートを作り直す。Excel が要るときは、スプレッドシートの「ファイル → ダウンロード → Microsoft Excel」。
 * ・管理者の画面の「予約表」も、同じ表（monthTable_）を出して印刷する。
 */
var CHANNEL_TEXT = { ONLINE: 'ネット', PHONE: '電話', COUNTER: '窓口' };

function sheetNameOf_(ym) { return '予約表 ' + Number(ym.slice(0, 4)) + '年' + Number(ym.slice(5, 7)) + '月'; }
function isValidYm_(ym) { return typeof ym === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(ym); }

/** 月の表。rows は1コマ1行。cells は区画ごとの { name, note, kind: 'resv'|'block'|'' } */
function monthTable_(ym) {
  var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7));
  var first = ym + '-01';
  var last = ym + '-' + ('0' + new Date(Date.UTC(y, m, 0)).getUTCDate()).slice(-2);
  var resv = {};
  // 保管した日付を含む月は、保管のシートも読む（D-023）
  var read = first < archiveBoundary_(todayYmd_()) ? readWithArchive_ : readAll_;
  read(SHEETS.RES).forEach(function (r) {
    if (r['状態'] === ST.CONFIRMED && String(r['利用日']) >= first && String(r['利用日']) <= last) resv[String(r['予約番号'])] = r;
  });
  var at = {};
  read(SHEETS.ALC).forEach(function (a) {
    var r = resv[String(a['予約番号'])];
    if (a['状態'] !== ALC_ST.ACTIVE || !r) return;
    at[String(a['利用日']) + '|' + String(a['コマID']) + '|' + String(a['駐車場'])] = r;
  });
  var blocks = blocksAll_().filter(function (b) { return b['状態'] === BLK_ST.ACTIVE && String(b['終了日']) >= first && String(b['開始日']) <= last; });
  var blockById = {};
  blocks.forEach(function (b) { blockById[String(b['番号'])] = b; });
  var rows = [];
  for (var d = first; d <= last; d = addDaysYmd_(d, 1)) {
    SLOT_IDS.forEach(function (id, i) {
      var bl = blockedSpaces_(blocks, d, id);
      rows.push({
        date: d, dateText: i === 0 ? Number(d.slice(5, 7)) + '月' + Number(d.slice(8)) + '日' : '',
        slotId: id, slotText: SLOTS[id].mark + '　' + slotText_(id),
        cells: SPACES.map(function (sp) {
          var r = at[d + '|' + id + '|' + sp];
          if (r) {
            var where = (String(r['棟'] || '') + String(r['部屋番号'] || '')).trim();
            return { kind: 'resv', reservationId: String(r['予約番号']), name: String(r['氏名']), note: [where, CHANNEL_TEXT[String(r['受付経路'])] || ''].filter(String).join(' ') };
          }
          if (bl[sp]) {
            var b = blockById[bl[sp]];
            return { kind: 'block', blockId: bl[sp], name: b['理由'] === '管理者が使う' ? '管理者' : '使用禁止', note: [String(b['理由']), String(b['メモ'] || '')].filter(String).join(' ') };
          }
          return { kind: '', name: '', note: '' };
        }),
      });
    });
  }
  return { status: 'OK', month: ym, title: sheetNameOf_(ym), spaces: SPACES.slice(), rows: rows };
}

/** 予約表を、スプレッドシートの月のシートに書く（あれば作り直す） */
function writeMonthSheet_(ym) {
  var t = monthTable_(ym);
  if (!ledgerCache_.ss) ledgerCache_.ss = spreadsheet_();
  var ss = ledgerCache_.ss;
  var sh = ss.getSheetByName(t.title) || ss.insertSheet(t.title);
  sh.clear();
  var nc = 2 + SPACES.length * 2;
  var head1 = ['', ''], head2 = ['日付', '時間帯'];
  SPACES.forEach(function (sp) { head1.push('駐車場枠' + sp, ''); head2.push('申込者', '適用'); });
  var body = t.rows.map(function (r) {
    var v = [r.dateText, r.slotText];
    r.cells.forEach(function (c) { v.push(c.name, c.note); });
    return v;
  });
  var all = [head1, head2].concat(body).map(function (row) { return row.map(cellValue_); });
  sh.getRange(1, 1, all.length, nc).setValues(all);
  SPACES.forEach(function (sp, i) { sh.getRange(1, 3 + i * 2, 1, 2).merge().setHorizontalAlignment('center'); });
  for (var i = 0; i < body.length; i += SLOT_IDS.length) sh.getRange(3 + i, 1, SLOT_IDS.length, 1).merge().setVerticalAlignment('top');
  sh.getRange(1, 1, 2, nc).setFontWeight('bold');
  sh.getRange(1, 1, all.length, nc).setBorder(true, true, true, true, true, true);
  sh.setFrozenRows(2);
  sh.setColumnWidth(1, 80); sh.setColumnWidth(2, 150);
  SPACES.forEach(function (sp, i) { sh.setColumnWidth(3 + i * 2, 120); sh.setColumnWidth(4 + i * 2, 80); });
  return { status: 'OK', month: ym, sheetName: t.title, rows: body.length, url: ss.getUrl() };
}

/**
 * 登録・取消し・使用禁止のあとに、その日を含む月の予約表を作り直す。
 * 予約の確定とは別の処理なので、失敗しても予約の結果は変えない（あとで「スプレッドシートに書き出す」で直せる）。
 */
function refreshMonthSheets_(dates) {
  var months = {};
  (dates || []).forEach(function (d) { if (isValidYmd_(d)) months[d.slice(0, 7)] = true; });
  Object.keys(months).sort().slice(0, 13).forEach(function (ym) {
    try {
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(10000)) return;
      try { writeMonthSheet_(ym); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
    } catch (e) { console.error('予約表の作り直しに失敗: ' + ym + ' ' + (e && e.stack ? e.stack : e)); }
  });
}

/** 期間に含まれる日（月ごとに1日ずつでよい） */
function monthsBetween_(from, to) {
  var out = [];
  var d = from;
  while (d <= to && out.length < 13) { out.push(d); d = addDaysYmd_(d.slice(0, 8) + '01', 32).slice(0, 8) + '01'; }
  return out;
}

function adminMonthTable_(q) {
  var ym = q && q.month;
  if (!isValidYm_(ym)) return { status: 'REJECTED', reason: 'INVALID' };
  var t = monthTable_(ym);
  if (!ledgerCache_.ss) ledgerCache_.ss = spreadsheet_();
  t.url = ledgerCache_.ss.getUrl();
  return t;
}

function adminExportMonth_(admin, q) {
  var ym = q && q.month;
  if (!isValidYm_(ym)) return { status: 'REJECTED', reason: 'INVALID' };
  return withLock_(function () {
    var r = writeMonthSheet_(ym);
    audit_('予約表の書き出し', admin.label, '', '', r.sheetName);
    return r;
  });
}
