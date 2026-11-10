#!/usr/bin/env node
'use strict';
/**
 * 外に置く住民の画面（tools/build-resident-static.js が作るもの）を、手元で動かして見る（D-034）。
 *   node tools/serve-resident-static.js      → http://localhost:8790/
 * GAS の doPost の代わりに、エミュレータの residentApi_ を呼ぶ（doPost は ContentService で包むだけ）。
 * 設定は本番と同じ（住民の受付は閉じる）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const helpers = require('../tests/helpers');
const { startApp } = require('../harness/web/app');
const { build } = require('./build-resident-static');

async function startStatic(o = {}) {
  const scenario = o.scenario || JSON.parse(fs.readFileSync(path.join(__dirname, 'preview-scenario.json'), 'utf8'));
  const app = await startApp({ scenario, now: o.now || scenario.now });
  const rules = o.rules || { ...helpers.RULES, maxQuantityPerRequest: 1, capacityPerSlot: 2, residentBooking: false, viewMonths: 3 };
  const r = await app.host.run('setup_init', [rules, []], { kind: 'editor' });
  if (!r.ok || r.value.status !== 'OK') throw new Error('設定の切り替えに失敗: ' + JSON.stringify(r.error || r.value));
  if (o.props) app.host.setScriptProperties(o.props);
  const calls = [];
  let failNext = 0;
  let page = '';
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/gas') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        if (failNext > 0) { failNext--; res.writeHead(500); res.end('error'); return; }
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
        calls.push({ body: parsed, cookie: req.headers.cookie || '' });
        // 匿名の住民として呼ぶ（本物では、クッキーを送らないので、GAS からは未ログインの人に見える）
        const out = await app.host.run('residentApi_', [parsed], { kind: 'direct', user: '' });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(out.ok ? out.value : { status: 'ERROR', reason: 'SYSTEM' }));
      });
      return;
    }
    if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => server.listen(o.port || 0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/`;
  page = build({ gasUrl: url + 'gas', fallback: o.fallback || '理事会事務局（電話 03-0000-0000）' });
  return {
    url, app, calls,
    failNext(n) { failNext = n; },
    async close() { await new Promise((ok) => server.close(ok)); await app.close(); },
  };
}

module.exports = { startStatic };

if (require.main === module) {
  startStatic({ port: Number(process.env.PORT || 8790) }).then((s) => {
    console.log(`外に置く住民の画面（手元で確認）: ${s.url}`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
