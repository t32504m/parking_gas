/**
 * 管理者の確認（仮の方式：管理者メールアドレス＋管理者パスコード。docs/DECISIONS.md D-001）
 * ・パスコードはスクリプトプロパティ ADMINS に、塩付きハッシュでだけ保存する。
 * ・確認に成功すると、6時間有効な確認済みの印（トークン）を返す。画面は以後これを付けて呼ぶ。
 * ・管理者用の関数は、必ずサーバー側でこの確認を通す（画面の切替だけを認証にしない：要件9）。
 */
var ADMIN_TOKEN_TTL_SEC = 6 * 3600;
var ADMIN_MAX_FAILS = 5;

function admins_() {
  try { return JSON.parse(prop_('ADMINS') || '{}'); } catch (e) { return {}; }
}

function hashSecret_(salt, secret) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + String(secret)));
}

function normEmail_(e) { return String(e || '').trim().toLowerCase(); }

/** 失敗回数が多い鍵（管理者のメール・予約番号）は一時的に止める（総当たり対策） */
// CacheService は本物の GAS で best-effort（読込みは当たり前に退去、put は 120ms を超えると例外を出す。D-041）。
// 数え上げができないとき、正しい管理者まで止めるほうが害が大きい（締出の精度低下は D-029・PT-B5 の人判断待ちと整合）。
function tooManyFails_(key) {
  var n;
  try { n = Number(CacheService.getScriptCache().get('fail:' + key) || 0); } catch (e) { return false; }
  return n >= ADMIN_MAX_FAILS;
}
function countFail_(key) {
  try {
    var c = CacheService.getScriptCache();
    var n = Number(c.get('fail:' + key) || 0) + 1;
    c.put('fail:' + key, String(n), 15 * 60);
  } catch (e) { /* 失敗が数えられなくても、確かめること自体は止めない */ }
}

/**
 * 総当たりを止めて確かめる：同じ鍵の失敗が15分に ADMIN_MAX_FAILS 回に達したら、check を呼ばずに null を返す。
 * check は成功なら値を、失敗なら null を返す。予約の登録と同じスクリプトのロックは取らない（D-029）。
 * lock：渡したときだけ、数え上げと判定をそのロックの中で行う（同時に送って数え上げを逃れさせない）
 */
function limited_(key, check, lock) {
  if (lock && !lock.tryLock(15000)) return null;
  try {
    if (tooManyFails_(key)) return null;
    var v = check();
    if (!v) countFail_(key);
    return v;
  } finally {
    if (lock) lock.releaseLock();
  }
}

/** パスコードの前後の空白・改行は無視する（コピー＆貼り付けで混ざりやすいため） */
function normSecret_(s) { return typeof s === 'string' ? s.trim() : ''; }

function verifyAdmin_(email, secret) {
  email = normEmail_(email);
  secret = normSecret_(secret);
  if (!email || !secret) return null;
  // 数え上げをユーザーロックの中で直列化する（D-041・PT-B4: CacheService の数え上げは原子ではなく、同時に送ると締出数を逃げられる）。
  // 予約登録と同じスクリプトロックではないので、ログインが登録の待ち時間を発生させないという D-029 の意図は変わらない
  return limited_(email, function () {
    var a = admins_()[email];
    // 知らないメールでも同じだけ計算する（時間の差で、管理者のメールかどうかを知られないため）
    var h = hashSecret_(a ? a.salt : 'unknown', secret);
    return a && h === a.hash ? adminInfo_(email, a) : null;
  }, LockService.getUserLock());
}

/** ver：パスコードの版。トークンに入れ、パスコードを替えたら前のトークンを使えなくする（D-028） */
function adminInfo_(email, a) { return { email: email, name: a.name, label: a.name + ' <' + email + '>', ver: String(a.hash).slice(0, 16) }; }

/** auth: { token } または { email, secret } */
function adminOf_(auth) {
  if (!auth || typeof auth !== 'object') return null;
  if (typeof auth.token === 'string' && auth.token) {
    var t = '';
    try { t = String(CacheService.getScriptCache().get('adm:' + auth.token) || ''); } catch (e) { /* 読めないときは、切れと同じ扱い（画面は再確認へ戻る） */ }
    var i = t.lastIndexOf('|');
    var email = t.slice(0, i), a = i > 0 ? admins_()[email] : null;
    return a && adminInfo_(email, a).ver === t.slice(i + 1) ? adminInfo_(email, a) : null;
  }
  return verifyAdmin_(auth.email, auth.secret);
}


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
  var cols = Object.assign({ stateText: '状態', channel: '受付経路', operator: '登録者', createdAt: '受付日時' }, PERSON_COLS);
  Object.keys(cols).forEach(function (k) { s[k] = String(r[cols[k]]); });
  s.channelText = { ONLINE: 'オンライン', PHONE: '電話', COUNTER: '窓口' }[s.channel] || s.channel;
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
    var f = findReservation_(rid);
    if (f.error) return f.error;
    var r = f.row;
    if (r['状態'] === ST.CANCELLED) return { status: 'CANCELLED', reservationId: rid, already: true };
    if (r['状態'] !== ST.CONFIRMED) return { status: 'REJECTED', reason: 'NOT_CONFIRMED', reasonText: '確定していない予約は取り消せません' };
    // 予約の行を先に「取消済み」にしてから枠を放す（間で止まっても、tidyAllocs_ で放される。D-026）
    updateRow_(SHEETS.RES, r, { '状態': ST.CANCELLED, '更新日時': iso_(new Date()) });
    releaseAllocs_(readAll_(SHEETS.ALC), rid);
    audit_('取消し', admin.label, rid, reason, String(r['利用日']) + ' ' + String(r['時間帯']));
    refreshMonthSheets_([String(r['利用日'])]);
    return { status: 'CANCELLED', reservationId: rid, summary: summaryOf_(r) };
  });
}

/**
 * 予約番号で、日々使うシートの行を探す（ロックの中で呼ぶ）。
 * 保管した予約・保管の境目より前の予約は、登録・取消し・変更ができないので error を返す
 */
function findReservation_(rid) {
  var r = readAll_(SHEETS.RES).filter(function (x) { return String(x['予約番号']) === rid; })[0];
  var archived = { status: 'REJECTED', reason: 'ARCHIVED', reasonText: REASON_TEXT.ARCHIVED };
  if (!r) return { error: archivedIds_()[rid] ? archived : { status: 'REJECTED', reason: 'NOT_FOUND', reasonText: 'その予約番号は見つかりません' } };
  if (String(r['利用日']) < archiveBoundary_(todayYmd_())) return { error: archived };
  return { row: r };
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
    var f = findReservation_(rid);
    if (f.error) return f.error;
    var r = f.row;
    if (r['状態'] !== ST.CONFIRMED) return { status: 'REJECTED', reason: 'NOT_CONFIRMED', reasonText: '確定している予約だけ変更できます' };
    tidyAllocs_(rid); // 前の変更が途中で止まっていたら、先にそろえる
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
        var prefer = v.preferSpace || neighborSpaces_(readAll_(SHEETS.RES), others, v.date, v.slotId, v.building, v.room, rid);
        spaces = chooseSpaces_(activeSpaces_(others, v.date, v.slotId), qty, prefer, blockedSpaces_(activeBlocks_(v.date, v.date), v.date, v.slotId), capacityFor_(CHANNELS.PHONE));
        if (!spaces) reason = 'FULL';
      }
      if (reason) return { status: 'REJECTED', reason: reason, reasonText: REASON_TEXT[reason] || REASON_TEXT.INVALID };
    }
    var next = personFields_(slotFields_(v.date, v.slotId, qty), v);
    var changed = {}, notes = [];
    Object.keys(next).forEach(function (k) { if (String(r[k]) !== String(next[k])) changed[k] = next[k]; });
    if (move && String(spaces) !== String(mySpaces)) notes.push('区画 ' + mySpaces.join('・') + '→' + spaces.join('・'));
    if (!Object.keys(changed).length && !move) return { status: 'CHANGED', reservationId: rid, already: true, reservation: changedView_(rid, next, spaces, qty) };
    // 新しい枠を足す → 予約の行を書き換える → 古い枠を放す（同じロックの中）。
    // どこで止まっても、tidyAllocs_ で「変更前」か「変更後」にそろう（D-026）
    if (move) {
      spaces.forEach(function (s) {
        appendRow_(SHEETS.ALC, { '予約番号': rid, '利用日': v.date, 'コマID': v.slotId, '駐車場': s, '状態': ALC_ST.ACTIVE, '確保日時': iso_(now) });
      });
    }
    changed['更新日時'] = iso_(now);
    var before = {};
    Object.keys(changed).forEach(function (k) { before[k] = r[k]; });
    updateRow_(SHEETS.RES, r, changed);
    if (move) updateRows_(SHEETS.ALC, mine.map(function (a) { return { row: a, set: { '状態': ALC_ST.RELEASED } }; }));
    if (changed['利用日']) remindAgain_(rid, v.date, now);
    if (changed['利用日'] || changed['コマID']) notes.unshift(oldDate + ' ' + SLOTS[oldSlot].mark + '→' + v.date + ' ' + SLOTS[v.slotId].mark);
    Object.keys(PERSON_COLS).map(function (k) { return PERSON_COLS[k]; }).forEach(function (k) { if (k in changed) notes.push(k + ' ' + String(before[k]) + '→' + String(changed[k])); });
    audit_('変更', admin.label, rid, cleanText_(q.reason, 200) || '', notes.join('、'));
    refreshMonthSheets_([oldDate, v.date]);
    return { status: 'CHANGED', reservationId: rid, fromDate: oldDate, reservation: changedView_(rid, next, spaces, qty) };
  });
}

/**
 * 利用日を変えた予約の前日の案内を、変更後の利用日に合わせる（D-030）。
 * 前の日の分を送った後でも、変更後の日の前日にもう一度送る。前日の送る時刻を過ぎていれば送らない
 */
function remindAgain_(rid, date, now) {
  var n = readAll_(SHEETS.NTF).filter(function (x) { return String(x['予約番号']) === rid; })[0];
  if (!n || !String(n['送信先'] || '') || [NTF_ST.PHONE, NTF_ST.PHONE_DONE].indexOf(String(n['状態'])) >= 0) return;
  var late = now.getTime() >= remindAt_(date).getTime();
  updateRow_(SHEETS.NTF, n, { '状態': late ? NTF_ST.NONE : NTF_ST.PENDING, '試行回数': 0, '最終結果': late ? REMIND_LATE : '', '更新日時': iso_(now) });
}

/** 変更した後の予約（画面の更新用） */
function changedView_(rid, row, spaces, qty) {
  var v = summaryOf_(Object.assign({ '予約番号': rid, '台数': qty, '状態': ST.CONFIRMED }, row));
  v.spaces = spaces.slice();
  Object.keys(PERSON_COLS).forEach(function (k) { v[k] = row[PERSON_COLS[k]]; });
  return v;
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
    updateRow_(SHEETS.NTF, n, { '状態': NTF_ST.PHONE_DONE, '電話対応者': admin.label, '電話対応日時': now, '更新日時': now });
    audit_('電話連絡済み', admin.label, rid, '', '');
    return { status: 'OK' };
  });
}
