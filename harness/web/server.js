'use strict';
// Webアプリの模擬サーバー。
// 実GASと同様に「外側のページ（タイトル・addMetaTag の meta だけを持つ）」の中の iframe に、
// doGet が返した HTML を表示する。HTML 内に書いた <meta name="viewport"> は外側に効かない点も再現する。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { encode } = require('../emulator/host');

const SHIM = fs.readFileSync(path.join(__dirname, 'gsr-shim.js'), 'utf8');

function publicFunctions(sources) {
  const names = new Set();
  for (const s of sources) {
    for (const m of s.code.matchAll(/^(?:async\s+)?function\s*\*?\s*([A-Za-z$][\w$]*)\s*\(/gm)) {
      if (!m[1].endsWith('_')) names.add(m[1]);
    }
  }
  return [...names];
}

function parseCookies(h) {
  const o = {};
  for (const p of String(h || '').split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return o;
}

function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * @param {import('../emulator/host').GasHost} host
 * @param {{port?:number}} opts
 * @returns {Promise<{url:string, close:()=>Promise<void>, calls:object[]}>}
 */
async function startWebApp(host, opts = {}) {
  const frames = new Map();
  let frameSeq = 0;
  const calls = [];
  host.webCalls = calls;

  const userOf = (req, url) => {
    if (url && url.searchParams.has('__as')) return url.searchParams.get('__as') || null;
    const c = parseCookies(req.headers.cookie);
    if ('harness_user' in c) return c.harness_user || null; // 空文字 = 未ログイン
    return host.owner;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && (url.pathname === '/exec' || url.pathname === '/dev' || url.pathname === '/')) {
        const user = userOf(req, url);
        const params = Object.fromEntries([...url.searchParams].filter(([k]) => k !== '__as'));
        const parameters = {};
        for (const [k, v] of url.searchParams) if (k !== '__as') (parameters[k] = parameters[k] || []).push(v);
        const e = { parameter: params, parameters, queryString: url.search.replace(/^\?/, ''), contextPath: '', contentLength: -1, pathInfo: undefined };
        const r = await host.run('doGet', [e], { kind: 'doGet', user });
        if (!r.ok) {
          res.writeHead(r.denied ? 403 : 500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!doctype html><title>Error</title><div id="gas-error" style="font-family:sans-serif;padding:16px">${r.denied ? 'アクセス権がありません（デプロイのアクセス設定）' : 'スクリプト関数でエラーが発生しました'}: ${escAttr(r.error.message)}</div>`);
          return;
        }
        const out = r.value || {};
        if (out.__type === 'text') {
          const mime = { JSON: 'application/json', CSV: 'text/csv', TEXT: 'text/plain', JAVASCRIPT: 'application/javascript', XML: 'application/xml' }[out.mime] || 'text/plain';
          res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8` }); res.end(out.content); return;
        }
        if (out.__type !== 'html') { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('doGet は HtmlOutput か TextOutput を返す必要があります'); return; }
        const id = String(++frameSeq);
        frames.set(id, { content: out.content, params });
        const metas = (out.meta || []).map((m) => `<meta name="${escAttr(m.name)}" content="${escAttr(m.content)}">`).join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${escAttr(out.title || 'Untitled')}</title>${metas}`
          + '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden}#sandboxFrame{border:0;width:100%;height:100%;display:block}</style></head>'
          + `<body><iframe id="sandboxFrame" name="userHtmlFrame" src="/__harness/frame/${id}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-modals allow-downloads allow-top-navigation-by-user-activation"></iframe></body></html>`);
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/__harness/frame/')) {
        const f = frames.get(url.pathname.split('/').pop());
        if (!f) { res.writeHead(404); res.end(); return; }
        const cfg = `<script>window.__HARNESS_GSR__=${JSON.stringify({ publicFns: publicFunctions(host.project.sources), params: f.params })};</script><script>${SHIM}</script>`;
        let html = f.content;
        if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + cfg);
        else html = cfg + html;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/__harness/run') {
        const body = JSON.parse(await readBody(req));
        const user = userOf(req, null);
        const bf = (host.faults && host.faults.bridge) || {};
        const match = (!bf.fn || bf.fn === body.fn) && (!bf.fnPattern || new RegExp(bf.fnPattern, 'i').test(body.fn));
        const rec = { at: host.now(), fn: body.fn, user, page: body.page };
        calls.push(rec);
        if (bf.delayMs && match) await new Promise((r) => setTimeout(r, bf.delayMs));
        // 通信断：ソケットを切るとブラウザが自動で再送することがあるため、専用の応答で「届かなかった」ことにする
        if (match && bf.dropRequest > 0) { bf.dropRequest--; rec.dropped = 'request'; res.writeHead(599, { 'X-Harness-Dropped': 'request' }); res.end(); return; }
        const r = await host.run(body.fn, body.args || [], { kind: 'client', user });
        Object.assign(rec, { ok: r.ok, execId: r.execId, error: r.error && r.error.message, metrics: r.metrics });
        if (match && bf.dropResponse > 0) { bf.dropResponse--; rec.dropped = 'response'; res.writeHead(599, { 'X-Harness-Dropped': 'response' }); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        // encode 済みの値は JSON 文字列。ここでは素の JSON として返す（Date は shim 側に来ない）
        res.end(r.ok ? `{"ok":true,"value":${r.raw && r.raw.value !== undefined ? r.raw.value : 'null'}}` : JSON.stringify({ ok: false, error: { name: r.error.name, message: r.error.message } }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/__harness/faults') {
        host.faults.bridge = JSON.parse(await readBody(req));
        res.writeHead(204); res.end(); return;
      }
      if (req.method === 'GET' && url.pathname === '/__harness/ledger') {
        // 手元確認用：台帳（スプレッドシート相当）と送ったメールを表で見る
        const { displayOf } = require('../emulator/sheets-store');
        let h = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>台帳の中身（手元確認用）</title>'
          + '<style>body{font-family:sans-serif;margin:16px;font-size:14px}table{border-collapse:collapse;margin:8px 0 24px}td,th{border:1px solid #999;padding:4px 6px;white-space:nowrap}th{background:#eee}.wrap{overflow-x:auto}h2{margin:16px 0 4px}</style></head><body>'
          + '<h1>台帳の中身（手元確認用）</h1><p>このページは試験用のサーバーだけにあり、GAS には含まれません。<a href="/__harness/ledger">最新にする</a></p>';
        for (const b of host.store.books.values()) {
          for (const sh of b.sheets) {
            const { lastRow, lastCol } = host.store.dims(b.id, sh.sheetId);
            h += `<h2>${escAttr(sh.name)}（${Math.max(lastRow - 1, 0)}行）</h2>`;
            if (!lastRow) { h += '<p>（空）</p>'; continue; }
            const vals = host.store.getValues(b.id, sh.sheetId, 1, 1, lastRow, Math.max(lastCol, 1));
            h += '<div class="wrap"><table>' + vals.map((r, i) => `<tr>${r.map((v) => (i === 0 ? `<th>${escAttr(v)}</th>` : `<td>${escAttr(displayOf(v, b.tz))}</td>`)).join('')}</tr>`).join('') + '</table></div>';
          }
        }
        h += `<h2>送ったメール（${host.outbox.length}通）</h2>`;
        h += host.outbox.length ? '<div class="wrap"><table><tr><th>宛先</th><th>件名</th><th>本文</th></tr>' + host.outbox.map((m) => `<tr><td>${escAttr(m.to)}</td><td>${escAttr(m.subject)}</td><td style="white-space:pre-wrap">${escAttr(m.body)}</td></tr>`).join('') + '</table></div>' : '<p>（まだ送っていない。通知は時間主導トリガーで送るため、手元では <a href="/__harness/run-notify">ここ</a> を押すと1回分を実行する）</p>';
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`${h}</body></html>`);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/__harness/admin-auto' && opts.autoAdmin) {
        // 手元確認用：管理者の確認を代わりに済ませて管理者画面を開く（npm run serve のときだけ有効。GAS には含まれない）
        const r = await host.run('api_admin_login', [{ email: opts.autoAdmin.email, secret: opts.autoAdmin.secret }], { kind: 'client', user: null });
        const v = r.value || {};
        if (v.status !== 'OK') { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(`自動で管理者の確認ができなかった: ${JSON.stringify(v)}`); return; }
        const adminPath = (opts.adminPath || '/exec?page=admin');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><script>try{sessionStorage.setItem('adminToken',${JSON.stringify(v.token)});sessionStorage.setItem('adminName',${JSON.stringify(v.name)});}catch(e){}location.replace(${JSON.stringify(adminPath)});</script>`);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/__harness/run-notify') {
        await host.run('job_processNotifications', [], { kind: 'trigger' });
        res.writeHead(302, { Location: '/__harness/ledger' }); res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/__harness/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(encode({ calls, outbox: host.outbox, warnings: host.warnings })); return;
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(String(e.stack || e));
    }
  });
  await new Promise((r) => server.listen(opts.port || 0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  host.webUrl = `${url}/exec`;
  return { url, calls, server, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

module.exports = { startWebApp, publicFunctions };
