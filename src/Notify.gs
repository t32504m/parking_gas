/**
 * 通知（要件6.6）。予約の確定処理とは分けて、時間主導トリガーで送る。
 * ・受付のときにはメールを送らない。利用日の前日に、1日1回のトリガー（RULES.remindHour の時）で
 *   「明日のご予約」の案内を送る（D-030）。送る時点の台帳を見る（変更した予約は、変更後の利用日で送る）。
 * ・メールの失敗で予約を変えない。失敗・上限超過は「再送待ち」として残し、次回に再送する（利用日までに限る）。
 * ・送信中に止まった分は、10分後に再送待ちへ戻す（同じメールが2通届く可能性はあるが、届かないよりよい）。
 */
var NOTIFY_MAX_ATTEMPTS = 10;
var NOTIFY_STUCK_MS = 10 * 60 * 1000;
var REMIND_LATE = '前日の案内の時刻を過ぎて受け付けたため送らない';

function isOwnerRun_() {
  var me = Session.getActiveUser().getEmail();
  return !!me && me === Session.getEffectiveUser().getEmail();
}

function job_processNotifications() {
  if (!isOwnerRun_()) return { status: 'DENIED' };
  var t0 = Date.now();
  // 1) 送る対象を「送信中」にする（ロックの中で）
  var picked = withLock_(function () {
    var now = Date.now(), stamp = iso_(new Date()), today = todayYmd_(), tomorrow = addDaysYmd_(today, 1);
    // 予約番号の索引を先に1回だけ作る（通知ごとに予約の全行を探すと、行数×行数になる）
    var byId = {}, spaces = {};
    readAll_(SHEETS.RES).forEach(function (x) { var id = String(x['予約番号']); if (!byId[id]) byId[id] = x; });
    var list = [], updates = [], alcRead = false;
    readAll_(SHEETS.NTF).forEach(function (n) {
      var st = String(n['状態']);
      if (st === NTF_ST.SENDING && now - Date.parse(String(n['更新日時'])) > NOTIFY_STUCK_MS) st = NTF_ST.RETRY;
      if (st !== NTF_ST.PENDING && st !== NTF_ST.RETRY) return;
      if (Number(n['試行回数'] || 0) >= NOTIFY_MAX_ATTEMPTS) return;
      var r = byId[String(n['予約番号'])];
      if (!r || r['状態'] !== ST.CONFIRMED) { updates.push({ row: n, set: { '状態': NTF_ST.NONE, '最終結果': '予約が確定状態でないため送らない', '更新日時': stamp } }); return; }
      var date = String(r['利用日']);
      // 利用日を過ぎた分は、もう送らない（再送待ちは、利用日の当日までは管理者の電話連絡の一覧に残す）
      if (date < today || (date === today && st === NTF_ST.PENDING)) {
        updates.push({ row: n, set: { '状態': NTF_ST.NONE, '最終結果': date < today ? '利用日を過ぎたため送らない' : REMIND_LATE, '更新日時': stamp } });
        return;
      }
      if (date !== tomorrow || now < remindAt_(date).getTime()) return; // 前日の送る時刻になるまで待つ
      if (!alcRead) {
        alcRead = true;
        readAll_(SHEETS.ALC).forEach(function (a) {
          if (a['状態'] !== ALC_ST.ACTIVE) return;
          var id = String(a['予約番号']);
          (spaces[id] = spaces[id] || []).push(String(a['駐車場']));
        });
      }
      updates.push({ row: n, set: { '状態': NTF_ST.SENDING, '試行回数': Number(n['試行回数'] || 0) + 1, '更新日時': stamp } });
      list.push({ id: String(n['予約番号']), to: String(n['送信先']), r: summaryOf_(r), name: String(r['氏名']), spaces: (spaces[String(n['予約番号'])] || []).sort() });
    });
    updateRows_(SHEETS.NTF, updates); // 1回で書く
    return { status: 'OK', list: list };
  });
  if (picked.status !== 'OK') return picked;
  // 2) 送る直前に、予約がまだ確定かを読み直して送る（送っている間に取り消した予約へ「確定しました」を送らない。D-028）。
  //    送っている間はロックを持たない（登録・取消しを待たせない。D-029）。10件ごとに読み直す。
  //    読み直してから送るまでの間に取り消されると、確定のメールが届くことがある（残る隙間。D-029）
  var results = [];
  var stop = null;
  var send = function (p, now) {
    if (!now || now['状態'] !== ST.CONFIRMED) return { id: p.id, skip: true };
    if (String(now['利用日']) !== p.r.date) return { id: p.id, later: true }; // 送る前に利用日が変わった：変わった日の前日に送る
    if (stop) return { id: p.id, ok: false, error: stop };
    try {
      if (MailApp.getRemainingDailyQuota() < 1) throw new Error('本日のメール送信上限に達しました');
      MailApp.sendEmail(p.to, '【駐車場予約】明日のご予約のご案内（予約番号 ' + p.r.reservationId + '）', mailBody_(p));
      return { id: p.id, ok: true };
    } catch (e) {
      var msg = String(e && e.message);
      if (/too many times|上限/.test(msg)) stop = '本日のメール送信上限に達しました';
      return { id: p.id, ok: false, error: stop || msg };
    }
  };
  for (var i = 0; i < picked.list.length; i += 10) {
    var chunk = picked.list.slice(i, i + 10);
    var st = {};
    forgetRows_();
    readAll_(SHEETS.RES).forEach(function (x) { var id = String(x['予約番号']); if (!(id in st)) st[id] = x; });
    results = results.concat(chunk.map(function (p) { return send(p, st[p.id]); }));
  }
  // 3) 結果を記録する。1) の行番号は使わない（送っている間に保管が動くと、行が詰まって別の予約の行になるため）。
  //    通知のシートを読み直し、予約番号と「送信中」で行を探す
  withLock_(function () {
    var byId = {}, stamp = iso_(new Date()), updates = [];
    results.forEach(function (x) { byId[x.id] = x; });
    readAll_(SHEETS.NTF).forEach(function (n) {
      var x = byId[String(n['予約番号'])];
      if (!x || String(n['状態']) !== NTF_ST.SENDING) return;
      updates.push({ row: n, set: x.skip ? { '状態': NTF_ST.NONE, '最終結果': '予約が確定状態でないため送らない', '更新日時': stamp }
        : x.later ? { '状態': NTF_ST.PENDING, '最終結果': '利用日が変わったため、変わった日の前日に送る', '更新日時': stamp }
        : x.ok ? { '状態': NTF_ST.SENT, '最終結果': '送信済み', '更新日時': stamp } : { '状態': NTF_ST.RETRY, '最終結果': x.error, '更新日時': stamp } });
    });
    updateRows_(SHEETS.NTF, updates);
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
    '明日は、駐車場のご予約の日です。',
    '',
    '利用日：' + Utilities.formatDate(d, TZ, 'yyyy年M月d日') + '（' + wd + '）',
    '時間帯：' + s.slotMark + ' ' + s.slotLabel + ' ' + s.timeText,
    '区画：' + (p.spaces && p.spaces.length ? p.spaces.join('・') : '当日、駐車場係にお尋ねください'),
    '予約番号：' + s.reservationId,
    '',
    '予約番号は、取消しや問合せのときに必要です。',
    'このメールに心当たりがない場合は、理事会事務局までご連絡ください。',
  ].join('\n');
}
