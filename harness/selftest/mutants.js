'use strict';
// 「わざと壊した実装」の一覧。受入試験がこれらを1つ残らず不合格にできることを確かめる（試験の試験）。
// 置換が当たらない（元の文字列が見つからない）場合は自己試験そのものを失敗にする。
module.exports = [
  {
    id: 'NO_LOCK', why: 'ロックを外すと、残り1台に複数が確定する',
    files: ['02_concurrency'],
    edits: [["if (!lock.tryLock(10000)) return { status: 'ERROR', reason: 'BUSY' };\n  try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }", 'return fn();']],
  },
  {
    id: 'NO_FLUSH_BEFORE_UNLOCK', why: 'flush せずにロックを解放すると、次の実行が書込み前の内容を読み、二重予約になる',
    files: ['02_concurrency'],
    edits: [['finally { SpreadsheetApp.flush(); lock.releaseLock(); }', 'finally { lock.releaseLock(); }']],
  },
  {
    id: 'NO_IDEMPOTENCY', why: '受付要求IDの重複確認をやめると、再送で二重登録される',
    files: ['03_idempotency'],
    edits: [["var existing = rows_('Reservations').filter(function (r) { return r.request_id === String(req.requestId); })[0];", 'var existing = null;']],
  },
  {
    id: 'PII_LEAK', why: '空き情報に氏名を混ぜると、個人情報の漏えいとして検出される',
    files: ['01_basic'],
    edits: [["return { status: 'OK', days: days };", "return { status: 'OK', days: days, recent: rows_('Reservations').map(function (r) { return r.name; }) };"]],
  },
  {
    id: 'NO_ADMIN_AUTH', why: '管理者確認をやめると、誰でも代行登録・一覧取得できる',
    files: ['06_security'],
    edits: [["if (!auth || !auth.email || !auth.secret) return null;", "return { label: 'anyone' };"]],
  },
  {
    id: 'MAIL_IN_BOOKING', why: '確定処理の中でメールを送ると、通知の分離違反として検出される',
    files: ['07_notifications'],
    edits: [["setCell_('Reservations', existing._row, 'state', 'CONFIRMED');", "setCell_('Reservations', existing._row, 'state', 'CONFIRMED');\n    if (req.email) MailApp.sendEmail(req.email, '確定', id);"]],
  },
  {
    id: 'PARTIAL_ALLOCATION', why: '空いている分だけ確保すると、複数台の一部確定として検出される',
    files: ['05_rules'],
    edits: [
      ['if (!reason && free.length < q) reason = \'FULL\';', "if (!reason && free.length < 1) reason = 'FULL';"],
      ['for (var i = 0; i < q; i++) append_', 'for (var i = 0; i < Math.min(q, free.length); i++) append_'],
    ],
  },
  {
    id: 'NO_CUTOFF', why: 'コマ開始後も受け付けると、期限の境界試験で検出される',
    files: ['05_rules'],
    edits: [["if (now.getTime() >= t.start.getTime()) reason = 'CUTOFF';\n    else if", 'if']],
  },
  {
    id: 'SHEET_AUTOCONVERT', why: '文字列をそのまま書くと、電話番号の先頭0がスプレッドシートの自動変換で消える',
    files: ['05_rules'],
    edits: [[`(typeof v === 'number' ? v : "'" + String(v))`, '(typeof v === \'number\' ? v : String(v))']],
  },
  {
    id: 'CONFIRM_BEFORE_ALLOCATE', why: '枠の確保前に確定と書くと、途中停止で「確定なのに枠なし」になり、再送でも直らない',
    files: ['04_faults'],
    edits: [["if (!existing) { base.state = 'PENDING';", "if (!existing) { base.state = 'CONFIRMED';"]],
  },
  {
    id: 'DATE_IN_RESPONSE', why: 'google.script.run の戻り値に Date を入れると、実GASでは null が届く',
    files: ['01_basic'],
    edits: [["return { slotId: id, start: iso_(t.start)", 'return { slotId: id, startDate: t.start, start: iso_(t.start)']],
  },
  {
    id: 'IGNORE_LOCK_FAILURE', why: 'ロックが取れなくても処理を続けると、障害試験で検出される',
    files: ['04_faults'],
    edits: [["if (!lock.tryLock(10000)) return { status: 'ERROR', reason: 'BUSY' };", 'lock.tryLock(10000);']],
  },
  {
    id: 'CANCEL_KEEPS_SLOT', why: '取消しで割当てを解放しないと、空きに戻らない',
    files: ['01_basic'],
    edits: [["rows_('Allocations').forEach(function (x) { if (x.reservation_id === r.reservation_id && x.state === 'ACTIVE') setCell_('Allocations', x._row, 'state', 'RELEASED'); });\n      setCell_('Reservations', r._row, 'state', 'CANCELLED');", "setCell_('Reservations', r._row, 'state', 'CANCELLED');"]],
  },
  {
    id: 'JOB_UNGUARDED', why: '通知ジョブが呼出し元を確認しないと、匿名利用者がメール送信を起こせる',
    files: ['06_security'],
    edits: [["var me = Session.getActiveUser().getEmail();\n  if (!me || me !== Session.getEffectiveUser().getEmail()) return { status: 'DENIED' };\n  return withLock_(function () {\n    var res", "return withLock_(function () {\n    var res"]],
  },
];
