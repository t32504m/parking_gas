/**
 * Webアプリの入口と、画面から呼ぶ関数（google.script.run）。
 * 名前が _ で終わらない関数は誰でも呼べるため、管理者用は必ず adminOf_() で確認する。
 * 権限区分は contract/contract.json の surface に宣言している。
 */
function doGet(e) {
  var page = e && e.parameter && e.parameter.page === 'admin' ? 'Admin' : 'Index';
  var t = HtmlService.createTemplateFromFile(page);
  var c = residentConfig_();
  Object.keys(c).forEach(function (k) { t[k] = c[k]; });
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
/** 住民の画面の設定（GAS の画面と、外に置いた住民の画面の両方が使う） */
function residentConfig_() {
  var today = todayYmd_();
  return {
    version: APP_VERSION,
    today: today,
    viewFrom: residentFrom_(today),
    contact: prop_('CONTACT_NOTE') || '理事会事務局',
    // 電話の受付時間と利用約款は、スクリプト プロパティで変えられる（公開し直さずに済むように）
    hours: prop_('RECEPTION_HOURS') || '受付時間　AM 10:00〜12:00　PM 14:00〜19:00',
    terms: prop_('TERMS') || '',
  };
}

/**
 * 外に置いた住民の画面（Cloudflare Pages など）からの呼び出し（D-034）。
 * ブラウザは Google のログイン情報を送らずに呼ぶので、複数の Google アカウントにログインしている端末でも開ける。
 * 呼べるのは、google.script.run から誰でも呼べる住民向けの関数と、画面の設定だけ（権限は google.script.run と同じ）。
 * 送る形：POST の本文に {"fn": "関数の名前", "arg": 引数}（Content-Type は text/plain）。
 */
function doPost(e) {
  var body = null;
  try { body = JSON.parse(e && e.postData && e.postData.contents || 'null'); } catch (x) { body = null; }
  return ContentService.createTextOutput(JSON.stringify(residentApi_(body))).setMimeType(ContentService.MimeType.JSON);
}
function residentApi_(body) {
  var fn = body && typeof body.fn === 'string' ? body.fn : '';
  var arg = body ? body.arg : null;
  if (fn === 'config') return guard_(function () { var c = residentConfig_(); c.status = 'OK'; return c; });
  if (fn === 'api_getAvailability') return api_getAvailability(arg);
  if (fn === 'api_submitReservation') return api_submitReservation(arg);
  if (fn === 'api_getRequestStatus') return api_getRequestStatus(arg);
  if (fn === 'api_lookupReservation') return api_lookupReservation(arg);
  return { status: 'DENIED' };
}

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
      if (q && tooManyFails_(normEmail_(q.email))) return { status: 'DENIED', reason: 'LOCKED', reasonText: '間違いが続いたため、15分間は確認できません。時間をおいてから、もう一度お試しください' };
      return denied_();
    }
    var token = Utilities.getUuid() + Utilities.getUuid();
    CacheService.getScriptCache().put('adm:' + token, a.email + '|' + a.ver, ADMIN_TOKEN_TTL_SEC);
    return { status: 'OK', token: token, name: a.name };
  });
}
/** 管理者用の公開関数の入口：サーバー側で管理者を確かめてから fn(管理者) を呼ぶ */
function asAdmin_(auth, fn) {
  return guard_(function () {
    var a = adminOf_(auth);
    return a ? fn(a) : denied_();
  });
}

/** 管理者の台帳用の空き状況（今日から。住民に見せない直前の日も含む） */
function api_admin_availability(auth, q) { return asAdmin_(auth, function () { return availability_(q && q.from, q && q.to, 'admin'); }); }
/**
 * 管理者の週の表に要るもの（空き状況・予約一覧・使用禁止）を、1回で返す。
 * 3つを別々に呼ぶと、管理者の確認・スプレッドシートを開く・割当てと使用禁止を読む、を3回ずつ繰り返すため
 */
function api_admin_week(auth, q) {
  return asAdmin_(auth, function () {
    var from = q && q.from, to = q && q.to;
    var av = availability_(from, to, 'admin');
    if (av.status !== 'OK') return av;
    return { status: 'OK', availability: av, reservations: adminList_({ from: from, to: to }).reservations, blocks: adminBlockList_({ from: from, to: to }).blocks };
  });
}
/** 電話・窓口の登録。予約表の作り直しは、登録と同じロックの中で行う（book_） */
function api_admin_register(auth, req) {
  return asAdmin_(auth, function (a) {
    var ch = req && req.channel === CHANNELS.COUNTER ? CHANNELS.COUNTER : CHANNELS.PHONE;
    return book_(req, ch, a.label);
  });
}
function api_admin_list(auth, q) { return asAdmin_(auth, function () { return adminList_(q); }); }
function api_admin_cancel(auth, q) { return asAdmin_(auth, function (a) { return adminCancel_(a, q); }); }
/** 予約の変更（日・時間帯・区画・名前など）。新しい枠が取れてから古い枠を放す（D-024） */
function api_admin_change(auth, q) { return asAdmin_(auth, function (a) { return adminChange_(a, q); }); }
function api_admin_callList(auth) { return asAdmin_(auth, function () { return adminCallList_(); }); }
function api_admin_markCalled(auth, q) { return asAdmin_(auth, function (a) { return adminMarkCalled_(a, q); }); }
/** 使用禁止の登録（confirm が無ければ、重なる予約を返すだけ）・解除・一覧（D-016） */
function api_admin_addBlock(auth, q) { return asAdmin_(auth, function (a) { return adminAddBlock_(a, q); }); }
function api_admin_releaseBlock(auth, q) { return asAdmin_(auth, function (a) { return adminReleaseBlock_(a, q); }); }
function api_admin_blockList(auth, q) { return asAdmin_(auth, function () { return adminBlockList_(q); }); }
/** 予約表（管理者の Excel と同じ形の月の表）。画面に出す・スプレッドシートに書き出す（D-017） */
function api_admin_monthTable(auth, q) { return asAdmin_(auth, function () { return adminMonthTable_(q); }); }
function api_admin_exportMonth(auth, q) { return asAdmin_(auth, function (a) { return adminExportMonth_(a, q); }); }
