#!/usr/bin/env node
'use strict';
/**
 * ペルソナ操作ツール。評価役のAIが「その人として」画面を1手ずつ操作するために使う。
 * 評価役はソースコードを見ず、このツールが返す画面の情報とスクリーンショットだけで判断する。
 *
 *   node harness/persona/drive.js start <personaId> <taskId> [--run <runId>]
 *   node harness/persona/drive.js <sid> obs
 *   node harness/persona/drive.js <sid> click <番号>
 *   node harness/persona/drive.js <sid> type <番号> <文字>
 *   node harness/persona/drive.js <sid> select <番号> <選択肢の文字>
 *   node harness/persona/drive.js <sid> scroll down|up
 *   node harness/persona/drive.js <sid> back
 *   node harness/persona/drive.js <sid> think <その時に思ったこと>
 *   node harness/persona/drive.js <sid> done <自分は何を達成したと思うか>
 *   node harness/persona/drive.js <sid> giveup <やめた理由>
 *   node harness/persona/drive.js shutdown
 *
 * 1回目の呼出しで裏で常駐プロセスを起動し、ブラウザと模擬GASを保持する（20分操作が無ければ自動終了）。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const STATE = path.join(ROOT, 'reports', 'persona', '.drive.json');
const PERSONAS = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'personas', 'personas.json'), 'utf8')).personas;
const SCENARIO = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'personas', 'scenario.json'), 'utf8'));
const COST = JSON.parse(fs.readFileSync(path.join(ROOT, 'harness', 'emulator', 'cost-model.json'), 'utf8'));
const CLIENT_OVERHEAD_MS = COST.clientCallOverheadMs || 700;

/** 常駐プロセスが古いコードのまま動き続けないよう、関係するファイルの内容から版を作る */
function codeHash() {
  const h = require('crypto').createHash('sha256');
  const files = [__filename, path.join(__dirname, 'collect.js'), path.join(ROOT, 'harness', 'web', 'app.js'), path.join(ROOT, 'harness', 'web', 'server.js'), path.join(ROOT, 'harness', 'web', 'gsr-shim.js'), path.join(ROOT, 'harness', 'emulator', 'host.js'), path.join(ROOT, 'harness', 'invariants.js')];
  for (const f of files) if (fs.existsSync(f)) h.update(fs.readFileSync(f));
  return h.digest('hex').slice(0, 16);
}

// ======================================================================== CLI
async function cli(argv) {
  if (argv[0] === '__daemon') return daemon();
  if (!argv.length) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 20).join('\n')); return; }
  const port = await ensureDaemon();
  const body = JSON.stringify({ argv });
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/cmd', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => {
      let b = ''; r.on('data', (d) => { b += d; }); r.on('end', () => resolve(b));
    });
    req.on('error', reject); req.end(body);
  });
  process.stdout.write(res.endsWith('\n') ? res : `${res}\n`);
}

async function ensureDaemon() {
  const ping = async (port) => new Promise((r) => {
    const q = http.get({ host: '127.0.0.1', port, path: '/ping', timeout: 1500 }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { r(res.statusCode === 200 ? JSON.parse(b) : null); } catch (e) { r(null); } });
    });
    q.on('error', () => r(null)); q.on('timeout', () => { q.destroy(); r(null); });
  });
  const alive = async (port) => !!(await ping(port));
  if (fs.existsSync(STATE)) {
    const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const p = await ping(s.port);
    if (p && p.hash === codeHash()) return s.port;
    if (p && p.active > 0) {
      process.stderr.write(`注意: 操作ツールのコードが更新されたが、実行中のセッションが ${p.active} 件あるため古い版のまま使う\n`);
      return s.port;
    }
    if (p) { // 古い版の常駐プロセスを止める
      await new Promise((r) => { const q = http.request({ host: '127.0.0.1', port: s.port, path: '/cmd', method: 'POST' }, (res) => { res.resume(); res.on('end', r); }); q.on('error', r); q.end(JSON.stringify({ argv: ['shutdown'] })); });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  const p = spawn(process.execPath, [__filename, '__daemon'], { detached: true, stdio: 'ignore', cwd: ROOT, env: process.env });
  p.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    if (fs.existsSync(STATE)) { const s = JSON.parse(fs.readFileSync(STATE, 'utf8')); if (await alive(s.port)) return s.port; }
  }
  throw new Error('drive の常駐プロセスを起動できなかった');
}

// ======================================================================== 常駐プロセス
async function daemon() {
  const { loadPlaywright } = require('../web/pw');
  const { startApp } = require('../web/app');
  const { collect } = require('./collect');
  const { checkLedger, readNamed, normDate } = require('../invariants');
  const pw = loadPlaywright();
  const HASH = codeHash();
  const browser = await pw.chromium.launch();
  const sessions = new Map();
  let seq = 0;
  let idleTimer;
  const touch = () => { clearTimeout(idleTimer); idleTimer = setTimeout(shutdown, 20 * 60 * 1000); };
  async function shutdown() {
    for (const s of sessions.values()) await closeSession(s).catch(() => {});
    await browser.close().catch(() => {});
    try { fs.unlinkSync(STATE); } catch (e) { /* 無視 */ }
    process.exit(0);
  }

  async function closeSession(s) {
    if (s.closed) return;
    s.closed = true;
    await s.ctx.close().catch(() => {});
    await s.app.close().catch(() => {});
  }

  function frameOf(s) { return s.page.frame({ name: 'userHtmlFrame' }) || s.page.mainFrame(); }

  async function settle(s) {
    const t0 = Date.now();
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const p = await frameOf(s).evaluate(() => window.__harnessPending || 0).catch(() => 0);
      if (!p && i >= 2) break;
    }
    return Date.now() - t0;
  }

  async function observe(s, note) {
    const f = frameOf(s);
    if (s.persona.constraints.grayscale) await f.evaluate(() => { document.documentElement.style.filter = 'grayscale(1)'; }).catch(() => {});
    let o;
    try { o = await f.evaluate(collect); } catch (e) { o = { elements: [], texts: [], scrollWidth: 0, clientWidth: 0, error: e.message }; }
    const c = s.persona.constraints;
    const minPx = c.minReadablePx || 0;
    const shot = path.join(s.dir, `step-${String(s.stepNo).padStart(3, '0')}.png`);
    await s.page.screenshot({ path: shot }).catch(() => {});
    const readable = (px) => !minPx || px >= minPx;
    const unfamiliar = (c.unfamiliarWords || []).filter((w) => o.texts.some((t) => t.inView && t.t.includes(w)) || o.elements.some((e) => e.inView && e.name.includes(w)));
    const small = o.elements.filter((e) => !e.disabled && (e.w < 44 || e.h < 44) && e.tag !== 'a');
    const unreadableEls = o.elements.filter((e) => !readable(e.fontPx));
    const hscroll = o.scrollWidth > o.clientWidth + 1;
    s.lastObs = { unfamiliar, small, unreadableEls, hscroll, unreadableTexts: o.texts.filter((t) => !readable(t.px)).length };
    // 人が読む形の画面説明
    const L = [];
    if (note) L.push(note, '');
    L.push(`【画面 ${s.stepNo}】 スクリーンショット: ${path.relative(ROOT, shot)}`);
    if (o.error) L.push(`（画面を読み取れなかった: ${o.error}）`);
    if (s.dialogs.length) { for (const d of s.dialogs.splice(0)) L.push(`（確認の小窓が出た：「${d}」→ OK を押した）`); }
    L.push(`画面の位置: 上から ${o.scrollY}px（全体 ${o.scrollHeight}px、見えている高さ ${o.innerHeight}px）${hscroll ? '　※横にはみ出している（横スクロールが必要）' : ''}`);
    L.push('', '■ 見えている文字');
    let lastTop = -1; let line = '';
    for (const t of o.texts.filter((x) => x.inView)) {
      const s2 = readable(t.px) ? t.t : '［小さくて読めない文字］';
      if (Math.abs(t.top - lastTop) > 6 && line) { L.push(`  ${line}`); line = ''; }
      line += (line ? ' ' : '') + s2; lastTop = t.top;
    }
    if (line) L.push(`  ${line}`);
    const below = o.texts.filter((x) => !x.inView).length;
    if (below) L.push(`  （画面の外にも文字がある：スクロールすると見える）`);
    L.push('', '■ 押せるもの・入力できるもの（番号で操作する）');
    for (const e of o.elements) {
      const label = readable(e.fontPx) ? (e.name || '（名前のない部品）') : '［小さくて読めない］';
      const kind = { button: 'ボタン', a: 'リンク', select: '選択欄', textarea: '入力欄', summary: '開閉' }[e.tag] || (e.tag === 'input' ? { checkbox: 'チェック', radio: '選択肢', date: '日付欄', submit: 'ボタン', button: 'ボタン' }[e.type] || '入力欄' : '部品');
      const extra = [e.disabled ? '押せない' : '', e.value ? `入力済み「${e.value}」` : '', e.checked ? '選択中' : '', e.options ? `選択肢: ${e.options.join(' / ')}` : '', e.inView ? '' : '画面外'].filter(Boolean).join('、');
      L.push(`  [${e.idx}] ${kind}「${label}」${extra ? `（${extra}）` : ''}`);
    }
    if (!o.elements.length) L.push('  （操作できるものが無い）');
    L.push('', `操作 ${s.stepNo}/${c.maxSteps} 手目まで使用。`);
    return L.join('\n');
  }

  async function verify(s) {
    const v = s.task.verify || {};
    const L = s.app.contract.ledger;
    const res = readNamed(s.app.host, s.app.spreadsheetId, L.reservations).rows;
    const alc = readNamed(s.app.host, s.app.spreadsheetId, L.allocations).rows;
    const tz = s.app.contract.timeZone;
    const match = (r) => normDate(r.date, tz).v === v.date && String(r.slot_id) === v.slotId && (!v.nameIncludes || String(r.name || '').includes(v.nameIncludes));
    const confirmed = new Set(L.reservations.states.confirmed);
    const cancelled = new Set(L.reservations.states.cancelled);
    let ok = false; let detail = '';
    if (v.type === 'reservation') {
      // personas.json の状態は抽象名（CONFIRMED 等）。contract.json の実際の値に読み替える
      const stateMap = { CONFIRMED: [...confirmed], CANCELLED: [...cancelled], REJECTED: L.reservations.states.rejected || [] };
      const wanted = (v.states || ['CONFIRMED']).flatMap((x) => stateMap[x] || [x]);
      const hits = res.filter((r) => match(r) && wanted.includes(String(r.state)) && (!v.quantity || Number(r.quantity) === v.quantity) && (!v.channelIn || v.channelIn.includes(String(r.channel).toUpperCase())));
      ok = v.exactlyOne ? hits.length === 1 : hits.length >= 1;
      detail = `該当 ${hits.length} 件`;
      if (v.exactlyOne) { const all = res.filter((r) => match(r) && confirmed.has(String(r.state))); if (all.length > 1) { ok = false; detail += `（確定が ${all.length} 件：二重予約）`; } }
    } else if (v.type === 'noReservation') {
      const hits = res.filter((r) => match(r) && confirmed.has(String(r.state)));
      ok = hits.length === 0; detail = `確定 ${hits.length} 件`;
    } else if (v.type === 'cancelled') {
      const hits = res.filter((r) => normDate(r.date, tz).v === v.date && String(r.slot_id) === v.slotId && cancelled.has(String(r.state)));
      const stillActive = alc.filter((a) => hits.some((h) => String(h.reservation_id) === String(a.reservation_id)) && L.allocations.activeStates.includes(String(a.state)));
      ok = hits.length >= 1 && stillActive.length === 0; detail = `取消済み ${hits.length} 件、残った割当て ${stillActive.length} 件`;
    }
    const inv = checkLedger(s.app.host, s.app.spreadsheetId, s.app.contract);
    return { ok: ok && inv.ok, taskOk: ok, detail, invariants: inv.violations };
  }

  // 達成判定は評価役が読むログとは別のファイルに書く（評価役が判定結果を見て感想を変えないように）
  function saveVerify(s, v) { fs.writeFileSync(path.join(s.dir, 'verify.json'), JSON.stringify(v, null, 2)); }

  function log(s, rec) {
    fs.appendFileSync(path.join(s.dir, 'log.jsonl'), `${JSON.stringify({ step: s.stepNo, at: Date.now() - s.t0, ...rec, obs: s.lastObs ? { unfamiliar: s.lastObs.unfamiliar, small: s.lastObs.small.map((e) => `${e.name}(${e.w}x${e.h})`), unreadableEls: s.lastObs.unreadableEls.map((e) => e.name), hscroll: s.lastObs.hscroll, unreadableTexts: s.lastObs.unreadableTexts } : null })}\n`);
  }

  async function start(argv) {
    const [personaId, taskId] = argv;
    const runId = argv.includes('--run') ? argv[argv.indexOf('--run') + 1] : (process.env.PERSONA_RUN || `run-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`);
    const persona = PERSONAS().find((p) => p.id === personaId);
    if (!persona) return `ペルソナ ${personaId} が無い。候補: ${PERSONAS().map((p) => p.id).join(', ')}`;
    const task = persona.tasks.find((t) => t.id === taskId);
    if (!task) return `課題 ${taskId} が無い。候補: ${persona.tasks.map((t) => t.id).join(', ')}`;
    const sc = SCENARIO();
    const app = await startApp({ scenario: sc, now: sc.now, latency: { min: 0, max: 0 } });
    const dev = pw.devices[persona.device] || pw.devices['iPhone SE'];
    const ctx = await browser.newContext({ ...dev, locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    const actor = persona.role === 'admin' ? app.actors.admin : null;
    await ctx.addCookies([{ name: 'harness_user', value: actor ? actor.email : '', url: app.web.url }]);
    if (persona.constraints.network === 'dropFirstSubmitResponse') {
      app.host.faults.bridge = { dropResponse: 1, fnPattern: (app.contract.ui && app.contract.ui.submitFunctionPattern) || 'submit|reserv|book|register' };
    }
    const page = await ctx.newPage();
    // 並行して評価するとき、他の評価役のセッションを取り違えないよう、推測できない ID にする（HX-006）
    const sid = `${personaId}-${taskId}-${require('crypto').randomBytes(3).toString('hex')}`; seq++;
    const dir = path.join(ROOT, 'reports', 'persona', runId, `${personaId}__${taskId}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const s = { sid, persona, task, app, ctx, page, dir, runId, hasTouch: !!dev.hasTouch, stepNo: 0, t0: Date.now(), dialogs: [], ended: false };
    page.on('pageerror', (e) => log(s, { action: 'pageerror', text: String(e.message).slice(0, 300) }));
    page.on('dialog', async (d) => { s.dialogs.push(d.message()); await d.accept().catch(() => {}); });
    sessions.set(sid, s);
    const url = persona.role === 'admin' ? app.adminUrl : app.userUrl;
    await page.goto(url);
    await settle(s);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ runId, persona: personaId, task: taskId, device: persona.device, startedAt: new Date().toISOString(), url: url.replace(app.web.url, '') }, null, 2));
    log(s, { action: 'start' });
    const cred = persona.role === 'admin'
      ? `\nあなたの管理者としての情報（必要になったら使う）：メール ${actor.email} ／ 管理者パスコード ${actor.secret} ／ 氏名 ${actor.name}`
      : '\nあなたはGoogleにログインしていない状態で開いている。';
    const card = [
      `セッション: ${sid}（以降のコマンドは node harness/persona/drive.js ${sid} <操作> で行う）`,
      `ペルソナ: ${persona.name} ／ 端末: ${persona.device}`,
      `課題: ${task.text}${cred}`,
      `制約: 最大 ${persona.constraints.maxSteps} 手。`,
    ].join('\n');
    return `${card}\n\n${await observe(s)}`;
  }

  async function act(s, cmd, args) {
    if (s.ended) return 'このセッションは終了している。';
    const c = s.persona.constraints;
    const f = frameOf(s);
    const loc = (n) => f.locator(`[data-hx="${n}"]`);
    const callsBefore = s.app.web.calls.length;
    const t0 = Date.now();
    let err = null; let target = null;
    if (['click', 'type', 'select', 'check'].includes(cmd)) {
      const n = Number(args[0]);
      const el = loc(n);
      if (!Number.isInteger(n) || !(await el.count())) err = `番号 ${args[0]} の部品は無い`;
      else {
        target = { idx: n, name: await el.evaluate((e) => (e.getAttribute('aria-label') || e.innerText || e.value || e.name || '').trim().slice(0, 40)).catch(() => '') };
        try {
          await el.scrollIntoViewIfNeeded({ timeout: 2000 });
          if (cmd === 'click' || cmd === 'check') {
            if (await el.isDisabled().catch(() => false)) err = 'その部品は押せない状態だった';
            else if (s.hasTouch) await el.tap({ timeout: 3000 }).catch(async () => el.click({ timeout: 3000 }));
            else await el.click({ timeout: 3000 });
          } else if (cmd === 'type') await el.fill(args.slice(1).join(' '), { timeout: 3000 });
          else if (cmd === 'select') await el.selectOption({ label: args.slice(1).join(' ') }, { timeout: 3000 });
        } catch (e) { err = `操作できなかった: ${e.message.split('\n')[0]}`; }
      }
    } else if (cmd === 'scroll') {
      await f.evaluate((d) => window.scrollBy(0, (d === 'up' ? -1 : 1) * innerHeight * 0.8), args[0]).catch(() => {});
    } else if (cmd === 'back') {
      await f.evaluate(() => history.back()).catch(() => {});
    } else if (cmd === 'wait') {
      await new Promise((r) => setTimeout(r, 1500));
    } else return `不明な操作 ${cmd}`;
    const waitMs = await settle(s);
    const calls = s.app.web.calls.slice(callsBefore).map((x) => ({ fn: x.fn, ok: x.ok, dropped: x.dropped, estGasMs: x.metrics ? x.metrics.estGasMs : null }));
    const estUserWaitMs = calls.reduce((a, x) => a + (x.estGasMs || 0) + CLIENT_OVERHEAD_MS, 0);
    s.stepNo++;
    const obs = await observe(s, err ? `（${err}）` : '');
    log(s, { action: cmd, args, target, error: err, waitMs, localMs: Date.now() - t0, calls, estUserWaitMs });
    if (s.stepNo >= c.maxSteps) {
      s.ended = true;
      const v = await verify(s);
      saveVerify(s, v);
      log(s, { action: 'limit' });
      await closeSession(s);
      return `${obs}\n\n手数の上限（${c.maxSteps} 手）に達したため、このペルソナはここで諦めた。`;
    }
    return obs;
  }

  const server = http.createServer(async (req, res) => {
    touch();
    if (req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ hash: HASH, active: [...sessions.values()].filter((x) => !x.closed).length }));
      return;
    }
    let b = ''; for await (const ch of req) b += ch;
    let out;
    try {
      const { argv } = JSON.parse(b);
      if (argv[0] === 'shutdown') { res.end('終了します'); setTimeout(shutdown, 50); return; }
      if (argv[0] === 'start') out = await start(argv.slice(1));
      else {
        const s = sessions.get(argv[0]);
        if (!s) out = `セッション ${argv[0]} が無い（start から始めること）`;
        else {
          const cmd = argv[1]; const args = argv.slice(2);
          if (cmd === 'obs') out = await observe(s);
          else if (cmd === 'think') { log(s, { action: 'think', text: args.join(' ') }); out = '（記録した）'; }
          else if (cmd === 'done' || cmd === 'giveup') {
            const v = await verify(s);
            saveVerify(s, v);
            log(s, { action: cmd, text: args.join(' ') });
            s.ended = true; await closeSession(s);
            out = `（記録した。セッション終了。ログ: ${path.relative(ROOT, s.dir)}）`;
          } else out = await act(s, cmd, args);
        }
      }
    } catch (e) { out = `エラー: ${e.stack || e}`; }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(out);
  });
  server.listen(0, '127.0.0.1', () => {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ port: server.address().port, pid: process.pid }));
    touch();
  });
}

cli(process.argv.slice(2)).catch((e) => { console.error(e.stack || e); process.exit(1); });

