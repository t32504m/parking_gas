/**
 * 管理者の確認（仮の方式：管理者メールアドレス＋管理者パスコード。docs/DECISIONS.md D-001）
 * ・パスコードはスクリプトプロパティ ADMINS に、塩付きハッシュでだけ保存する。
 * ・確認に成功すると、6時間有効な確認済みの印（トークン）を返す。画面は以後これを付けて呼ぶ。
 * ・管理者用の関数は、必ずサーバー側でこの確認を通す（画面の切替だけを認証にしない：要件9）。
 */
var ADMIN_TOKEN_TTL_SEC = 6 * 3600;
var ADMIN_MAX_FAILS = 5;

function admins_() {
  try { return JSON.parse(props_().getProperty('ADMINS') || '{}'); } catch (e) { return {}; }
}

function hashSecret_(salt, secret) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + String(secret)));
}

function normEmail_(e) { return String(e || '').trim().toLowerCase(); }

/** 失敗回数が多いアカウントは一時的に止める（総当たり対策） */
function tooManyFails_(email) {
  var n = Number(CacheService.getScriptCache().get('fail:' + email) || 0);
  return n >= ADMIN_MAX_FAILS;
}
function countFail_(email) {
  var c = CacheService.getScriptCache();
  var n = Number(c.get('fail:' + email) || 0) + 1;
  c.put('fail:' + email, String(n), 15 * 60);
}

/** パスコードの前後の空白・改行は無視する（コピー＆貼り付けで混ざりやすいため） */
function normSecret_(s) { return typeof s === 'string' ? s.trim() : ''; }

function verifyAdmin_(email, secret) {
  email = normEmail_(email);
  secret = normSecret_(secret);
  if (!email || !secret) return null;
  if (tooManyFails_(email)) return null;
  var a = admins_()[email];
  if (!a || hashSecret_(a.salt, secret) !== a.hash) { countFail_(email); return null; }
  return { email: email, name: a.name, label: a.name + ' <' + email + '>' };
}

/** auth: { token } または { email, secret } */
function adminOf_(auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (typeof auth.token === 'string' && auth.token) {
    var email = CacheService.getScriptCache().get('adm:' + auth.token);
    if (!email) return null;
    var a = admins_()[email];
    return a ? { email: email, name: a.name, label: a.name + ' <' + email + '>' } : null;
  }
  return verifyAdmin_(auth.email, auth.secret);
}

function isLocked_(email) { return tooManyFails_(normEmail_(email)); }

function denied_() { return { status: 'DENIED', reasonText: '管理者の確認ができませんでした。もう一度、管理者の確認をしてください' }; }

// ---------------------------------------------------------------- 管理者の予約一覧（個人情報を含む。管理者だけ）
/**
 * 予約番号ごとの区画と通知を、先に1回だけまとめる。
 * 行ごとに割当て・通知の全行を探すと、台帳の行が増えたときに「行数×行数」で遅くなるため（検討 3章の計測）
 */
function rowIndex_(allocs, ntfs) {
  var spaces = {}, ntf = {};
  allocs.forEach(function (a) {
    if (a['状態'] !== ALC_ST.ACTIVE) return;
    var id = String(a['予約番号']);
    (spaces[id] = spaces[id] || []).push(String(a['駐車場']));
  });
  ntfs.forEach(function (x) { var id = String(x['予約番号']); if (!ntf[id]) ntf[id] = x; });
  return { spaces: spaces, ntf: ntf };
}

function adminRowOf_(r, idx) {
  var s = summaryOf_(r);
  s.state = String(r['状態']);
  s.stateText = String(r['状態']);
  s.channel = String(r['受付経路']);
  s.channelText = { ONLINE: 'オンライン', PHONE: '電話', COUNTER: '窓口' }[s.channel] || s.channel;
  s.name = String(r['氏名']);
  s.building = String(r['棟']);
  s.room = String(r['部屋番号']);
  s.phone = String(r['電話番号']);
  s.email = String(r['メール']);
  s.operator = String(r['登録者']);
  s.createdAt = String(r['受付日時']);
  s.reasonText = r['不成立理由'] ? REASON_TEXT[String(r['不成立理由'])] || String(r['不成立理由']) : '';
  s.spaces = (idx.spaces[s.reservationId] || []).slice().sort();
  var n = idx.ntf[s.reservationId];
  s.contactState = n ? String(n['状態']) : '';
  s.archived = !!r._arc;
  return s;
}

function adminList_(q) {
  q = q || {};
  var date = isValidYmd_(q.date) ? q.date : null;
  var from = isValidYmd_(q.from) ? q.from : null;
  var to = isValidYmd_(q.to) ? q.to : null;
  var text = cleanText_(q.text, 50);
  if (text) text = text.replace(/\s+/g, '');
  var rid = cleanText_(q.reservationId, 20);
  var room = cleanText_(q.room, 20);
  var building = cleanText_(q.building, 20);
  var includeRejected = !!q.includeRejected;
  // 名前などで探すとき・保管した日付を見るときは、保管のシートも読む（D-023）
  var boundary = archiveBoundary_(todayYmd_());
  var wide = !!(text || rid || room || building) || (date && date < boundary) || (from && from < boundary) || (!date && !from);
  var read = wide ? readWithArchive_ : readAll_;
  var rows = read(SHEETS.RES);
  var allocs = read(SHEETS.ALC);
  var ntfs = read(SHEETS.NTF);
  var idx = rowIndex_(allocs, ntfs);
  var list = rows.filter(function (r) {
    if (!includeRejected && (r['状態'] === ST.REJECTED || r['状態'] === ST.PENDING)) return false;
    if (date && String(r['利用日']) !== date) return false;
    if (from && String(r['利用日']) < from) return false;
    if (to && String(r['利用日']) > to) return false;
    if (text) {
      var hay = [r['氏名'], r['棟'], r['部屋番号'], r['予約番号'], r['電話番号']].map(function (x) { return String(x).replace(/\s+/g, ''); }).join('|');
      if (hay.indexOf(text) < 0) return false;
    }
    if (rid && String(r['予約番号']) !== rid) return false;
    if (room && String(r['部屋番号']).indexOf(room) < 0) return false;
    if (building && String(r['棟']).indexOf(building) < 0) return false;
    if (q.space && (idx.spaces[String(r['予約番号'])] || []).indexOf(String(q.space)) < 0) return false;
    return true;
  }).map(function (r) { return adminRowOf_(r, idx); });
  list.sort(function (a, b) { return (a.date + a.slotId).localeCompare(b.date + b.slotId) || a.reservationId.localeCompare(b.reservationId); });
  return { status: 'OK', reservations: list };
}

function adminCancel_(admin, q) {
  if (!q || typeof q !== 'object') return { status: 'REJECTED', reason: 'INVALID' };
  var rid = cleanText_(q.reservationId, 20);
  var reason = cleanText_(q.reason, 200);
  if (!rid) return { status: 'REJECTED', reason: 'INVALID', reasonText: '予約番号を確認してください' };
  if (!reason) return { status: 'REJECTED', reason: 'INVALID', reasonText: '取消しの理由を入れてください' };
  return withLock_(function () {
    var rows = readAll_(SHEETS.RES);
    var r = rows.filter(function (x) { return String(x['予約番号']) === rid; })[0];
    if (!r && archivedIds_()[rid]) return { status: 'REJECTED', reason: 'ARCHIVED', reasonText: REASON_TEXT.ARCHIVED };
    if (!r) return { status: 'REJECTED', reason: 'NOT_FOUND', reasonText: 'その予約番号は見つかりません' };
    if (String(r['利用日']) < archiveBoundary_(todayYmd_())) return { status: 'REJECTED', reason: 'ARCHIVED', reasonText: REASON_TEXT.ARCHIVED };
    if (r['状態'] === ST.CANCELLED) return { status: 'CANCELLED', reservationId: rid, already: true };
    if (r['状態'] !== ST.CONFIRMED) return { status: 'REJECTED', reason: 'NOT_CONFIRMED', reasonText: '確定していない予約は取り消せません' };
    var now = iso_(new Date());
    readAll_(SHEETS.ALC).forEach(function (a) {
      if (String(a['予約番号']) === rid && a['状態'] === ALC_ST.ACTIVE) updateRow_(SHEETS.ALC, a._row, { '状態': ALC_ST.RELEASED });
    });
    updateRow_(SHEETS.RES, r._row, { '状態': ST.CANCELLED, '更新日時': now });
    audit_('取消し', admin.label, rid, reason, String(r['利用日']) + ' ' + String(r['時間帯']));
    return { status: 'CANCELLED', reservationId: rid, summary: summaryOf_(r) };
  });
}

/**
 * 予約の変更（管理者だけ。D-024）。日・時間帯・区画と、名前などを直す。
 * ・日・時間帯・区画を変えるときは、同じロックの中で、新しい枠が取れてから古い枠を放す。取れなければ何も変えない
 *   （取り消してから登録し直すと、その間に他の人に取られることがあるため）。
 * ・同じ内容を送り直しても、2回目は何も変えない（変えた後の状態を指定する形のため）。
 * ・台数・受付経路・予約番号は変えない。
 */
function adminChange_(admin, q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return { status: 'REJECTED', reason: 'INVALID', reasonText: REASON_TEXT.INVALID };
  var rid = cleanText_(q.reservationId, 20);
  if (!rid) return { status: 'REJECTED', reason: 'INVALID', reasonText: '予約番号を確認してください' };
  return withLock_(function () {
    var now = new Date();
    var today = ymd_(now);
    var rows = readAll_(SHEETS.RES);
    var r = rows.filter(function (x) { return String(x['予約番号']) === rid; })[0];
    if (!r && archivedIds_()[rid]) return { status: 'REJECTED', reason: 'ARCHIVED', reasonText: REASON_TEXT.ARCHIVED };
    if (!r) return { status: 'REJECTED', reason: 'NOT_FOUND', reasonText: 'その予約番号は見つかりません' };
    if (r['状態'] !== ST.CONFIRMED) return { status: 'REJECTED', reason: 'NOT_CONFIRMED', reasonText: '確定している予約だけ変更できます' };
    if (String(r['利用日']) < archiveBoundary_(today)) return { status: 'REJECTED', reason: 'ARCHIVED', reasonText: REASON_TEXT.ARCHIVED };
    var qty = Number(r['台数']) || 1;
    var req = {};
    Object.keys(q).forEach(function (k) { req[k] = q[k]; });
    req.quantity = qty;
    req.requestId = 'change-' + rid; // 入力の検査だけに使う（変更は、変えた後の状態を指定する形で二重にならない）
    var n = normalizeRequest_(req, CHANNELS.PHONE);
    if (n.error) return { status: 'REJECTED', reason: 'INVALID', field: n.error, reasonText: n.error + 'を確認してください' };
    var v = n.value;
    var allocs = readAll_(SHEETS.ALC);
    var mine = allocs.filter(function (a) { return String(a['予約番号']) === rid && a['状態'] === ALC_ST.ACTIVE; });
    var mySpaces = mine.map(function (a) { return String(a['駐車場']); }).sort();
    var oldDate = String(r['利用日']), oldSlot = String(r['コマID']);
    var move = v.date !== oldDate || v.slotId !== oldSlot || (v.preferSpace && mySpaces.indexOf(v.preferSpace) < 0);
    var spaces = mySpaces;
    if (move) {
      var reason = ruleViolation_(v, now, CHANNELS.PHONE);
      if (!reason) {
        var others = allocs.filter(function (a) { return String(a['予約番号']) !== rid; });
        spaces = chooseSpaces_(activeSpaces_(others, v.date, v.slotId), qty, v.preferSpace, blockedSpaces_(blocksAll_(), v.date, v.slotId));
        if (!spaces) reason = 'FULL';
      }
      if (reason) return { status: 'REJECTED', reason: reason, reasonText: REASON_TEXT[reason] || REASON_TEXT.INVALID };
    }
    var t = slotTimes_(v.date, v.slotId);
    var next = {
      '利用日': v.date, 'コマID': v.slotId, '時間帯': SLOTS[v.slotId].mark + ' ' + SLOTS[v.slotId].label + ' ' + slotText_(v.slotId),
      '料金合計': SLOTS[v.slotId].price * qty, '開始日時': iso_(t.start), '終了日時': iso_(t.end),
      '氏名': v.name, '棟': v.building, '部屋番号': v.room, '電話番号': v.phone, 'メール': v.email,
      '連絡方法': v.email ? 'メール' : (v.phone ? '電話' : 'なし'),
    };
    var changed = {}, notes = [];
    Object.keys(next).forEach(function (k) { if (String(r[k]) !== String(next[k])) changed[k] = next[k]; });
    if (move && String(spaces) !== String(mySpaces)) notes.push('区画 ' + mySpaces.join('・') + '→' + spaces.join('・'));
    if (!Object.keys(changed).length && !move) return { status: 'CHANGED', reservationId: rid, already: true, reservation: changedView_(rid, next, spaces, qty) };
    // 新しい枠を先に取り、それから古い枠を放す（同じロックの中）
    if (move) {
      spaces.forEach(function (s) {
        appendRow_(SHEETS.ALC, { '予約番号': rid, '利用日': v.date, 'コマID': v.slotId, '駐車場': s, '状態': ALC_ST.ACTIVE, '確保日時': iso_(now) });
      });
      mine.forEach(function (a) { updateRow_(SHEETS.ALC, a._row, { '状態': ALC_ST.RELEASED }); });
    }
    changed['更新日時'] = iso_(now);
    updateRow_(SHEETS.RES, r._row, changed);
    if (changed['利用日'] || changed['コマID']) notes.unshift(String(r['利用日']) + ' ' + SLOTS[oldSlot].mark + '→' + v.date + ' ' + SLOTS[v.slotId].mark);
    ['氏名', '棟', '部屋番号', '電話番号', 'メール'].forEach(function (k) { if (k in changed) notes.push(k + ' ' + String(r[k]) + '→' + String(changed[k])); });
    audit_('変更', admin.label, rid, cleanText_(q.reason, 200) || '', notes.join('、'));
    return { status: 'CHANGED', reservationId: rid, fromDate: oldDate, reservation: changedView_(rid, next, spaces, qty) };
  });
}

/** 変更した後の予約（画面の更新用） */
function changedView_(rid, row, spaces, qty) {
  var s = SLOTS[row['コマID']];
  return {
    reservationId: rid, date: row['利用日'], slotId: row['コマID'], slotLabel: s.label, slotMark: s.mark, timeText: slotText_(row['コマID']),
    spaces: spaces.slice(), quantity: qty, priceTotal: row['料金合計'], start: row['開始日時'], end: row['終了日時'],
    name: row['氏名'], building: row['棟'], room: row['部屋番号'], phone: row['電話番号'], email: row['メール'],
  };
}

function adminCallList_() {
  var rows = readAll_(SHEETS.RES);
  var allocs = readAll_(SHEETS.ALC);
  var ntfs = readAll_(SHEETS.NTF);
  var items = [];
  var idx = rowIndex_(allocs, ntfs);
  var byId = {};
  rows.forEach(function (x) { var id = String(x['予約番号']); if (!byId[id]) byId[id] = x; });
  // 対応済みは、利用日が1週間前より後のものだけ出す（過ぎた分まで並べると、一覧が年々長くなるため）
  var doneFrom = addDaysYmd_(todayYmd_(), -7);
  ntfs.forEach(function (n) {
    var st = String(n['状態']);
    if (st !== NTF_ST.PHONE && st !== NTF_ST.PHONE_DONE && st !== NTF_ST.RETRY) return;
    var r = byId[String(n['予約番号'])];
    if (!r || r['状態'] !== ST.CONFIRMED) return;
    if (st === NTF_ST.PHONE_DONE && String(r['利用日']) < doneFrom) return;
    var s = adminRowOf_(r, idx);
    s.contactDone = st === NTF_ST.PHONE_DONE;
    s.contactBy = String(n['電話対応者'] || '');
    s.contactAt = String(n['電話対応日時'] || '');
    s.why = st === NTF_ST.RETRY ? 'メールが送れていません' : '電話で受付';
    items.push(s);
  });
  return { status: 'OK', items: items };
}

function adminMarkCalled_(admin, q) {
  var rid = cleanText_(q && q.reservationId, 20);
  if (!rid) return { status: 'REJECTED', reason: 'INVALID' };
  return withLock_(function () {
    var n = readAll_(SHEETS.NTF).filter(function (x) { return String(x['予約番号']) === rid; })[0];
    if (!n) return { status: 'REJECTED', reason: 'NOT_FOUND' };
    var now = iso_(new Date());
    updateRow_(SHEETS.NTF, n._row, { '状態': NTF_ST.PHONE_DONE, '電話対応者': admin.label, '電話対応日時': now, '更新日時': now });
    audit_('電話連絡済み', admin.label, rid, '', '');
    return { status: 'OK' };
  });
}
