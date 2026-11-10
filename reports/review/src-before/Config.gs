/**
 * 設定と定数。
 * 運用ルール（予約期間など）はコードに埋め込まず、スクリプトプロパティ RULES（JSON）から読む。
 */
var TZ = 'Asia/Tokyo';
var APP_VERSION = '0.2.0';

/** 駐車場（要件5章） */
var SPACES = ['91', '92', '93'];

/**
 * コマ。ID は固定（S1〜S4）。画面に出す名前は label（利用者に S1 などの記号は見せない）。
 * mark は電話口・予約表での呼び名（A〜D。管理組合の Excel と同じ）。画面には label に添えて出す（D-022）
 */
var SLOTS = {
  S1: { mark: 'A', label: '朝', start: '08:00', end: '11:00', endDayOffset: 0, price: 300 },
  S2: { mark: 'B', label: '昼', start: '11:00', end: '14:00', endDayOffset: 0, price: 300 },
  S3: { mark: 'C', label: '午後', start: '14:00', end: '17:00', endDayOffset: 0, price: 300 },
  S4: { mark: 'D', label: '夜', start: '17:00', end: '08:00', endDayOffset: 1, price: 600 },
};
var SLOT_IDS = ['S1', 'S2', 'S3', 'S4'];

/**
 * ルールの既定値（設定 RULES が無いときに使う）。
 * 上の6つは contract/provisional-rules.json と同じ。下の4つは 2026-11-07 に依頼者が決めた運用（D-014）。
 */
var DEFAULT_RULES = {
  allocationMethod: 'FIRST_COME_BY_LOCK_ORDER',
  bookingWindowDays: null,        // 住民が画面から申し込める日数の上限。null は「住民に見せる範囲と同じ」（D-020）
  cutoff: 'SLOT_START',
  multiCar: 'ALL_OR_NOTHING',
  maxQuantityPerRequest: 1,       // 1回の予約は1台（D-014）
  emailRequiredOnline: false,
  capacityPerSlot: 2,             // 1コマに入れる台数。区画（91〜93）は3つあるが、2台で運用する（D-014）
  residentBooking: false,         // 住民が画面から申し込めるか。当面は電話だけなので閉じる（D-014）
  viewMonths: 3,                  // 管理者が電話・窓口で受け付ける範囲（今日から何か月先まで）
  residentLeadDays: 5,            // 住民の画面に見せるのは、今日から何日後からか（当日・直前の分は見せず、申し込ませない。D-020）
  residentViewMonths: 2,          // 住民の画面に見せるのは、今日から何か月先までか（D-020）
  residentLookup: false,          // 住民が予約番号で自分の予約を確かめる入口。画面から外しているので閉じる。試験のときに開ける（D-022）
  archiveAfterDays: 60,           // 利用日がこの日数より前の予約は、保管のシートへ移す（D-023）
};

/** シート名と列（見出し）。管理者が見ても分かるよう日本語にする */
var SHEETS = {
  RES: '予約',
  ALC: '割当て',
  NTF: '通知',
  LOG: '操作履歴',
  BLK: '使用禁止',
  // 保管（D-023）。利用日が古い予約を移す先。列は元のシートと同じ
  RES_ARC: '予約（保管）',
  ALC_ARC: '割当て（保管）',
  NTF_ARC: '通知（保管）',
};
var COLS = {};
COLS[SHEETS.RES] = ['予約番号', '受付要求ID', '状態', '受付経路', '利用日', 'コマID', '時間帯', '台数', '料金合計', '開始日時', '終了日時',
  '氏名', '棟', '部屋番号', '電話番号', 'メール', '連絡方法', '受付日時', '確定日時', '更新日時', '登録者', '不成立理由', '電話等の受付日時', '備考'];
COLS[SHEETS.ALC] = ['予約番号', '利用日', 'コマID', '駐車場', '状態', '確保日時'];
COLS[SHEETS.NTF] = ['予約番号', '状態', '送信先', '試行回数', '最終結果', '更新日時', '電話対応者', '電話対応日時'];
COLS[SHEETS.LOG] = ['日時', '操作', '操作者', '予約番号', '理由', '内容'];
/** 使用禁止：期間（開始日〜終了日）×時間帯（空なら全て）×駐車場（空なら全て）を、予約に使わせない（D-016） */
COLS[SHEETS.BLK] = ['番号', '受付要求ID', '状態', '開始日', '終了日', '時間帯', '駐車場', '理由', 'メモ', '登録者', '登録日時', '解除者', '解除日時'];
COLS[SHEETS.RES_ARC] = COLS[SHEETS.RES];
COLS[SHEETS.ALC_ARC] = COLS[SHEETS.ALC];
COLS[SHEETS.NTF_ARC] = COLS[SHEETS.NTF];

/** 状態の値（台帳に書く文字） */
var ST = { PENDING: '受付中', CONFIRMED: '確定', REJECTED: '不成立', CANCELLED: '取消済み' };
var ALC_ST = { ACTIVE: '有効', RELEASED: '解放' };
var BLK_ST = { ACTIVE: '有効', RELEASED: '解除' };
var NTF_ST = { PENDING: '未送信', SENDING: '送信中', SENT: '送信済み', RETRY: '再送待ち', PHONE: '電話連絡', PHONE_DONE: '電話連絡済み', NONE: '不要' };
var CHANNELS = { ONLINE: 'ONLINE', PHONE: 'PHONE', COUNTER: 'COUNTER' };

function props_() { return PropertiesService.getScriptProperties(); }

function rules_() {
  var raw = props_().getProperty('RULES');
  var r = {};
  try { r = raw ? JSON.parse(raw) : {}; } catch (e) { r = {}; }
  var out = {};
  Object.keys(DEFAULT_RULES).forEach(function (k) { out[k] = r[k] !== undefined && r[k] !== null ? r[k] : DEFAULT_RULES[k]; });
  return out;
}

/** 1コマに入れる台数（区画の数を超えない） */
function capacity_() {
  var n = Math.floor(Number(rules_().capacityPerSlot));
  return n >= 1 ? Math.min(n, SPACES.length) : SPACES.length;
}

/** 1回に予約できる台数 */
function maxQuantity_() {
  return Math.max(1, Math.min(Number(rules_().maxQuantityPerRequest) || 1, capacity_()));
}

/** 住民が画面から申し込めるか（文字の "true" も受け付ける） */
function residentBookingOpen_() {
  var v = rules_().residentBooking;
  return v === true || v === 'true';
}

/** 住民が予約番号で自分の予約を確かめる入口を開けているか（文字の "true" も受け付ける） */
function residentLookupOpen_() {
  var v = rules_().residentLookup;
  return v === true || v === 'true';
}

/** 管理者が電話・窓口で受け付ける最後の日（今日から viewMonths か月先の同じ日。無い日は月末） */
function viewUntil_(today) {
  return monthsAhead_(today, Math.floor(Number(rules_().viewMonths)) || 3);
}

/** 住民の画面に見せる最初の日（今日から residentLeadDays 日後） */
function residentFrom_(today) {
  var n = Math.floor(Number(rules_().residentLeadDays));
  return addDaysYmd_(today, n > 0 ? n : 0);
}

/** 住民の画面に見せる最後の日（今日から residentViewMonths か月先の同じ日。管理者が受け付ける範囲は超えない） */
function residentUntil_(today) {
  var m = Math.floor(Number(rules_().residentViewMonths));
  var u = m > 0 ? monthsAhead_(today, m) : viewUntil_(today);
  var v = viewUntil_(today);
  return u < v ? u : v;
}

/** 今日から m か月先の同じ日（無い日は月末） */
function monthsAhead_(today, m) {
  var p = today.split('-').map(Number);
  var y = p[0], mo = p[1] + m;
  while (mo > 12) { mo -= 12; y++; }
  var last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  var d = Math.min(p[2], last);
  return y + '-' + ('0' + mo).slice(-2) + '-' + ('0' + d).slice(-2);
}

function spreadsheet_() {
  var id = props_().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('SPREADSHEET_ID が設定されていません');
  return SpreadsheetApp.openById(id);
}
