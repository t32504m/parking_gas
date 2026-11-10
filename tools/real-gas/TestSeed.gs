/**
 * 本物の GAS での試験に使う道具（docs/REAL_TEST_無料アカウント.md）。
 * 試験用の GAS プロジェクトにだけ貼る。本番の GAS プロジェクトには貼らない（src/ にも入れない）。
 *
 * エディタの関数の選択で選んで「実行」する関数：
 *   testSeed_status       … 台帳の各シートの行数と、試験データの件数をログに出す
 *   testSeed_1year        … 試験データを消してから、過去の予約を1年分（365日×4コマ×2台＝2,920件）入れる
 *   testSeed_3years       … 試験データを消してから、過去の予約を3年分（1,095日×4コマ×2台＝8,760件）入れる
 *   testSeed_nightArchive … 試験データを消してから、70〜64日前の7日分（56件）を入れる。夜中の保管のトリガーが動いたかを見るため
 *   testSeed_measure      … 主な処理の時間を測ってログに出す（各5回の中央値）
 *   testSeed_clear        … 試験データを全て消す（保管のシートに移った分も消す）
 *
 * 安全のための決まり：
 *   ・持ち主（オーナー）がエディタから実行したときだけ動く（src/Notify.gs の isOwnerRun_）。
 *     ウェブアプリから google.script.run で呼ばれても、住民・管理者・未ログインの人では何もしない。
 *   ・さらに、台帳のスプレッドシートの名前に「試験」が入っているときだけ動く。
 *     本番の台帳（名前の例：駐車場予約 台帳（本番））では、持ち主が実行しても何もしない。
 *   ・消すのは、受付要求ID が「seed-」で始まる予約と、その割当て・通知・操作履歴だけ。住民や管理者が画面から入れた予約は消さない。
 *
 * 入れる行の形は tools/measure-growth.js の seed と同じ（毎日4コマ×2台が全て埋まった、電話受付・連絡済みの予約）。
 * 書き込みは setValues で、まとめて行う。
 * src/ の Config.gs・Ledger.gs・Booking.gs・Admin.gs・Archive.gs・Sheet.gs・Notify.gs の関数を使う。
 */

var TEST_SEED_PREFIX = 'seed-';
var TEST_SEED_MARK = '試験データ（TestSeed）';
var TEST_SEED_SHEET_WORD = '試験';
var TEST_SEED_CHUNK = 2000;

// ---------------------------------------------------------------- エディタから実行する関数

function testSeed_status() {
  var g = testSeedGuard_(); if (g) return g;
  var mail = null;
  try { mail = MailApp.getRemainingDailyQuota(); } catch (e) { mail = '取れない: ' + (e && e.message || e); }
  var out = { status: 'OK', today: todayYmd_(), timeZone: Session.getScriptTimeZone(), version: APP_VERSION, spreadsheet: spreadsheet_().getName(),
    rules: rules_(), mailRemainingToday: mail, rows: testSeedCounts_() };
  testSeedLog_(out);
  return out;
}

function testSeed_1year() { return testSeedFill_(365, 1); }
function testSeed_3years() { return testSeedFill_(1095, 1); }
function testSeed_nightArchive() { return testSeedFill_(7, 64); }

function testSeed_clear() {
  var g = testSeedGuard_(); if (g) return g;
  var t0 = Date.now();
  var r = withLock_(function () { return { status: 'OK', removed: testSeedClear_() }; });
  var out = { status: r.status, removed: r.removed, reason: r.reason, ms: Date.now() - t0, rows: testSeedCounts_() };
  testSeedLog_(out);
  return out;
}

/**
 * 主な処理の時間を測る（各5回の中央値。ミリ秒）。画面から呼んだときと同じく、毎回スプレッドシートを開き直す。
 * 電話の登録は、空いている未来のコマに試験の予約を入れて測り、すぐに取り消す（その予約も「seed-」で始まるので、testSeed_clear で消える）。
 */
function testSeed_measure() {
  var g = testSeedGuard_(); if (g) return g;
  var today = todayYmd_();
  var monthFrom = residentFrom_(today);
  var monthTo = addDaysYmd_(monthFrom, 29);
  var weekTo = addDaysYmd_(today, 6);
  var op = { email: 'test-seed', name: '試験 測定', label: TEST_SEED_MARK };
  var items = [];
  var timeIt = function (name, fn) {
    var ms = [], ok = true, note = '';
    for (var i = 0; i < 5; i++) {
      testSeedFresh_();
      var t0 = Date.now();
      var v = null;
      try { v = fn(i); } catch (e) { ok = false; note = String(e && e.message || e); }
      ms.push(v && typeof v._ms === 'number' ? v._ms : Date.now() - t0);
      if (v && v.status && ['OK', 'CONFIRMED', 'CANCELLED'].indexOf(v.status) < 0) { ok = false; note = v.status + (v.reason ? ' ' + v.reason : ''); }
    }
    ms.sort(function (a, b) { return a - b; });
    items.push({ name: name, medianMs: ms[2], allMs: ms, ok: ok, note: note });
  };

  timeIt('住民の空き状況（1か月）', function () { return availability_(monthFrom, monthTo, 'resident'); });
  timeIt('管理者の台帳（1週間）', function () { return availability_(today, weekTo, 'admin'); });
  timeIt('管理者の予約一覧（1週間）', function () { return adminList_({ from: today, to: weekTo }); });
  timeIt('電話連絡の一覧', function () { return adminCallList_(); });
  timeIt('名前で探す', function () { return adminList_({ text: '測定' }); });

  var target = testSeedFreeSlot_(today);
  var phoneReq = function (tag, i) {
    return { requestId: TEST_SEED_PREFIX + tag + '-' + Date.now() + '-' + i, date: target.date, slotId: target.slotId, quantity: 1,
      name: '試験 測定', building: 'A棟', room: '101', phone: '090-0000-0000' };
  };
  if (target) {
    // 登録の時間だけを測り、次の回のために、すぐに取り消す（取消しの時間は下で別に測る）
    timeIt('電話の登録（1件。予約表の作り直しを含む）', function (i) {
      var t0 = Date.now();
      var r = book_(phoneReq('measure', i), CHANNELS.PHONE, op.label);
      if (r.status === 'CONFIRMED') refreshMonthSheets_([target.date]);
      r._ms = Date.now() - t0;
      if (r.status === 'CONFIRMED') adminCancel_(op, { reservationId: r.reservationId, reason: TEST_SEED_MARK });
      return r;
    });
    // 取消しの時間だけを測る（先に1件を登録しておく）
    timeIt('取消し（1件。予約表の作り直しを含む）', function (i) {
      var r = book_(phoneReq('measure-c', i), CHANNELS.PHONE, op.label);
      if (r.status !== 'CONFIRMED') return r;
      testSeedFresh_();
      var t0 = Date.now();
      var c = adminCancel_(op, { reservationId: r.reservationId, reason: TEST_SEED_MARK });
      refreshMonthSheets_([target.date]);
      c._ms = Date.now() - t0;
      return c;
    });
  } else {
    items.push({ name: '電話の登録（1件）', medianMs: null, allMs: [], ok: false, note: '空いている未来のコマが見つからなかった' });
  }
  var out = { status: 'OK', today: today, rows: testSeedCounts_(), target: target, items: items };
  testSeedLog_(out);
  testSeedTable_(out);
  return out;
}

// ---------------------------------------------------------------- ここから下は内部の関数（名前が _ で終わるので、画面からは呼べない）

/** 動いてよいか。だめなら理由を返す（ログにも出す） */
function testSeedGuard_() {
  if (!isOwnerRun_()) return { status: 'DENIED', reason: '持ち主（オーナー）がエディタから実行したときだけ動きます' };
  var name = '';
  try { name = spreadsheet_().getName(); } catch (e) {
    var r0 = { status: 'DENIED', reason: '台帳のスプレッドシートを開けません: ' + (e && e.message || e) };
    console.log(JSON.stringify(r0));
    return r0;
  }
  if (name.indexOf(TEST_SEED_SHEET_WORD) < 0) {
    var r = { status: 'DENIED', reason: '台帳の名前に「' + TEST_SEED_SHEET_WORD + '」が入っていないので、本番の台帳とみなして何もしません: ' + name };
    console.log(JSON.stringify(r));
    return r;
  }
  return null;
}

function testSeedLog_(o) { console.log(JSON.stringify(o)); }

/**
 * 画面から呼ばれた1回の処理と同じ状態にする（1実行の中に置いてある、開いたスプレッドシート・読んだ行・設定を捨てる）。
 * src/ の作りが変わっても動くよう、あるものだけを空にする。
 */
function testSeedFresh_() {
  if (typeof ledgerCache_ === 'object' && ledgerCache_) {
    ledgerCache_.ss = null;
    ledgerCache_.sheets = {};
    if ('rows' in ledgerCache_) ledgerCache_.rows = {};
  }
  if (typeof rulesCache_ !== 'undefined') rulesCache_ = null;
}

/** 測った結果を、結果の表（手順書 5章）にそのまま貼れる形でもログに出す */
function testSeedTable_(out) {
  var lines = ['台帳の予約の行数：' + out.rows['予約'] + '（保管 ' + out.rows['予約（保管）'] + '）、試験データ ' + out.rows.seed + '件'];
  out.items.forEach(function (x) { lines.push('| ' + x.name + ' | ' + (x.medianMs === null ? '-' : x.medianMs + 'ms') + ' | ' + (x.ok ? '' : '失敗：' + x.note) + ' |'); });
  console.log(lines.join('\n'));
}

/** 各シートの行数（見出しを除く）と、試験データの予約の件数 */
function testSeedCounts_() {
  var out = {};
  [SHEETS.RES, SHEETS.ALC, SHEETS.NTF, SHEETS.LOG, SHEETS.RES_ARC, SHEETS.ALC_ARC, SHEETS.NTF_ARC].forEach(function (name) {
    var sh = sheetOrNull_(name);
    out[name] = sh ? Math.max(sh.getLastRow() - 1, 0) : 0;
  });
  var seed = 0;
  [SHEETS.RES, SHEETS.RES_ARC].forEach(function (name) {
    if (!sheetOrNull_(name)) return;
    readAll_(name).forEach(function (r) { if (String(r['受付要求ID']).indexOf(TEST_SEED_PREFIX) === 0) seed++; });
  });
  out.seed = seed;
  return out;
}

/** 試験データを消してから、今日の startBack 日前から days 日分（さかのぼる）の過去の予約を入れる */
function testSeedFill_(days, startBack) {
  var g = testSeedGuard_(); if (g) return g;
  var t0 = Date.now();
  var r = withLock_(function () {
    var removed = testSeedClear_();
    var n = testSeedWrite_(days, startBack);
    return { status: 'OK', removed: removed, added: n };
  });
  var out = { status: r.status, removed: r.removed, added: r.added, reason: r.reason, ms: Date.now() - t0, rows: testSeedCounts_() };
  testSeedLog_(out);
  return out;
}

/** 過去の予約の行を作って、まとめて書く。書いた予約の件数を返す */
function testSeedWrite_(days, startBack) {
  var today = todayYmd_();
  var used = archivedIds_();
  readAll_(SHEETS.RES).forEach(function (x) { used[String(x['予約番号'])] = true; });
  var next = 100000 + Math.floor(Math.random() * 800000);
  var newId = function () {
    for (var k = 0; k < 900000; k++) {
      var id = String(next);
      next = next >= 999999 ? 100000 : next + 1;
      if (!used[id]) { used[id] = true; return id; }
    }
    throw new Error('予約番号を作れませんでした');
  };
  var res = [], alc = [], ntf = [], log = [];
  var n = 0;
  for (var i = startBack + days - 1; i >= startBack; i--) {
    var date = addDaysYmd_(today, -i);
    SLOT_IDS.forEach(function (slotId) {
      var s = SLOTS[slotId];
      var label = s.mark + ' ' + s.label + ' ' + slotText_(slotId);
      var endDate = addDaysYmd_(date, s.endDayOffset);
      ['91', '92'].forEach(function (space) {
        n++;
        var id = newId();
        var at = date + 'T07:00:00+09:00';
        res.push({ '予約番号': id, '受付要求ID': TEST_SEED_PREFIX + n + '-' + id, '状態': ST.CONFIRMED, '受付経路': CHANNELS.PHONE, '利用日': date, 'コマID': slotId,
          '時間帯': label, '台数': 1, '料金合計': s.price, '開始日時': date + 'T' + s.start + ':00+09:00', '終了日時': endDate + 'T' + s.end + ':00+09:00',
          '氏名': '過去 太郎', '棟': 'A棟', '部屋番号': String(100 + (n % 300)), '電話番号': '090-0000-0000', 'メール': '', '連絡方法': '電話',
          '受付日時': at, '確定日時': at, '更新日時': at, '登録者': TEST_SEED_MARK, '不成立理由': '', '電話等の受付日時': '', '備考': '' });
        alc.push({ '予約番号': id, '利用日': date, 'コマID': slotId, '駐車場': space, '状態': ALC_ST.ACTIVE, '確保日時': at });
        ntf.push({ '予約番号': id, '状態': NTF_ST.PHONE_DONE, '送信先': '', '試行回数': 0, '最終結果': '', '更新日時': at, '電話対応者': TEST_SEED_MARK, '電話対応日時': at });
        log.push({ '日時': at, '操作': '代行登録', '操作者': TEST_SEED_MARK, '予約番号': id, '理由': TEST_SEED_MARK, '内容': label });
      });
    });
  }
  testSeedAppend_(SHEETS.RES, res);
  testSeedAppend_(SHEETS.ALC, alc);
  testSeedAppend_(SHEETS.NTF, ntf);
  testSeedAppend_(SHEETS.LOG, log);
  SpreadsheetApp.flush();
  return n;
}

/** 行をまとめて末尾に書く（src/Ledger.gs の appendRows_ ＝ setValues を、TEST_SEED_CHUNK 行ずつ呼ぶ） */
function testSeedAppend_(name, objs) {
  for (var i = 0; i < objs.length; i += TEST_SEED_CHUNK) appendRows_(name, objs.slice(i, i + TEST_SEED_CHUNK));
}

/**
 * 試験データを消す（ロックの中で呼ぶ）。シートごとに、残す行だけで書き直す。消した行数を返す。
 * 試験データ：受付要求ID が seed- で始まる予約。その予約番号の割当て・通知・操作履歴。操作履歴で理由が TEST_SEED_MARK のもの。
 */
function testSeedClear_() {
  var ids = {};
  [SHEETS.RES, SHEETS.RES_ARC].forEach(function (name) {
    if (!sheetOrNull_(name)) return;
    readAll_(name).forEach(function (r) { if (String(r['受付要求ID']).indexOf(TEST_SEED_PREFIX) === 0) ids[String(r['予約番号'])] = true; });
  });
  var removed = {};
  [SHEETS.RES, SHEETS.ALC, SHEETS.NTF, SHEETS.LOG, SHEETS.RES_ARC, SHEETS.ALC_ARC, SHEETS.NTF_ARC].forEach(function (name) {
    if (!sheetOrNull_(name)) { removed[name] = 0; return; }
    var rows = readAll_(name);
    var keep = rows.filter(function (r) {
      if (name === SHEETS.LOG) return !(ids[String(r['予約番号'])] || r['理由'] === TEST_SEED_MARK);
      return !ids[String(r['予約番号'])];
    });
    removed[name] = rows.length - keep.length;
    if (removed[name] > 0) rewriteRows_(name, keep, rows.length);
  });
  SpreadsheetApp.flush();
  return removed;
}

/** 測定の登録に使う、空いている未来のコマ（7日後から探す） */
function testSeedFreeSlot_(today) {
  var from = addDaysYmd_(today, 7);
  var a = availability_(from, addDaysYmd_(from, 30), 'admin');
  if (!a || a.status !== 'OK') return null;
  for (var i = 0; i < a.days.length; i++) {
    for (var j = 0; j < a.days[i].slots.length; j++) {
      var s = a.days[i].slots[j];
      if (s.bookable && s.remaining >= 1) return { date: a.days[i].date, slotId: s.slotId };
    }
  }
  return null;
}
