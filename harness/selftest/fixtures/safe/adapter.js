'use strict';
// 自己試験用フィクスチャの adapter（contract/adapter.js の記入例でもある）
const base = require('../../../../contract/adapter.js');
const call = async (host, fn, args, actor) => host.run(fn, args, { kind: 'client', user: actor ? actor.email : null });
const norm = (r) => {
  if (!r.ok) return { status: r.denied ? 'DENIED' : 'ERROR', raw: r.error };
  const v = r.value || {};
  const status = v.status === 'OK' ? 'OK' : v.status;
  return { status, reservationId: v.reservationId, reason: v.reason, raw: v };
};
const auth = (a) => ({ email: a && a.email, secret: a && a.secret });
module.exports = {
  NotImplemented: base.NotImplemented,
  async setup(host, { spreadsheetId, rules, admins }) {
    host.setScriptProperties({ SPREADSHEET_ID: spreadsheetId });
    const r = await host.run('setup_init', [rules, admins.map((a) => ({ email: a.email, name: a.name, secret: a.secret }))], { kind: 'editor' });
    if (!r.ok || r.value.status !== 'OK') throw new Error(`setup failed: ${JSON.stringify(r.error || r.value)}`);
  },
  async getAvailability(host, q, actor) { const r = norm(await call(host, 'api_getAvailability', [q], actor)); return { ...r, days: r.raw.days || [] }; },
  async submit(host, req, actor) { return norm(await call(host, 'api_submitReservation', [req], actor)); },
  async getRequestStatus(host, q, actor) { return norm(await call(host, 'api_getRequestStatus', [q], actor)); },
  async adminRegister(host, req, actor) { return norm(await call(host, 'api_admin_register', [auth(actor), req], actor)); },
  async adminList(host, q, actor) { const r = norm(await call(host, 'api_admin_list', [auth(actor), q], actor)); return { ...r, reservations: r.raw.reservations || [] }; },
  async adminCancel(host, q, actor) { return norm(await call(host, 'api_admin_cancel', [auth(actor), q], actor)); },
  async adminCallList(host, actor) { return norm(await call(host, 'api_admin_callList', [auth(actor)], actor)); },
  async processNotifications(host) { const r = await host.run('job_processNotifications', [], { kind: 'trigger' }); if (!r.ok) throw new Error(r.error.message); return r.value; },
  async userCancel() { throw new base.NotImplemented('userCancel'); },
};
