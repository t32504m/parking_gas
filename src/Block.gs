/**
 * 使用禁止（D-016）。
 * 「何日から何日まで、どの時間帯の、どの駐車場を使わせない」を1行で登録する。
 * 管理者が自分で使うとき（区画の3つ目を使うなど）も、ここに「管理者が使う」として登録する。
 * ・空き状況・確定処理・区画の割当ての全てで、禁止された区画を使わない。
 * ・すでに予約がある枠を禁止にしても、予約は自動では取り消さない。重なる予約を一覧で返し、管理者が判断する。
 */
var BLOCK_REASONS = ['管理者が使う', '工事・点検', '行事', 'その他'];
var ALL_SLOTS_TEXT = '終日';
var ALL_SPACES_TEXT = '全て';

/** 使用禁止の全行。初期設定を実行し直す前（シートが無い）なら空 */
function blocksAll_() {
  return sheetOrNull_(SHEETS.BLK) ? readAll_(SHEETS.BLK) : [];
}

/**
 * 期間 [from, to] に重なる有効な使用禁止。時間帯・駐車場の文字は、ここで1回だけ分解する
 * （日×コマごとに全ての行を分解し直さないため。使用禁止の行は保管しないので、年々増える）
 */
function activeBlocks_(from, to) {
  return blocksAll_().filter(function (b) {
    return b['状態'] === BLK_ST.ACTIVE && String(b['終了日']) >= from && String(b['開始日']) <= to;
  }).map(function (b) { return { id: String(b['番号']), from: String(b['開始日']), to: String(b['終了日']), scope: blockScope_(b), row: b }; });
}

function splitList_(s) { return String(s || '').split(/[・,、\s]+/).map(function (x) { return x.trim(); }).filter(String); }

/** 台帳の行 → { slots: ['S1',…], spaces: ['91',…] }（空の配列は「全て」） */
function blockScope_(b) {
  var t = String(b['時間帯']);
  var slots = t === ALL_SLOTS_TEXT || !t ? [] : splitList_(t).map(function (l) {
    for (var i = 0; i < SLOT_IDS.length; i++) if (SLOTS[SLOT_IDS[i]].label === l || SLOT_IDS[i] === l) return SLOT_IDS[i];
    return null;
  }).filter(Boolean);
  var p = String(b['駐車場']);
  var spaces = p === ALL_SPACES_TEXT || !p ? [] : splitList_(p).filter(function (x) { return SPACES.indexOf(x) >= 0; });
  return { slots: slots, spaces: spaces };
}

/** その枠で禁止されている駐車場 → 使用禁止の番号。blocks は activeBlocks_ の結果 */
function blockedSpaces_(blocks, date, slotId) {
  var out = {};
  blocks.forEach(function (b) {
    if (date < b.from || date > b.to || (b.scope.slots.length && b.scope.slots.indexOf(slotId) < 0)) return;
    (b.scope.spaces.length ? b.scope.spaces : SPACES).forEach(function (s) { if (!out[s]) out[s] = b.id; });
  });
  return out;
}

function blockOf_(b) {
  var sc = blockScope_(b);
  return {
    blockId: String(b['番号']), state: String(b['状態']), from: String(b['開始日']), to: String(b['終了日']),
    slots: sc.slots, spaces: sc.spaces, slotsText: String(b['時間帯']), spacesText: String(b['駐車場']),
    reason: String(b['理由']), memo: String(b['メモ'] || ''), operator: String(b['登録者']), createdAt: String(b['登録日時']),
  };
}

/** 登録の内容を検査して正規化する */
function normalizeBlock_(q) {
  if (!q || typeof q !== 'object') return { error: '内容' };
  var r = {};
  r.requestId = requestIdOf_(q.requestId);
  if (!r.requestId) return { error: '受付要求' };
  if (!isValidYmd_(q.from)) return { error: '開始日' };
  if (!isValidYmd_(q.to) || q.to < q.from) return { error: '終了日' };
  if (q.to < todayYmd_()) return { error: '終了日' };
  if (daysBetween_(q.from, q.to) > 366) return { error: '期間（1年まで）' };
  r.from = q.from; r.to = q.to;
  // 空の選び（[]）は「全て」ではなく誤り。「全て」は、選ばないか、全てを並べて送る（D-025）
  if (Array.isArray(q.slots) && !q.slots.length) return { error: '時間帯' };
  if (Array.isArray(q.spaces) && !q.spaces.length) return { error: '駐車場' };
  var slots = Array.isArray(q.slots) ? q.slots : [];
  if (slots.some(function (x) { return SLOT_IDS.indexOf(x) < 0; })) return { error: '時間帯' };
  r.slots = SLOT_IDS.filter(function (x) { return slots.indexOf(x) >= 0; });
  if (r.slots.length === SLOT_IDS.length) r.slots = [];
  var spaces = Array.isArray(q.spaces) ? q.spaces.map(String) : [];
  if (spaces.some(function (x) { return SPACES.indexOf(x) < 0; })) return { error: '駐車場' };
  r.spaces = SPACES.filter(function (x) { return spaces.indexOf(x) >= 0; });
  if (r.spaces.length === SPACES.length) r.spaces = [];
  r.reason = cleanText_(q.reason, 30);
  if (!r.reason) return { error: '理由' };
  r.memo = cleanText_(q.memo, 200);
  if (r.memo === null) return { error: 'メモ' };
  return { value: r };
}

/** 登録しようとしている範囲に、すでにある確定の予約 */
function blockConflicts_(r) {
  var allocs = readAll_(SHEETS.ALC);
  var rows = readAll_(SHEETS.RES);
  var hits = {};
  allocs.forEach(function (a) {
    if (a['状態'] !== ALC_ST.ACTIVE) return;
    var d = String(a['利用日']), sl = String(a['コマID']), sp = String(a['駐車場']);
    if (d < r.from || d > r.to) return;
    if (r.slots.length && r.slots.indexOf(sl) < 0) return;
    if (r.spaces.length && r.spaces.indexOf(sp) < 0) return;
    (hits[String(a['予約番号'])] = hits[String(a['予約番号'])] || []).push(sp);
  });
  return rows.filter(function (x) { return hits[String(x['予約番号'])] && x['状態'] === ST.CONFIRMED; }).map(function (x) {
    var s = summaryOf_(x);
    return { reservationId: s.reservationId, date: s.date, slotId: s.slotId, slotLabel: s.slotLabel, name: String(x['氏名']), phone: String(x['電話番号']), spaces: hits[s.reservationId].sort() };
  }).sort(function (a, b) { return (a.date + a.slotId).localeCompare(b.date + b.slotId); });
}

/** 使用禁止の登録。confirm が無ければ、重なる予約を返すだけで何も書かない */
function adminAddBlock_(admin, q) {
  var n = normalizeBlock_(q);
  if (n.error) return { status: 'REJECTED', reason: 'INVALID', field: n.error, reasonText: n.error + 'を確認してください' };
  var r = n.value;
  var cells = (daysBetween_(r.from, r.to) + 1) * (r.slots.length || SLOT_IDS.length) * (r.spaces.length || SPACES.length);
  if (!q.confirm) return { status: 'PREVIEW', cells: cells, conflicts: blockConflicts_(r) };
  return withLock_(function () {
    if (!sheetOrNull_(SHEETS.BLK)) return { status: 'ERROR', reason: 'NO_SHEET', reasonText: '使用禁止のシートがありません。初期設定（setup_run）を実行し直してください' };
    var rows = readAll_(SHEETS.BLK);
    var same = rows.filter(function (x) { return String(x['受付要求ID']) === r.requestId; })[0];
    if (same) return { status: 'OK', blockId: String(same['番号']), already: true, block: blockOf_(same) };
    var max = 0;
    rows.forEach(function (x) { max = Math.max(max, Number(x['番号']) || 0); });
    var row = {
      '番号': String(max + 1), '受付要求ID': r.requestId, '状態': BLK_ST.ACTIVE, '開始日': r.from, '終了日': r.to,
      '時間帯': r.slots.length ? r.slots.map(function (x) { return SLOTS[x].label; }).join('・') : ALL_SLOTS_TEXT,
      '駐車場': r.spaces.length ? r.spaces.join('・') : ALL_SPACES_TEXT,
      '理由': r.reason, 'メモ': r.memo, '登録者': admin.label, '登録日時': iso_(new Date()),
    };
    appendRow_(SHEETS.BLK, row);
    audit_('使用禁止', admin.label, '', r.reason, row['開始日'] + '〜' + row['終了日'] + ' ' + row['時間帯'] + ' ' + row['駐車場'] + '（番号 ' + row['番号'] + '）');
    refreshMonthSheets_(monthsBetween_(r.from, r.to));
    return { status: 'OK', blockId: row['番号'], cells: cells, conflicts: blockConflicts_(r), block: blockOf_(row) };
  });
}

function adminReleaseBlock_(admin, q) {
  var id = cleanText_(q && q.blockId, 20);
  if (!id) return { status: 'REJECTED', reason: 'INVALID' };
  return withLock_(function () {
    var b = blocksAll_().filter(function (x) { return String(x['番号']) === id; })[0];
    if (!b) return { status: 'REJECTED', reason: 'NOT_FOUND', reasonText: 'その使用禁止は見つかりません' };
    if (b['状態'] === BLK_ST.RELEASED) return { status: 'OK', already: true };
    var now = iso_(new Date());
    updateRow_(SHEETS.BLK, b, { '状態': BLK_ST.RELEASED, '解除者': admin.label, '解除日時': now });
    audit_('使用禁止の解除', admin.label, '', '', String(b['開始日']) + '〜' + String(b['終了日']) + ' ' + String(b['時間帯']) + ' ' + String(b['駐車場']) + '（番号 ' + id + '）');
    refreshMonthSheets_(monthsBetween_(String(b['開始日']), String(b['終了日'])));
    return { status: 'OK', from: String(b['開始日']), to: String(b['終了日']) };
  });
}

/** 有効な使用禁止の一覧（終わっていないもの。from・to を渡すと、その期間に重なるものだけ） */
function adminBlockList_(q) {
  q = q || {};
  var from = isValidYmd_(q.from) ? q.from : todayYmd_();
  var to = isValidYmd_(q.to) ? q.to : null;
  var list = blocksAll_().filter(function (b) {
    return b['状態'] === BLK_ST.ACTIVE && String(b['終了日']) >= from && (!to || String(b['開始日']) <= to);
  }).map(blockOf_);
  list.sort(function (a, b) { return a.from.localeCompare(b.from) || Number(a.blockId) - Number(b.blockId); });
  return { status: 'OK', blocks: list };
}
