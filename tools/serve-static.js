#!/usr/bin/env node
'use strict';
/**
 * 外に置く2枚の画面（tools/build-static.js が作るもの）を、手元で動かして見る（D-034・D-035）。
 *   node tools/serve-static.js      → 住民 http://localhost:8790/   管理者 http://localhost:8790/admin/
 * GAS の代わりに、エミュレータの上の doPost をそのまま呼ぶ（クッキー無しの、未ログインの人として）。
 * 設定は本番と同じ（住民の受付は閉じる）。管理者は、手元の確認用に admin@example.com ／ local-pass-1234 で入れる。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const helpers = require('../tests/helpers');
const { startApp } = require('../harness/web/app');
const { buildAll } = require('./build-static');

const LOCAL_ADMIN = { email: 'admin@example.com', name: '手元の管理者', secret: 'local-pass-1234' };

async function startStatic(o = {}) {
  const scenario = o.scenario || JSON.parse(fs.readFileSync(path.join(__dirname, 'preview-scenario.json'), 'utf8'));
  const app = await startApp({ scenario, now: o.now || scenario.now });
  const rules = o.rules || { ...helpers.RULES, maxQuantityPerRequest: 1, capacityPerSlot: 2, residentBooking: false, viewMonths: 3 };
  const admins = o.admins || [LOCAL_ADMIN];
  const r = await app.host.run('setup_init', [rules, admins], { kind: 'editor' });
  if (!r.ok || r.value.status !== 'OK') throw new Error('設定の切り替えに失敗: ' + JSON.stringify(r.error || r.value));
  if (o.props) app.host.setScriptProperties(o.props);
  const calls = [];
  let failNext = 0;
  let pages = {};
  const server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (req.method === 'POST' && u === '/gas') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', async () => {
        if (failNext > 0) { failNext--; res.writeHead(500); res.end('error'); return; }
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
        calls.push({ body: parsed, cookie: req.headers.cookie || '', contentType: req.headers['content-type'] || '' });
        // 本物と同じく doPost を呼ぶ。クッキーを送らないので、GAS からは未ログインの人に見える
        const out = await app.host.run('doPost', [{ postData: { contents: body, type: 'text/plain' }, parameter: {}, parameters: {} }], { kind: 'doGet', user: null });
        const text = out.ok && out.value && typeof out.value.content === 'string' ? out.value.content : JSON.stringify({ status: 'ERROR', reason: 'SYSTEM' });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(text);
      });
      return;
    }
    if (req.method === 'GET') {
      const rel = u === '/' ? 'index.html' : u === '/admin/' || u === '/admin' ? 'admin/index.html' : null;
      if (rel && pages[rel]) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pages[rel]);
        return;
      }
    }
    res.writeHead(404); res.end();
  });
  await new Promise((ok) => server.listen(o.port || 0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${server.address().port}/`;
  pages = buildAll({ gasUrl: url + 'gas', fallback: o.fallback || '理事会事務局（電話 03-0000-0000）' });
  return {
    url, app, calls, admin: admins[0],
    failNext(n) { failNext = n; },
    async close() { await new Promise((ok) => server.close(ok)); await app.close(); },
  };
}

module.exports = { startStatic, LOCAL_ADMIN };

if (require.main === module) {
  startStatic({ port: Number(process.env.PORT || 8790) }).then((s) => {
    console.log(`外に置く画面（手元で確認）: 住民 ${s.url}  管理者 ${s.url}admin/  （${LOCAL_ADMIN.email} / ${LOCAL_ADMIN.secret}）`);
  }).catch((e) => { console.error(e); process.exit(1); });
}
