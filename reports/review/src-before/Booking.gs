/**
 * 予約の中核。オンライン申込みと管理者の代行登録は、必ずここの book_() を通る（要件3・6.5）。
 *
 * 確定の手順（途中で止まっても安全な順序）:
 *   1. ロックを取る（取れなければ ERROR。何も書かない）
 *   2. 同じ受付要求IDの予約があれば、その結果を返す（再送対策）。「受付中」で止まっていたら残骸を片付けてやり直す
 *   3. 規則（受付期間・コマ開始）と空きを、ロックの中で台帳から読み直して判定
 *   4. 予約行を「受付中」で書く → 駐車枠を確保 → 予約行を「確定」にする
 *   5. flush してからロックを解放（解放前に反映しないと、次の人が古い台帳を読む）
 */

/** 台帳の状態 → 画面・試験用の状態コード（ファイルの読込順に依存しないよう関数にする） */
function statusOf_(state) {
  var m = {}; m[ST.CONFIRMED] = 'CONFIRMED'; m[ST.REJECTED] = 'REJECTED'; m[ST.PENDING] = 'PENDING'; m[ST.CANCELLED] = 'CANCELLED';
  return m[state] || 'UNKNOWN';
}

var REASON_TEXT = {
  FULL: 'その時間帯は満車になりました',
  CUTOFF: 'その時間帯は受付を締め切りました（開始時刻を過ぎています）',
  WINDOW: 'まだ受付期間ではありません',
  PAST: '過ぎた日付です',
  ARCHIVED: '2か月より前の日付は、保管のシートに移したため、登録・取消しができません',
  CLOSED: '画面からの申し込みは受け付けていません。予約は電話で受け付けています',
  INVALID: '入力内容に不足や誤りがあります',
  BUSY: '混み合っていて処理できませんでした。少し待ってからもう一度お試しください',
  SYSTEM: '処理できませんでした。時間をおいて「結果を確かめる」を押してください',
};

/** ロックを取って fn を実行する。必ず flush してから解放する */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { status: 'ERROR', reason: 'BUSY', reasonText: REASON_TEXT.BUSY };
  try {
    return fn();
  } finally {
    SpreadsheetApp.flush();
    lock.releaseLock();
  }
}

/** 例外を利用者向けの応答にする（成功したように見せない） */
function guard_(fn) {
  try { return fn(); } catch (e) {
    console.error(e && e.stack ? e.stack : e);
    return { status: 'ERROR', reason: 'SYSTEM', reasonText: REASON_TEXT.SYSTEM };
  }
}

// ---------------------------------------------------------------- 入力の検査（サーバー側）
function cleanText_(v, max) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  var s = String(v).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (s.length > max) return null;
  return s;
}

/** 申込み内容を検査して正規化する。誤りがあれば { error: '項目名' } */
function normalizeRequest_(req, channel) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { error: '内容' };
  var r = {};
  r.requestId = cleanText_(req.requestId, 100);
  if (!r.requestId || !/^[A-Za-z0-9._:-]{8,100}$/.test(r.requestId)) return { error: '受付要求' };
  if (!isValidYmd_(req.date)) return { error: '利用日' };
  r.date = req.date;
  if (typeof req.slotId !== 'string' || !SLOTS[req.slotId]) return { error: '時間帯' };
  r.slotId = req.slotId;
  if (typeof req.quantity !== 'number' || req.quantity % 1 !== 0 || req.quantity < 1 || req.quantity > maxQuantity_()) return { error: '台数' };
  r.quantity = req.quantity;
  r.name = cleanText_(req.name, 50);
  if (!r.name) return { error: 'お名前' };
  r.building = cleanText_(req.building, 20);
  if (r.building === null) return { error: '棟' };
  r.room = cleanText_(req.room, 20);
  if (!r.room) return { error: '部屋番号' };
  r.phone = cleanText_(req.phone, 20);
  if (r.phone === null || (r.phone && !/^[0-9\uFF10-\uFF19+()\-\u2010\uFF0D\u30FC\s]{6,20}$/.test(r.phone))) return { error: '電話番号' };
  r.phone = (r.phone || '').replace(/[\uFF10-\uFF19]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }).replace(/[\u2010\uFF0D\u30FC]/g, '-');
  r.email = cleanText_(req.email, 254);
  if (r.email === null || (r.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email))) return { error: 'メールアドレス' };
  if (channel === CHANNELS.ONLINE && rules_().emailRequiredOnline && !r.email) return { error: 'メールアドレス' };
  if (channel !== CHANNELS.ONLINE && !r.phone && !r.email) return { error: '電話番号' };
  r.note = cleanText_(req.note, 200) || '';
  r.preferSpace = SPACES.indexOf(String(req.preferSpace || '')) >= 0 ? String(req.preferSpace) : '';
  r.receivedAt = cleanText_(req.receivedAt, 40) || '';
  return { value: r };
}

// ---------------------------------------------------------------- 予約番号
function newReservationId_(existing) {
  var used = archivedIds_(); // 保管した予約の番号とも重ならないようにする（D-023）
  existing.forEach(function (x) { used[String(x['予約番号'])] = true; });
  for (var i = 0; i < 50; i++) {
    var n = String(100000 + Math.floor(Math.random() * 900000));
    if (!used[n]) return n;
  }
  throw new Error('予約番号を作れませんでした');
}

// ---------------------------------------------------------------- 予約の要約（画面に返す。個人情報は含めない）
function summaryOf_(row) {
  var slotId = String(row['コマID']);
  return {
    reservationId: String(row['予約番号']),
    date: String(row['利用日']),
    slotId: slotId,
    slotLabel: SLOTS[slotId] ? SLOTS[slotId].label : '',
    slotMark: SLOTS[slotId] ? SLOTS[slotId].mark : '',
    timeText: SLOTS[slotId] ? slotText_(slotId) : '',
    quantity: Number(row['台数']),
    priceTotal: Number(row['料金合計']),
    start: String(row['開始日時']),
    end: String(row['終了日時']),
    state: String(row['状態']),
  };
}

function resultOf_(row) {
  var status = statusOf_(row['状態']);
  var reason = row['不成立理由'] ? String(row['不成立理由']) : undefined;
  return {
    status: status,
    reservationId: status === 'CONFIRMED' || status === 'CANCELLED' ? String(row['予約番号']) : undefined,
    reason: reason,
    reasonText: reason ? REASON_TEXT[reason] : undefined,
    summary: summaryOf_(row),
  };
}

// ---------------------------------------------------------------- 規則の判定
/**
 * 受付期間：
 * ・住民の申込み（ONLINE）は、住民の画面に見せている範囲（residentLeadDays 日後〜residentViewMonths か月先）。
 *   bookingWindowDays が数で決まっていれば、それより先も受け付けない。
 * ・管理者の登録（電話・窓口）は、今日から viewMonths か月先まで。
 */
function ruleViolation_(r, now, channel) {
  var rules = rules_();
  var today = ymd_(now);
  // 管理者の登録（電話・窓口）は、過ぎた日・始まったコマも受け付ける（あとから台帳に記録する・直すため）
  if (channel === CHANNELS.ONLINE) {
    if (r.date < today) return 'PAST';
    var t = slotTimes_(r.date, r.slotId);
    if (rules.cutoff === 'SLOT_START' && now.getTime() >= t.start.getTime()) return 'CUTOFF';
  }
  if (channel === CHANNELS.ONLINE) {
    if (r.date < residentFrom_(today) || r.date > residentUntil_(today)) return 'WINDOW';
    if (!withinWindowDays_(rules, today, r.date)) return 'WINDOW';
  } else if (r.date > viewUntil_(today)) return 'WINDOW';
  else if (r.date < archiveBoundary_(today)) return 'ARCHIVED';
  return null;
}

/** bookingWindowDays（数で決まっているときだけ）の内側か */
function withinWindowDays_(rules, today, date) {
  var w = rules.bookingWindowDays;
  if (w === null || w === undefined || w === '') return true;
  return daysBetween_(today, date) <= Number(w);
}

function activeSpaces_(allocs, date, slotId) {
  var used = {};
  allocs.forEach(function (a) {
    if (a['状態'] === ALC_ST.ACTIVE && String(a['利用日']) === date && String(a['コマID']) === slotId) used[String(a['駐車場'])] = true;
  });
  return used;
}

/**
 * 空いている駐車場を選ぶ。1コマの台数の上限（capacityPerSlot）を超えず、使用禁止の区画（blocked）は使わない。
 * 管理者の割当て規則（未決定）に備えて関数を分けておく
 */
function chooseSpaces_(used, quantity, prefer, blocked) {
  blocked = blocked || {};
  if (Object.keys(used).length + quantity > capacity_()) return null;
  var free = SPACES.filter(function (s) { return !used[s] && !blocked[s]; });
  // 管理者が表の特定の区画を押して登録したときは、その区画を先に使う
  if (prefer && free.indexOf(prefer) > 0) free = [prefer].concat(free.filter(function (s) { return s !== prefer; }));
  if (free.length < quantity) return null; // 一部だけの確定はしない（仮ルール ALL_OR_NOTHING）
  return free.slice(0, quantity);
}

// ---------------------------------------------------------------- 本体
function book_(req, channel, operator) {
  var n = normalizeRequest_(req, channel);
  if (n.error) return { status: 'REJECTED', reason: 'INVALID', field: n.error, reasonText: n.error + 'を確認してください' };
  var r = n.value;
  // 住民の受付を閉じているときは、台帳に何も書かずに断る（公開関数は誰でも直接呼べるため、画面を消すだけでなくここで止める）
  if (channel === CHANNELS.ONLINE && !residentBookingOpen_()) return { status: 'REJECTED', reason: 'CLOSED', reasonText: REASON_TEXT.CLOSED };
  return withLock_(function () {
    var now = new Date();
    var reservations = readAll_(SHEETS.RES);
    var existing = null;
    for (var i = 0; i < reservations.length; i++) if (String(reservations[i]['受付要求ID']) === r.requestId) { existing = reservations[i]; break; }
    if (existing && existing['状態'] !== ST.PENDING) return resultOf_(existing);

    var allocs = readAll_(SHEETS.ALC);
    var id = existing ? String(existing['予約番号']) : newReservationId_(reservations);
    if (existing) {
      // 前回の処理が途中で止まった残骸：確保した枠を解放してからやり直す
      allocs.forEach(function (a) {
        if (String(a['予約番号']) === id && a['状態'] === ALC_ST.ACTIVE) { updateRow_(SHEETS.ALC, a._row, { '状態': ALC_ST.RELEASED }); a['状態'] = ALC_ST.RELEASED; }
      });
    }
    var t = slotTimes_(r.date, r.slotId);
    var reason = ruleViolation_(r, now, channel);
    var spaces = null;
    if (!reason) {
      spaces = chooseSpaces_(activeSpaces_(allocs, r.date, r.slotId), r.quantity, r.preferSpace, blockedSpaces_(blocksAll_(), r.date, r.slotId));
      if (!spaces) reason = 'FULL';
    }
    var row = {
      '予約番号': id, '受付要求ID': r.requestId, '状態': ST.PENDING, '受付経路': channel, '利用日': r.date, 'コマID': r.slotId,
      '時間帯': SLOTS[r.slotId].mark + ' ' + SLOTS[r.slotId].label + ' ' + slotText_(r.slotId), '台数': r.quantity, '料金合計': SLOTS[r.slotId].price * r.quantity,
      '開始日時': iso_(t.start), '終了日時': iso_(t.end), '氏名': r.name, '棟': r.building, '部屋番号': r.room, '電話番号': r.phone,
      'メール': r.email, '連絡方法': r.email ? 'メール' : (r.phone ? '電話' : 'なし'), '受付日時': iso_(now), '更新日時': iso_(now),
      '登録者': operator || '', '電話等の受付日時': r.receivedAt, '備考': r.note,
    };
    var rowNo = existing ? existing._row : reservations.length + 2;
    if (reason) {
      row['状態'] = ST.REJECTED; row['不成立理由'] = reason;
      if (existing) updateRow_(SHEETS.RES, rowNo, { '状態': ST.REJECTED, '不成立理由': reason, '更新日時': iso_(now) });
      else appendRow_(SHEETS.RES, row);
      return resultOf_(row);
    }
    if (!existing) appendRow_(SHEETS.RES, row);
    spaces.forEach(function (s) {
      appendRow_(SHEETS.ALC, { '予約番号': id, '利用日': r.date, 'コマID': r.slotId, '駐車場': s, '状態': ALC_ST.ACTIVE, '確保日時': iso_(now) });
    });
    updateRow_(SHEETS.RES, rowNo, { '状態': ST.CONFIRMED, '確定日時': iso_(now), '更新日時': iso_(now) });
    var ntf = r.email ? NTF_ST.PENDING : (channel === CHANNELS.ONLINE ? NTF_ST.NONE : NTF_ST.PHONE);
    appendRow_(SHEETS.NTF, { '予約番号': id, '状態': ntf, '送信先': r.email, '試行回数': 0, '更新日時': iso_(now) });
    if (operator) audit_('代行登録', operator, id, channel === CHANNELS.PHONE ? '電話受付' : '窓口受付', SLOTS[r.slotId].mark + ' ' + SLOTS[r.slotId].label + ' ' + r.date + ' ' + r.quantity + '台');
    row['状態'] = ST.CONFIRMED;
    var out = resultOf_(row);
    out.spaces = spaces;
    return out;
  });
}

// ---------------------------------------------------------------- 空き状況（一般公開。個人情報を含めない）
function availability_(from, to, scope) {
  if (!isValidYmd_(from) || !isValidYmd_(to) || to < from || daysBetween_(from, to) > 62) return { status: 'REJECTED', reason: 'INVALID' };
  var allocs = readAll_(SHEETS.ALC);
  var blocks = blocksAll_();
  var used = {};
  var usedSp = {};
  allocs.forEach(function (a) {
    if (a['状態'] !== ALC_ST.ACTIVE) return;
    var k = String(a['利用日']) + '|' + String(a['コマID']);
    used[k] = (used[k] || 0) + 1;
    (usedSp[k] = usedSp[k] || {})[String(a['駐車場'])] = true;
  });
  var now = new Date();
  var rules = rules_();
  var today = ymd_(now);
  // 住民の画面：今日から residentLeadDays 日後〜residentViewMonths か月先だけを返す（その外の日は返さない）。
  // 管理者の画面：今日〜viewMonths か月先。
  var resident = scope !== 'admin';
  var arcFrom = archiveBoundary_(today);
  var first = resident ? residentFrom_(today) : today;
  var until = resident ? residentUntil_(today) : viewUntil_(today);
  if (resident) {
    if (from < first) from = first;
    if (to > until) to = until;
  }
  var cap = capacity_();
  var open = residentBookingOpen_();
  var days = [];
  for (var d = from; d <= to; d = addDaysYmd_(d, 1)) {
    var slots = SLOT_IDS.map(function (id) {
      var t = slotTimes_(d, id);
      // 残り＝「上限までの残り」と「予約も使用禁止もない区画の数」の少ない方
      var k = d + '|' + id;
      var bl = blockedSpaces_(blocks, d, id);
      var physical = SPACES.filter(function (sp) { return !(usedSp[k] && usedSp[k][sp]) && !bl[sp]; }).length;
      var remaining = Math.max(0, Math.min(cap - (used[k] || 0), physical));
      // closed：過ぎた・始まった・見せる範囲の外。online：住民が画面から申し込めるか
      // 保管した日付は、管理者の台帳でも「過ぎた（直せる）」にしない
      var past = now.getTime() >= t.start.getTime() && d >= arcFrom;
      var closed = d < first || now.getTime() >= t.start.getTime() || d > until;
      var online = open && resident && !closed && remaining > 0 && withinWindowDays_(rules, today, d);
      return { slotId: id, mark: SLOTS[id].mark, label: SLOTS[id].label, timeText: slotText_(id), start: iso_(t.start), end: iso_(t.end), price: SLOTS[id].price, capacity: cap, remaining: remaining, bookable: !closed && remaining > 0, closed: closed, past: past, online: online };
    });
    days.push({ date: d, slots: slots });
  }
  return { status: 'OK', today: today, from: first, until: until, residentBooking: open, capacity: cap, maxQuantity: maxQuantity_(), days: days };
}

function requestStatus_(requestId) {
  var id = cleanText_(requestId, 100);
  if (!id) return { status: 'UNKNOWN' };
  var rows = readAll_(SHEETS.RES);
  for (var i = 0; i < rows.length; i++) if (String(rows[i]['受付要求ID']) === id) return resultOf_(rows[i]);
  return { status: 'UNKNOWN' };
}

/** 予約番号と電話番号の下4桁で、自分の予約を確認する（U-08。本人確認方式は仮） */
function lookup_(q) {
  // 使っていない入口は閉じる（公開関数は誰でも直接呼べるため、画面から外すだけでなくここで止める。D-022）
  if (!residentLookupOpen_()) return { status: 'CLOSED' };
  var rid = cleanText_(q && q.reservationId, 20);
  var tail = cleanText_(q && q.phoneTail, 4);
  if (!rid || !tail || !/^\d{4}$/.test(tail)) return { status: 'NOT_FOUND' };
  var rows = readAll_(SHEETS.RES);
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r['予約番号']) === rid && String(r['電話番号']).replace(/\D/g, '').slice(-4) === tail && r['状態'] !== ST.REJECTED) {
      return { status: 'OK', summary: summaryOf_(r) };
    }
  }
  return { status: 'NOT_FOUND' };
}
