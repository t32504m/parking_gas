/**
 * ハーネス自己試験用の最小実装（製品コードではない）。
 * 目的は「受入試験が合格可能であること」と「危険な改変を試験が検出できること」の確認だけ。
 * 画面・認証方式・設計は製品の参考にしないこと。特に管理者認証は仮の置き物。
 */
var SLOTS = {
  S1: { start: '08:00', end: '11:00', endDayOffset: 0, price: 300 },
  S2: { start: '11:00', end: '14:00', endDayOffset: 0, price: 300 },
  S3: { start: '14:00', end: '17:00', endDayOffset: 0, price: 300 },
  S4: { start: '17:00', end: '08:00', endDayOffset: 1, price: 600 },
};
var SPACES = ['91', '92', '93'];
var TZ = 'Asia/Tokyo';
var H = {
  Reservations: ['reservation_id', 'request_id', 'state', 'channel', 'date', 'slot_id', 'quantity', 'price_total', 'start_at', 'end_at', 'created_at', 'operator', 'name', 'building', 'room', 'email', 'phone', 'reason'],
  Allocations: ['reservation_id', 'date', 'slot_id', 'space_id', 'state'],
  AuditLog: ['at', 'action', 'operator', 'reservation_id', 'reason'],
  Notifications: ['reservation_id', 'state', 'attempts', 'to', 'last_error'],
};

function doGet(e) {
  var t = HtmlService.createTemplateFromFile('Index');
  t.mode = (e && e.parameter && e.parameter.mode) || 'user';
  return t.evaluate().setTitle('駐車場予約（自己試験用）').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------------------------------------------------------- 設定
function cfg_() {
  var p = PropertiesService.getScriptProperties();
  return { ssId: p.getProperty('SPREADSHEET_ID'), rules: JSON.parse(p.getProperty('RULES') || '{}'), admins: JSON.parse(p.getProperty('ADMINS') || '{}') };
}
function sheet_(name) { return SpreadsheetApp.openById(cfg_().ssId).getSheetByName(name); }
function hash_(s) { return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s))); }

function setup_init(rules, admins) {
  var me = Session.getActiveUser().getEmail();
  if (!me || me !== Session.getEffectiveUser().getEmail()) return { status: 'DENIED' };
  var p = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.openById(p.getProperty('SPREADSHEET_ID'));
  Object.keys(H).forEach(function (name) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    sh.getRange(1, 1, 1, H[name].length).setValues([H[name]]);
  });
  var map = {};
  (admins || []).forEach(function (a) { map[a.email] = { name: a.name, hash: hash_(a.secret) }; });
  p.setProperty('RULES', JSON.stringify(rules || {}));
  p.setProperty('ADMINS', JSON.stringify(map));
  return { status: 'OK' };
}

// ---------------------------------------------------------------- 共通部品
function rows_(name) {
  var sh = sheet_(name);
  var n = sh.getLastRow();
  if (n < 2) return [];
  var v = sh.getRange(2, 1, n - 1, H[name].length).getValues();
  return v.map(function (r, i) { var o = { _row: i + 2 }; H[name].forEach(function (h, j) { o[h] = r[j]; }); return o; });
}
function append_(name, obj) {
  sheet_(name).appendRow(H[name].map(function (h) { var v = obj[h]; return v === undefined || v === null ? '' : (typeof v === 'number' ? v : "'" + String(v)); }));
}
function setCell_(name, row, col, value) { sheet_(name).getRange(row, H[name].indexOf(col) + 1).setValue(value); }
function now_() { return new Date(); }
function iso_(d) { return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function ymd_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function slotTimes_(date, slotId) {
  var s = SLOTS[slotId];
  var start = new Date(date + 'T' + s.start + ':00+09:00');
  var endBase = new Date(date + 'T00:00:00+09:00');
  var end = new Date(endBase.getTime() + s.endDayOffset * 86400000 + (Number(s.end.slice(0, 2)) * 60 + Number(s.end.slice(3))) * 60000);
  return { start: start, end: end };
}
function validDate_(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d))) return false;
  var x = new Date(d + 'T00:00:00+09:00');
  return !isNaN(x.getTime()) && ymd_(x) === d;
}
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return { status: 'ERROR', reason: 'BUSY' };
  try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}
function activeSpaces_(date, slotId) {
  return rows_('Allocations').filter(function (a) { return a.state === 'ACTIVE' && String(a.date) === date && a.slot_id === slotId; }).map(function (a) { return String(a.space_id); });
}
function admin_(auth) {
  if (!auth || !auth.email || !auth.secret) return null;
  var a = cfg_().admins[auth.email];
  if (!a || a.hash !== hash_(auth.secret)) return null;
  return { label: a.name + ' <' + auth.email + '>' };
}

// ---------------------------------------------------------------- 予約の中核（オンライン・代行で共通）
function book_(req, channel, operator) {
  if (!req || typeof req !== 'object') return { status: 'REJECTED', reason: 'BAD_INPUT' };
  var q = req.quantity;
  if (typeof q !== 'number' || q % 1 !== 0 || q < 1 || q > 3) return { status: 'REJECTED', reason: 'BAD_QUANTITY' };
  if (!SLOTS[req.slotId]) return { status: 'REJECTED', reason: 'BAD_SLOT' };
  if (!validDate_(req.date)) return { status: 'REJECTED', reason: 'BAD_DATE' };
  if (!req.name || !req.room || !req.requestId) return { status: 'REJECTED', reason: 'MISSING' };
  return withLock_(function () {
    var existing = rows_('Reservations').filter(function (r) { return r.request_id === String(req.requestId); })[0];
    if (existing && existing.state !== 'PENDING') return { status: existing.state, reservationId: existing.reservation_id };
    var rules = cfg_().rules;
    var t = slotTimes_(req.date, req.slotId);
    var now = now_();
    var today = new Date(ymd_(now) + 'T00:00:00+09:00');
    var reason = null;
    if (now.getTime() >= t.start.getTime()) reason = 'CUTOFF';
    else if ((new Date(req.date + 'T00:00:00+09:00') - today) / 86400000 > (rules.bookingWindowDays || 30)) reason = 'WINDOW';
    var id = existing ? existing.reservation_id : 'R' + Utilities.getUuid().slice(0, 8).toUpperCase();
    if (existing) { // 前回が途中で止まった：残った割当てを解放してやり直す
      rows_('Allocations').forEach(function (a) { if (a.reservation_id === id && a.state === 'ACTIVE') setCell_('Allocations', a._row, 'state', 'RELEASED'); });
    }
    var free = SPACES.filter(function (s) { return activeSpaces_(req.date, req.slotId).indexOf(s) < 0; });
    if (!reason && free.length < q) reason = 'FULL';
    var base = {
      reservation_id: id, request_id: req.requestId, channel: channel, date: req.date, slot_id: req.slotId, quantity: q,
      price_total: SLOTS[req.slotId].price * q, start_at: iso_(t.start), end_at: iso_(t.end), created_at: iso_(now), operator: operator || '',
      name: req.name, building: req.building, room: req.room, email: req.email || '', phone: req.phone || '',
    };
    if (reason) {
      base.state = 'REJECTED'; base.reason = reason;
      if (existing) setCell_('Reservations', existing._row, 'state', 'REJECTED'); else append_('Reservations', base);
      return { status: 'REJECTED', reason: reason, reservationId: null };
    }
    if (!existing) { base.state = 'PENDING'; append_('Reservations', base); existing = rows_('Reservations').filter(function (r) { return r.reservation_id === id; })[0]; }
    for (var i = 0; i < q; i++) append_('Allocations', { reservation_id: id, date: req.date, slot_id: req.slotId, space_id: free[i], state: 'ACTIVE' });
    setCell_('Reservations', existing._row, 'state', 'CONFIRMED');
    append_('Notifications', { reservation_id: id, state: req.email ? 'PENDING' : (channel === 'PHONE' ? 'PHONE' : 'NOT_REQUIRED'), attempts: 0, to: req.email || '' });
    if (operator) append_('AuditLog', { at: iso_(now), action: 'register', operator: operator, reservation_id: id, reason: channel });
    return { status: 'CONFIRMED', reservationId: id };
  });
}
function safe_(fn) {
  try { return fn(); } catch (e) { console.error(e); return { status: 'ERROR', reason: String(e && e.message) }; }
}

// ---------------------------------------------------------------- 公開API
function api_getAvailability(q) {
  return safe_(function () {
    var from = new Date(q.from + 'T00:00:00+09:00'); var to = new Date(q.to + 'T00:00:00+09:00');
    var all = rows_('Allocations').filter(function (a) { return a.state === 'ACTIVE'; });
    var days = [];
    for (var d = from; d <= to; d = new Date(d.getTime() + 86400000)) {
      var date = ymd_(d);
      days.push({ date: date, slots: Object.keys(SLOTS).map(function (id) {
        var t = slotTimes_(date, id);
        var used = all.filter(function (a) { return String(a.date) === date && a.slot_id === id; }).length;
        return { slotId: id, start: iso_(t.start), end: iso_(t.end), price: SLOTS[id].price, available: used < SPACES.length };
      }) });
    }
    return { status: 'OK', days: days };
  });
}
function api_submitReservation(req) { return safe_(function () { return book_(req, 'ONLINE', ''); }); }
function api_getRequestStatus(q) {
  return safe_(function () {
    var r = rows_('Reservations').filter(function (x) { return x.request_id === String(q && q.requestId); })[0];
    return r ? { status: r.state, reservationId: r.reservation_id } : { status: 'UNKNOWN' };
  });
}
function api_admin_register(auth, req) {
  return safe_(function () {
    var a = admin_(auth); if (!a) return { status: 'DENIED' };
    return book_(req, req && req.channel === 'COUNTER' ? 'COUNTER' : 'PHONE', a.label);
  });
}
function api_admin_list(auth, q) {
  return safe_(function () {
    if (!admin_(auth)) return { status: 'DENIED' };
    var alc = rows_('Allocations');
    var list = rows_('Reservations').filter(function (r) {
      return (!q.date || String(r.date) === q.date) && (!q.reservationId || r.reservation_id === q.reservationId);
    }).map(function (r) {
      return { reservationId: r.reservation_id, date: String(r.date), slotId: r.slot_id, quantity: Number(r.quantity), state: r.state, channel: r.channel,
        name: r.name, building: r.building, room: String(r.room), phone: String(r.phone),
        spaces: alc.filter(function (a) { return a.reservation_id === r.reservation_id && a.state === 'ACTIVE'; }).map(function (a) { return String(a.space_id); }) };
    });
    return { status: 'OK', reservations: list };
  });
}
function api_admin_cancel(auth, q) {
  return safe_(function () {
    var a = admin_(auth); if (!a) return { status: 'DENIED' };
    return withLock_(function () {
      var r = rows_('Reservations').filter(function (x) { return x.reservation_id === q.reservationId; })[0];
      if (!r) return { status: 'REJECTED', reason: 'NOT_FOUND' };
      if (r.state === 'CANCELLED') return { status: 'CANCELLED' };
      rows_('Allocations').forEach(function (x) { if (x.reservation_id === r.reservation_id && x.state === 'ACTIVE') setCell_('Allocations', x._row, 'state', 'RELEASED'); });
      setCell_('Reservations', r._row, 'state', 'CANCELLED');
      append_('AuditLog', { at: iso_(now_()), action: 'cancel', operator: a.label, reservation_id: r.reservation_id, reason: q.reason || '' });
      return { status: 'CANCELLED' };
    });
  });
}
function api_admin_callList(auth) {
  return safe_(function () {
    if (!admin_(auth)) return { status: 'DENIED' };
    return { status: 'OK', items: rows_('Notifications').filter(function (n) { return n.state === 'PHONE'; }).map(function (n) { return n.reservation_id; }) };
  });
}
function job_processNotifications() {
  var me = Session.getActiveUser().getEmail();
  if (!me || me !== Session.getEffectiveUser().getEmail()) return { status: 'DENIED' };
  return withLock_(function () {
    var res = rows_('Reservations');
    rows_('Notifications').forEach(function (n) {
      if (n.state !== 'PENDING' && n.state !== 'RETRY') return;
      var r = res.filter(function (x) { return x.reservation_id === n.reservation_id; })[0];
      // 案内は利用日の前日に送る（2026-11-10 依頼者の決定）
      if (!r || String(r.date) !== ymd_(new Date(now_().getTime() + 86400000))) return;
      try {
        MailApp.sendEmail(String(n.to), '駐車場予約の確定', '予約番号 ' + n.reservation_id + '（' + r.date + ' ' + r.slot_id + '）');
        setCell_('Notifications', n._row, 'state', 'SENT');
      } catch (e) {
        setCell_('Notifications', n._row, 'state', 'RETRY');
        setCell_('Notifications', n._row, 'last_error', String(e.message));
      }
      setCell_('Notifications', n._row, 'attempts', Number(n.attempts || 0) + 1);
    });
    return { status: 'OK' };
  });
}
