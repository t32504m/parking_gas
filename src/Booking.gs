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

/**
 * ロックを取って fn を実行する。必ず flush してから解放する。
 * ロックの前に読んだ行は使わない（入るときに捨てる）。出るときも捨てる（解放の後は、他の人が書き換えうるため）
 */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { status: 'ERROR', reason: 'BUSY', reasonText: REASON_TEXT.BUSY };
  forgetRows_();
  try {
    return fn();
  } finally {
    forgetRows_();
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

/** 受付要求ID（画面が作る、再送しても同じ値）。形が違えば null */
function requestIdOf_(v) {
  var id = cleanText_(v, 100);
  return id && /^[A-Za-z0-9._:-]{8,100}$/.test(id) ? id : null;
}

/** 申込み内容を検査して正規化する。誤りがあれば { error: '項目名' } */
function normalizeRequest_(req, channel) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { error: '内容' };
  var r = {};
  r.requestId = requestIdOf_(req.requestId);
  if (!r.requestId) return { error: '受付要求' };
  if (!isValidYmd_(req.date)) return { error: '利用日' };
  r.date = req.date;
  if (SLOT_IDS.indexOf(req.slotId) < 0) return { error: '時間帯' }; // SLOTS[x] では constructor なども通る
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
  if (r.phone === null || (r.phone && !/^[0-9\uFF10-\uFF19+\uFF0B()\uFF08\uFF09\-\u2010-\u2015\u2212\uFF0D\u30FC\uFF70\s]{6,20}$/.test(r.phone))) return { error: '電話番号' };
  r.phone = formatPhone_(r.phone);
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
function chooseSpaces_(used, quantity, prefer, blocked, cap) {
  blocked = blocked || {};
  if (Object.keys(used).length + quantity > (cap || capacity_())) return null;
  var free = SPACES.filter(function (s) { return !used[s] && !blocked[s]; });
  // 先に使う区画（管理者が表で押した区画、または連続の予約の区画。D-031）。空いていなければ、ほかの空いている区画
  var first = [].concat(prefer || []).filter(function (s, i, a) { return free.indexOf(s) >= 0 && a.indexOf(s) === i; });
  free = first.concat(free.filter(function (s) { return first.indexOf(s) < 0; }));
  if (free.length < quantity) return null; // 一部だけの確定はしない（仮ルール ALL_OR_NOTHING）
  return free.slice(0, quantity);
}

/** 同じ部屋かを比べるための形（全角と半角・前後の空白・「棟」「号室」「号」の有無をそろえる。D-031） */
function roomKey_(building, room) {
  var f = function (s, cut) {
    s = String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').toUpperCase();
    return s.replace(cut, '');
  };
  var b = f(building, /棟$/), r = f(room, /(号室|号)$/);
  return b && r ? b + '|' + r : '';
}

/**
 * 連続の予約の区画（D-031）：同じ部屋の確定の予約が、すぐ前か後のコマにあれば、その区画を返す（前を先に）。
 * S4 の次は翌日の S1、S1 の前は前日の S4。selfId の予約は数えない（変更のとき）
 */
function neighborSpaces_(reservations, allocs, date, slotId, building, room, selfId) {
  var key = roomKey_(building, room);
  if (!key) return [];
  var i = SLOT_IDS.indexOf(slotId), last = SLOT_IDS.length - 1;
  var around = [
    i > 0 ? [date, SLOT_IDS[i - 1]] : [addDaysYmd_(date, -1), SLOT_IDS[last]],
    i < last ? [date, SLOT_IDS[i + 1]] : [addDaysYmd_(date, 1), SLOT_IDS[0]],
  ];
  var ids = around.map(function (p) {
    return reservations.filter(function (x) {
      return x['状態'] === ST.CONFIRMED && String(x['予約番号']) !== String(selfId || '') && String(x['利用日']) === p[0]
        && String(x['コマID']) === p[1] && roomKey_(x['棟'], x['部屋番号']) === key;
    }).map(function (x) { return String(x['予約番号']); });
  });
  var out = [];
  ids.forEach(function (list, k) {
    allocs.forEach(function (a) {
      if (a['状態'] === ALC_ST.ACTIVE && list.indexOf(String(a['予約番号'])) >= 0 && String(a['利用日']) === around[k][0]
        && String(a['コマID']) === around[k][1] && out.indexOf(String(a['駐車場'])) < 0) out.push(String(a['駐車場']));
    });
  });
  return out;
}

// ---------------------------------------------------------------- 本体
function book_(req, channel, operator) {
  var n = normalizeRequest_(req, channel);
  if (n.error) return { status: 'REJECTED', reason: 'INVALID', field: n.error, reasonText: n.error + 'を確認してください' };
  var r = n.value;
  // 住民の受付を閉じているときは、台帳に何も書かずに断る（公開関数は誰でも直接呼べるため、画面を消すだけでなくここで止める）
  if (channel === CHANNELS.ONLINE && !ruleOn_('residentBooking')) return { status: 'REJECTED', reason: 'CLOSED', reasonText: REASON_TEXT.CLOSED };
  return withLock_(function () {
    var now = new Date();
    var reservations = readAll_(SHEETS.RES);
    var existing = byRequestId_(r.requestId);
    if (existing && existing['状態'] !== ST.PENDING) return resultOf_(existing);
    // 保管した予約と同じ受付要求IDの送り直しは、保管の側の結果を返す（日々使うシートに二重に入れない）
    var archived = existing ? null : archivedByRequestId_(r.requestId);
    if (archived) return resultOf_(archived);

    var allocs = readAll_(SHEETS.ALC);
    var id = existing ? String(existing['予約番号']) : newReservationId_(reservations);
    if (existing) {
      // 前回の処理が途中で止まった残骸：確保した枠を解放してからやり直す
      releaseAllocs_(allocs, id);
    }
    var stamp = iso_(now);
    var reason = ruleViolation_(r, now, channel);
    var spaces = null;
    if (!reason) {
      var prefer = r.preferSpace || neighborSpaces_(reservations, allocs, r.date, r.slotId, r.building, r.room, id);
      spaces = chooseSpaces_(activeSpaces_(allocs, r.date, r.slotId), r.quantity, prefer, blockedSpaces_(activeBlocks_(r.date, r.date), r.date, r.slotId), capacityFor_(channel));
      if (!spaces) reason = 'FULL';
    }
    var row = slotFields_(r.date, r.slotId, r.quantity);
    personFields_(row, r);
    Object.assign(row, {
      '予約番号': id, '受付要求ID': r.requestId, '状態': ST.PENDING, '受付経路': channel, '台数': r.quantity,
      '受付日時': stamp, '更新日時': stamp, '登録者': operator || '', '電話等の受付日時': r.receivedAt, '備考': r.note,
    });
    if (reason) {
      row['状態'] = ST.REJECTED; row['不成立理由'] = reason;
      if (existing) updateRow_(SHEETS.RES, existing, { '状態': ST.REJECTED, '不成立理由': reason, '更新日時': stamp });
      else appendRow_(SHEETS.RES, row);
      return resultOf_(row);
    }
    if (!existing) appendRow_(SHEETS.RES, row);
    var resRow = existing || reservations[reservations.length - 1];
    try {
      spaces.forEach(function (s) {
        appendRow_(SHEETS.ALC, { '予約番号': id, '利用日': r.date, 'コマID': r.slotId, '駐車場': s, '状態': ALC_ST.ACTIVE, '確保日時': stamp });
      });
      updateRow_(SHEETS.RES, resRow, { '状態': ST.CONFIRMED, '確定日時': stamp, '更新日時': stamp });
    } catch (e) {
      // 確定にする前に書込みが失敗した：確保した枠を放し、「受付中」のまま残す（同じ受付要求IDの送り直しで、やり直せる）
      try { releaseAllocs_(readAll_(SHEETS.ALC), id); } catch (e2) { console.error(e2 && e2.stack ? e2.stack : e2); }
      throw e;
    }
    // メールは受付のときには送らず、利用日の前日に「明日のご予約」を送る（D-030）。
    // 前日の送る時刻を過ぎてから受けた予約（当日・夜に入れた翌日の分）には送らない
    var ntf = r.email ? NTF_ST.PENDING : (channel === CHANNELS.ONLINE ? NTF_ST.NONE : NTF_ST.PHONE);
    var late = ntf === NTF_ST.PENDING && now.getTime() >= remindAt_(r.date).getTime();
    appendRow_(SHEETS.NTF, { '予約番号': id, '状態': late ? NTF_ST.NONE : ntf, '送信先': r.email, '試行回数': 0,
      '最終結果': late ? REMIND_LATE : '', '更新日時': stamp });
    if (operator) {
      audit_('代行登録', operator, id, channel === CHANNELS.PHONE ? '電話受付' : '窓口受付', SLOTS[r.slotId].mark + ' ' + SLOTS[r.slotId].label + ' ' + r.date + ' ' + r.quantity + '台');
      refreshMonthSheets_([r.date]);
    }
    row['状態'] = ST.CONFIRMED;
    var out = resultOf_(row);
    out.spaces = spaces;
    return out;
  });
}

/** 予約の時間帯から決まる列（時間帯の文字・料金・開始／終了日時） */
function slotFields_(date, slotId, quantity) {
  var s = SLOTS[slotId], t = slotTimes_(date, slotId);
  return {
    '利用日': date, 'コマID': slotId, '時間帯': s.mark + ' ' + s.label + ' ' + slotText_(slotId),
    '料金合計': s.price * quantity, '開始日時': iso_(t.start), '終了日時': iso_(t.end),
  };
}

/** 申込みの人の項目 → 台帳の列 */
var PERSON_COLS = { name: '氏名', building: '棟', room: '部屋番号', phone: '電話番号', email: 'メール' };

/** 申込みの人の列（normalizeRequest_ の結果から）。連絡方法はメール・電話・なしの順に決める */
function personFields_(row, v) {
  Object.keys(PERSON_COLS).forEach(function (k) { row[PERSON_COLS[k]] = v[k]; });
  row['連絡方法'] = v.email ? 'メール' : (v.phone ? '電話' : 'なし');
  return row;
}

/** その予約の有効な割当てを、まとめて1回で解放にする。解放した行を返す */
function releaseAllocs_(allocs, id) {
  var mine = allocs.filter(function (a) { return String(a['予約番号']) === id && a['状態'] === ALC_ST.ACTIVE; });
  updateRows_(SHEETS.ALC, mine.map(function (a) { return { row: a, set: { '状態': ALC_ST.RELEASED } }; }));
  return mine;
}

/**
 * 止まった実行の残骸を片付ける（D-026。ロックの中で呼ぶ）。有効な割当てのうち、予約が確定でないもの、
 * 利用日・コマが予約の行と合わないもの、同じコマで台数より多い分（後の行）を解放にする。
 * 予約の行が日々使うシートに無い割当て（保管の途中）は触らない。id を渡すと、その予約だけを見る
 */
function tidyAllocs_(id) {
  var res = {}, seen = {};
  readAll_(SHEETS.RES).forEach(function (r) { var k = String(r['予約番号']); if (!res[k]) res[k] = r; });
  var drop = readAll_(SHEETS.ALC).filter(function (a) {
    var k = String(a['予約番号']), r = res[k];
    if (a['状態'] !== ALC_ST.ACTIVE || !r || (id && k !== id)) return false;
    if (r['状態'] !== ST.CONFIRMED || String(a['利用日']) !== String(r['利用日']) || String(a['コマID']) !== String(r['コマID'])) return true;
    seen[k] = (seen[k] || 0) + 1;
    return seen[k] > (Number(r['台数']) || 1);
  });
  if (!drop.length) return;
  updateRows_(SHEETS.ALC, drop.map(function (a) { return { row: a, set: { '状態': ALC_ST.RELEASED } }; }));
  audit_('片付け', '自動', id || '', '止まった処理の残り', drop.length + '件の割当てを解放');
}

// ---------------------------------------------------------------- 空き状況（一般公開。個人情報を含めない）
function availability_(from, to, scope) {
  if (!isValidYmd_(from) || !isValidYmd_(to) || to < from || daysBetween_(from, to) > 62) return { status: 'REJECTED', reason: 'INVALID' };
  var allocs = readAll_(SHEETS.ALC);
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
  if (resident && from < first) from = first;
  if (resident && to > until) to = until;
  var blocks = activeBlocks_(from, to);
  // 住民には上限（capacityPerSlot）で満車と見せる。管理者は全ての区画まで入れられる（D-040）
  var cap = resident ? capacity_() : SPACES.length;
  var open = ruleOn_('residentBooking');
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
      var s = { slotId: id, mark: SLOTS[id].mark, label: SLOTS[id].label, timeText: slotText_(id), start: iso_(t.start), end: iso_(t.end), price: SLOTS[id].price, available: remaining > 0, bookable: !closed && remaining > 0, closed: closed, past: past, online: online };
      // 台数の数は管理者にだけ返す。住民には「空きがある／ない」だけ（D-027）
      if (!resident) { s.capacity = cap; s.remaining = remaining; }
      return s;
    });
    days.push({ date: d, slots: slots });
  }
  var out = { status: 'OK', today: today, from: first, until: until, residentBooking: open, maxQuantity: maxQuantity_(), days: days };
  if (!resident) out.capacity = cap;
  return out;
}

function requestStatus_(requestId) {
  var id = cleanText_(requestId, 100);
  if (!id) return { status: 'UNKNOWN' };
  // 保管した予約も、受付要求IDで結果を確かめられる（D-023）
  var row = byRequestId_(id) || archivedByRequestId_(id);
  return row ? resultOf_(row) : { status: 'UNKNOWN' };
}

/** 受付要求IDで、日々使うシートの予約を探す（無ければ null） */
function byRequestId_(requestId) {
  return readAll_(SHEETS.RES).filter(function (x) { return String(x['受付要求ID']) === requestId; })[0] || null;
}

/** 予約番号と電話番号の下4桁で、自分の予約を確認する（U-08。本人確認方式は仮） */
function lookup_(q) {
  // 使っていない入口は閉じる（公開関数は誰でも直接呼べるため、画面から外すだけでなくここで止める。D-022）
  if (!ruleOn_('residentLookup')) return { status: 'CLOSED' };
  var rid = cleanText_(q && q.reservationId, 20);
  var tail = cleanText_(q && q.phoneTail, 4);
  if (!rid || !tail || !/^\d{4}$/.test(tail)) return { status: 'NOT_FOUND' };
  // 予約番号ごとに、外れの回数で止める（下4けたの総当たり対策。止めている間も、外れと同じ応答。D-028）
  // 数え上げは利用者のロックの中で行う。予約の登録のスクリプトのロックとは別なので、確認を大量に送られても登録は待たない（D-029・仮定 X-01）
  var r = limited_('lookup:' + rid, function () {
    return readAll_(SHEETS.RES).filter(function (x) {
      return String(x['予約番号']) === rid && String(x['電話番号']).replace(/\D/g, '').slice(-4) === tail && x['状態'] !== ST.REJECTED;
    })[0] || null;
  }, LockService.getUserLock());
  return r ? { status: 'OK', summary: summaryOf_(r) } : { status: 'NOT_FOUND' };
}

/**
 * 電話番号の書き方をそろえる（D-039）。どう入れても、台帳では同じ形になるように。
 * 全角は半角に、いろいろな線は「-」に、空白とかっこは除く。「+」で始まるもの（海外）は、空白を除くだけ。
 * 携帯など（0X0 で始まる11けた）は 3-4-4、03・06 の10けたは 2-4-4、0120 は 4-3-3、0800 は 4-3-4。
 * ほかの固定電話は、市外局番の長さが決まらないので、入れた人の区切りを使う（区切りが無ければ数字だけ）。
 */
function formatPhone_(s) {
  var t = String(s || '')
    .replace(/[０-９＋（）]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[‐-―−－ーｰ]/g, '-')
    .replace(/\s+/g, '');
  if (!t) return '';
  if (t.charAt(0) === '+') return t;
  t = t.replace(/[()]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  var d = t.replace(/-/g, '');
  if (/^0800\d{7}$/.test(d)) return d.slice(0, 4) + '-' + d.slice(4, 7) + '-' + d.slice(7);
  if (/^0[2-9]0\d{8}$/.test(d)) return d.slice(0, 3) + '-' + d.slice(3, 7) + '-' + d.slice(7);
  if (/^0[36]\d{8}$/.test(d)) return d.slice(0, 2) + '-' + d.slice(2, 6) + '-' + d.slice(6);
  if (/^0120\d{6}$/.test(d)) return d.slice(0, 4) + '-' + d.slice(4, 7) + '-' + d.slice(7);
  return t;
}
