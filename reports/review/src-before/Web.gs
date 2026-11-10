/**
 * Webアプリの入口と、画面から呼ぶ関数（google.script.run）。
 * 名前が _ で終わらない関数は誰でも呼べるため、管理者用は必ず adminOf_() で確認する。
 * 権限区分は contract/contract.json の surface に宣言している。
 */
function doGet(e) {
  var page = e && e.parameter && e.parameter.page === 'admin' ? 'Admin' : 'Index';
  var t = HtmlService.createTemplateFromFile(page);
  t.version = APP_VERSION;
  t.today = todayYmd_();
  t.viewFrom = residentFrom_(t.today);
  t.contact = props_().getProperty('CONTACT_NOTE') || '自治会の駐車場係';
  // 住民の画面の形：縦の一覧（既定。会合で評判が良かった）か、カレンダー。画面の切替えで選べる（選んだ形は端末に覚える）。
  // ?layout=calendar / ?layout=list で開くと、その形で始まる
  var lay = e && e.parameter && e.parameter.layout;
  t.layout = lay === 'calendar' || lay === 'list' ? lay : '';
  return t.evaluate()
    .setTitle(page === 'Admin' ? '駐車場予約 管理者用' : '駐車場の空き状況')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/** HTML の部品を読み込む（テンプレートから使う） */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ---------------------------------------------------------------- 一般公開
function api_getAvailability(q) {
  return guard_(function () { return availability_(q && q.from, q && q.to, 'resident'); });
}
function api_submitReservation(req) {
  return guard_(function () { return book_(req, CHANNELS.ONLINE, ''); });
}
function api_getRequestStatus(q) {
  return guard_(function () { return requestStatus_(q && q.requestId); });
}
/** 予約の確認（予約番号＋電話番号の下4けた）。住民の画面からは外した（D-014）。設定 residentLookup で開けたときだけ答える（D-022） */
function api_lookupReservation(q) {
  return guard_(function () { return lookup_(q); });
}

// ---------------------------------------------------------------- 管理者
function api_admin_login(q) {
  return guard_(function () {
    var a = verifyAdmin_(q && q.email, q && q.secret);
    if (!a) {
      if (q && isLocked_(q.email)) return { status: 'DENIED', reason: 'LOCKED', reasonText: '間違いが続いたため、15分間は確認できません。時間をおいてから、もう一度お試しください' };
      return denied_();
    }
    var token = Utilities.getUuid() + Utilities.getUuid();
    CacheService.getScriptCache().put('adm:' + token, a.email, ADMIN_TOKEN_TTL_SEC);
    return { status: 'OK', token: token, name: a.name };
  });
}
/** 管理者の台帳用の空き状況（今日から。住民に見せない直前の日も含む） */
function api_admin_availability(auth, q) {
  return guard_(function () {
    var a = adminOf_(auth); if (!a) return denied_();
    return availability_(q && q.from, q && q.to, 'admin');
  });
}
function api_admin_register(auth, req) {
  return guard_(function () {
    var a = adminOf_(auth); if (!a) return denied_();
    var ch = req && req.channel === CHANNELS.COUNTER ? CHANNELS.COUNTER : CHANNELS.PHONE;
    var r = book_(req, ch, a.label);
    if (r.status === 'CONFIRMED' && r.summary) refreshMonthSheets_([r.summary.date]);
    return r;
  });
}
function api_admin_list(auth, q) {
  return guard_(function () { if (!adminOf_(auth)) return denied_(); return adminList_(q); });
}
function api_admin_cancel(auth, q) {
  return guard_(function () {
    var a = adminOf_(auth); if (!a) return denied_();
    var r = adminCancel_(a, q);
    if (r.status === 'CANCELLED' && !r.already && r.summary) refreshMonthSheets_([r.summary.date]);
    return r;
  });
}
/** 予約の変更（日・時間帯・区画・名前など）。新しい枠が取れてから古い枠を放す（D-024） */
function api_admin_change(auth, q) {
  return guard_(function () {
    var a = adminOf_(auth); if (!a) return denied_();
    var r = adminChange_(a, q);
    if (r.status === 'CHANGED' && !r.already && r.reservation) refreshMonthSheets_([r.fromDate, r.reservation.date]);
    return r;
  });
}
function api_admin_callList(auth) {
  return guard_(function () { if (!adminOf_(auth)) return denied_(); return adminCallList_(); });
}
function api_admin_markCalled(auth, q) {
  return guard_(function () { var a = adminOf_(auth); if (!a) return denied_(); return adminMarkCalled_(a, q); });
}
/** 使用禁止の登録（confirm が無ければ、重なる予約を返すだけ）・解除・一覧（D-016） */
function api_admin_addBlock(auth, q) {
  return guard_(function () {
    var a = adminOf_(auth); if (!a) return denied_();
    var r = adminAddBlock_(a, q);
    if (r.status === 'OK' && !r.already && r.block) refreshMonthSheets_(monthsBetween_(r.block.from, r.block.to));
    return r;
  });
}
function api_admin_releaseBlock(auth, q) {
  return guard_(function () {
    var a = adminOf_(auth); if (!a) return denied_();
    var r = adminReleaseBlock_(a, q);
    if (r.status === 'OK' && r.from) refreshMonthSheets_(monthsBetween_(r.from, r.to));
    return r;
  });
}
function api_admin_blockList(auth, q) {
  return guard_(function () { if (!adminOf_(auth)) return denied_(); return adminBlockList_(q); });
}
/** 予約表（管理者の Excel と同じ形の月の表）。画面に出す・スプレッドシートに書き出す（D-017） */
function api_admin_monthTable(auth, q) {
  return guard_(function () { if (!adminOf_(auth)) return denied_(); return adminMonthTable_(q); });
}
function api_admin_exportMonth(auth, q) {
  return guard_(function () { var a = adminOf_(auth); if (!a) return denied_(); return adminExportMonth_(a, q); });
}
