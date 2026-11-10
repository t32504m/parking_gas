'use strict';
// 画面を動かすための一式（GAS ホスト＋Webアプリ模擬サーバー＋初期データ）。
// UI試験・UI監査・ペルソナ評価・手動確認(npm run serve)で共通に使う。
const fs = require('fs');
const path = require('path');
const { GasHost } = require('../emulator/host');
const { startWebApp } = require('./server');

const ROOT = path.join(__dirname, '..', '..');

function paths() {
  return {
    projectDir: process.env.HARNESS_PROJECT_DIR ? path.resolve(process.env.HARNESS_PROJECT_DIR) : path.join(ROOT, 'src'),
    adapterPath: process.env.HARNESS_ADAPTER ? path.resolve(process.env.HARNESS_ADAPTER) : path.join(ROOT, 'contract', 'adapter.js'),
    contractPath: process.env.HARNESS_CONTRACT ? path.resolve(process.env.HARNESS_CONTRACT) : path.join(ROOT, 'contract', 'contract.json'),
  };
}

/**
 * @param {object} o
 * @param {object} [o.scenario] personas/scenario.json 形式の初期予約
 * @param {string} [o.now]
 * @param {object} [o.latency]
 */
async function startApp(o = {}) {
  const p = paths();
  const helpers = require(path.join(ROOT, 'tests', 'helpers.js'));
  const adapter = require(p.adapterPath);
  const contract = JSON.parse(fs.readFileSync(p.contractPath, 'utf8'));
  const host = new GasHost({ projectDir: p.projectDir, now: o.now || helpers.NOW, latency: o.latency || { min: 0, max: 0 }, deployment: o.deployment });
  const spreadsheetId = 'SS_APP';
  host.createSpreadsheet({ id: spreadsheetId, name: '駐車場予約（画面確認）' });
  const A = helpers.ACTORS;
  await adapter.setup(host, { spreadsheetId, rules: helpers.RULES, admins: [A.admin, A.admin2], contract });
  const seeded = [];
  if (o.scenario && Array.isArray(o.scenario.bookings)) {
    let k = 0;
    for (const b of o.scenario.bookings) {
      for (let i = 0; i < (b.count || 1); i++) {
        const who = A.residents[(k++) % A.residents.length];
        const req = helpers.reqFor(who, { date: b.date, slotId: b.slotId, quantity: b.quantity || 1 });
        const r = b.channel ? await adapter.adminRegister(host, { ...req, channel: b.channel }, A.admin) : await adapter.submit(host, req, who);
        seeded.push({ ...b, status: r.status, reservationId: r.reservationId });
      }
    }
  }
  const web = await startWebApp(host, {
    port: o.port,
    autoAdmin: o.autoAdmin ? { email: A.admin.email, secret: A.admin.secret } : null,
    adminPath: contract.ui && contract.ui.adminPath,
  });
  return {
    host, web, adapter, contract, spreadsheetId, actors: A, seeded,
    userUrl: web.url + (contract.ui && contract.ui.userPath ? contract.ui.userPath : '/exec'),
    adminUrl: web.url + (contract.ui && contract.ui.adminPath ? contract.ui.adminPath : '/exec?page=admin'),
    async close() { await web.close(); await host.close(); },
  };
}

module.exports = { startApp, paths };
