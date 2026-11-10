/**
 * 通知（要件6.6）。予約の確定処理とは分けて、時間主導トリガーで送る。
 * ・メールの失敗で予約を変えない。失敗・上限超過は「再送待ち」として残し、次回に再送する。
 * ・送信中に止まった分は、10分後に再送待ちへ戻す（同じメールが2通届く可能性はあるが、届かないよりよい）。
 */
var NOTIFY_MAX_ATTEMPTS = 10;
var NOTIFY_STUCK_MS = 10 * 60 * 1000;

function isOwnerRun_() {
  var me = Session.getActiveUser().getEmail();
  return !!me && me === Session.getEffectiveUser().getEmail();
}

function job_processNotifications() {
  if (!isOwnerRun_()) return { status: 'DENIED' };
  var t0 = Date.now();
  // 1) 送る対象を「送信中」にする（ロックの中で）
  var picked = withLock_(function () {
    var now = Date.now();
    var res = readAll_(SHEETS.RES);
    var list = [];
    readAll_(SHEETS.NTF).forEach(function (n) {
      var st = String(n['状態']);
      if (st === NTF_ST.SENDING && now - Date.parse(String(n['更新日時'])) > NOTIFY_STUCK_MS) st = NTF_ST.RETRY;
      if (st !== NTF_ST.PENDING && st !== NTF_ST.RETRY) return;
      if (Number(n['試行回数'] || 0) >= NOTIFY_MAX_ATTEMPTS) return;
      var r = res.filter(function (x) { return String(x['予約番号']) === String(n['予約番号']); })[0];
      if (!r || r['状態'] !== ST.CONFIRMED) { updateRow_(SHEETS.NTF, n._row, { '状態': NTF_ST.NONE, '最終結果': '予約が確定状態でないため送らない', '更新日時': iso_(new Date()) }); return; }
      updateRow_(SHEETS.NTF, n._row, { '状態': NTF_ST.SENDING, '試行回数': Number(n['試行回数'] || 0) + 1, '更新日時': iso_(new Date()) });
      list.push({ row: n._row, to: String(n['送信先']), r: summaryOf_(r), name: String(r['氏名']) });
    });
    return { status: 'OK', list: list };
  });
  if (picked.status !== 'OK') return picked;
  // 2) ロックの外で送る
  var results = [];
  var stop = null;
  picked.list.forEach(function (p) {
    if (stop) { results.push({ row: p.row, ok: false, error: stop }); return; }
    try {
      if (MailApp.getRemainingDailyQuota() < 1) throw new Error('本日のメール送信上限に達しました');
      MailApp.sendEmail(p.to, '【駐車場予約】予約が確定しました（予約番号 ' + p.r.reservationId + '）', mailBody_(p));
      results.push({ row: p.row, ok: true });
    } catch (e) {
      var msg = String(e && e.message);
      if (/too many times|上限/.test(msg)) stop = '本日のメール送信上限に達しました';
      results.push({ row: p.row, ok: false, error: stop || msg });
    }
  });
  // 3) 結果を記録する
  withLock_(function () {
    results.forEach(function (x) {
      updateRow_(SHEETS.NTF, x.row, x.ok
        ? { '状態': NTF_ST.SENT, '最終結果': '送信済み', '更新日時': iso_(new Date()) }
        : { '状態': NTF_ST.RETRY, '最終結果': x.error, '更新日時': iso_(new Date()) });
    });
    return { status: 'OK' };
  });
  console.log('通知処理: ' + results.length + '件（成功 ' + results.filter(function (x) { return x.ok; }).length + '）' + (Date.now() - t0) + 'ms');
  return { status: 'OK', processed: results.length, sent: results.filter(function (x) { return x.ok; }).length };
}

function mailBody_(p) {
  var s = p.r;
  var d = dateOf_(s.date);
  var wd = '日月火水木金土'.charAt(Number(Utilities.formatDate(d, TZ, 'u')) % 7);
  return [
    p.name + ' 様',
    '',
    '駐車場の予約が確定しました。',
    '',
    '予約番号：' + s.reservationId,
    '利用日：' + Utilities.formatDate(d, TZ, 'yyyy年M月d日') + '（' + wd + '）',
    '時間帯：' + s.slotMark + ' ' + s.slotLabel + ' ' + s.timeText,
    '台数：' + s.quantity + '台',
    '料金：' + s.priceTotal + '円',
    '',
    '予約番号は、取消しや問合せのときに必要です。',
    'このメールに心当たりがない場合は、自治会の駐車場係までご連絡ください。',
  ].join('\n');
}
