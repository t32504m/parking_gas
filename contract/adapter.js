'use strict';
/**
 * ハーネス ⇔ 実装 の対応づけ。
 * 呼出しは全て host.run(..., { kind: 'client', user }) ＝ google.script.run と同じ経路。
 * setup と processNotifications だけは、運用担当者のエディタ実行・時間主導トリガーに相当する経路を使う。
 * actor が持たない資格情報を補ったり、結果を書き換えたりしない。
 */
class NotImplemented extends Error {
  constructor(what) { super(`adapter未実装: ${what}`); this.name = 'NotImplemented'; }
}

/**
 * 受入試験（保護）が置いている前提に、試験のときだけ設定を合わせる（docs/DECISIONS.md D-015）。
 * 受入試験は「1コマ3台」「住民が画面から申し込める」を前提に書かれている。
 * 本番の既定（src/Config.gs の DEFAULT_RULES）は「1コマ2台」「住民の受付は閉じる」で、
 * その動きは tests/impl/operation.test.js で確かめる。判定や結果は書き換えない。
 */
const HARNESS_PREMISE = { capacityPerSlot: 3, residentBooking: true, residentLeadDays: 0, residentViewMonths: 3 };

const call = (host, fn, args, actor) => host.run(fn, args, { kind: 'client', user: actor ? actor.email : null });
const auth = (actor) => ({ email: actor && actor.email, secret: actor && actor.secret });

/** サーバーの応答を正規化。例外や通信失敗は ERROR、権限なしは DENIED */
function norm(r) {
  if (!r.ok) return { status: r.denied ? 'DENIED' : 'ERROR', raw: r.error };
  const v = r.value || {};
  return { status: v.status || 'ERROR', reservationId: v.reservationId, reason: v.reason, raw: v };
}

module.exports = {
  NotImplemented,

  async setup(host, { spreadsheetId, rules, admins }) {
    // 相談先（本番では運用担当者がスクリプトプロパティ CONTACT_NOTE に実際の連絡先を入れる。ここは試験用の架空の番号）
    host.setScriptProperties({ SPREADSHEET_ID: spreadsheetId, CONTACT_NOTE: '理事会事務局（電話 03-0000-0000）' });
    const r = await host.run('setup_init', [{ ...HARNESS_PREMISE, ...rules }, admins.map((a) => ({ email: a.email, name: a.name, secret: a.secret }))], { kind: 'editor' });
    if (!r.ok || !r.value || r.value.status !== 'OK') throw new Error(`setup に失敗: ${JSON.stringify(r.error || r.value)}`);
  },

  async getAvailability(host, q, actor) {
    const r = norm(await call(host, 'api_getAvailability', [q], actor));
    return { ...r, days: (r.raw && r.raw.days) || [] };
  },

  async submit(host, req, actor) { return norm(await call(host, 'api_submitReservation', [req], actor)); },

  async getRequestStatus(host, q, actor) { return norm(await call(host, 'api_getRequestStatus', [q], actor)); },

  async adminRegister(host, req, actor) { return norm(await call(host, 'api_admin_register', [auth(actor), req], actor)); },

  async adminList(host, q, actor) {
    const r = norm(await call(host, 'api_admin_list', [auth(actor), q], actor));
    const reservations = ((r.raw && r.raw.reservations) || []).map((x) => ({
      ...x, state: { 確定: 'CONFIRMED', 取消済み: 'CANCELLED', 不成立: 'REJECTED', 受付中: 'PENDING' }[x.state] || x.state,
    }));
    return { ...r, reservations };
  },

  async adminCancel(host, q, actor) { return norm(await call(host, 'api_admin_cancel', [auth(actor), q], actor)); },

  async processNotifications(host) {
    const r = await host.run('job_processNotifications', [], { kind: 'trigger' });
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  },

  async adminCallList(host, actor) { return norm(await call(host, 'api_admin_callList', [auth(actor)], actor)); },

  async userCancel() { throw new NotImplemented('userCancel（本人確認方式が未決定）'); },
};
