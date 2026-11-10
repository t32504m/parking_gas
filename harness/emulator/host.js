'use strict';
// GAS ホスト（Node のメインスレッド側）。
// ・各「実行」（google.script.run 呼出し、doGet、トリガー等）を別スレッド(worker)で動かす。
//   GAS と同じく、実行ごとにグローバル変数は初期化され、共有されるのはスプレッドシート等の外部状態だけ。
// ・スプレッドシート操作は1回ごとにこのホストへ同期RPCされるため、複数実行の操作が実際に交互に起きる。
//   → ロックの付け忘れや「読んでから書くまでの隙間」による二重予約を再現できる。
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { SheetsStore, GasError } = require('./sheets-store');

const SAB_BYTES = 4 * 1024 * 1024;
const DEFAULT_COST = JSON.parse(fs.readFileSync(path.join(__dirname, 'cost-model.json'), 'utf8'));

function encode(v) {
  return JSON.stringify(v, function (k, val) {
    const o = this[k];
    if (o instanceof Date) return { $d: o.getTime() };
    return val;
  });
}
function decode(s) {
  return JSON.parse(s, (k, v) => (v && typeof v === 'object' && typeof v.$d === 'number' && Object.keys(v).length === 1 ? new Date(v.$d) : v));
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function loadProject(projectDir) {
  const manifestPath = path.join(projectDir, 'appsscript.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : {};
  const files = fs.existsSync(projectDir) ? fs.readdirSync(projectDir) : [];
  let order = null;
  for (const p of [path.join(projectDir, '.clasp.json'), path.join(projectDir, '..', '.clasp.json')]) {
    if (fs.existsSync(p)) {
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(c.filePushOrder)) order = c.filePushOrder.map((f) => path.basename(f));
    }
  }
  const server = files.filter((f) => /\.(gs|js)$/.test(f)).sort();
  if (order) server.sort((a, b) => (order.indexOf(a) === -1 ? 1e9 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 1e9 : order.indexOf(b)) || a.localeCompare(b));
  const sources = server.map((f) => ({ name: f, code: fs.readFileSync(path.join(projectDir, f), 'utf8') }));
  const html = {};
  for (const f of files.filter((x) => x.endsWith('.html'))) html[f.replace(/\.html$/, '')] = fs.readFileSync(path.join(projectDir, f), 'utf8');
  return { manifest, sources, html };
}

class GasHost {
  /**
   * @param {object} o
   * @param {string} o.projectDir   GASプロジェクトのフォルダ（src/）
   * @param {string} [o.owner]      スクリプト所有者（デプロイしたユーザー）
   * @param {string} [o.boundSpreadsheetId] コンテナバインドの場合のスプレッドシートID
   * @param {object} [o.latency]    シート操作ごとの遅延 {min,max}(ms)。競合の隙間を広げる
   * @param {number} [o.seed]
   * @param {string|number} [o.now] 仮想時計の初期時刻
   * @param {number} [o.maxExecutionMs] 1実行の上限（実GASは6分）
   * @param {number} [o.mailQuota]  1日のメール上限（無料アカウントは100）
   */
  constructor(o = {}) {
    this.projectDir = o.projectDir || path.join(__dirname, '..', '..', 'src');
    this.owner = o.owner || 'owner@example.com';
    this.boundSpreadsheetId = o.boundSpreadsheetId || null;
    this.latency = o.latency || { min: 0, max: 0 };
    this.rand = mulberry32(o.seed || 12345);
    this.clockOffset = o.now !== undefined ? new Date(o.now).getTime() - Date.now() : 0;
    this.maxExecutionMs = o.maxExecutionMs || 30000;
    this.mailQuota = o.mailQuota ?? 100;
    this.deferWrites = o.deferWrites !== undefined ? o.deferWrites : true;
    this.commitDelayMs = o.commitDelayMs; // 実行終了から未反映の書込みが反映されるまで（既定: 遅延の10倍。最悪の場合を想定）
    this.cost = { ...DEFAULT_COST.ops, ...(o.cost || {}) };
    this.webUrl = o.webUrl || 'https://script.google.com/macros/s/HARNESS_DEPLOYMENT/exec';
    this.project = loadProject(this.projectDir);
    if (o.sourceOverride) this.project = { ...this.project, ...o.sourceOverride };
    const wa = (this.project.manifest && this.project.manifest.webapp) || {};
    this.deployment = { executeAs: wa.executeAs || 'USER_DEPLOYING', access: wa.access || 'MYSELF', ...(o.deployment || {}) };
    this.timeZone = (this.project.manifest && this.project.manifest.timeZone) || 'Asia/Tokyo';
    this.sameDomain = o.sameDomain || null; // Workspace 同一ドメインのとき 'example.org' など

    this.store = new SheetsStore({ clock: () => this.now() });
    this.locks = new Map(); // key -> {holder, queue:[{exec, resolve, timer, t0}]}
    this.props = { script: new Map(), user: new Map(), document: new Map() };
    this.cache = new Map(); // scope|key -> {v, exp}
    this.outbox = []; // 送信済みメール
    this.mailAttempts = []; // 失敗も含む送信試行
    this.mailSentToday = 0;
    this.triggers = [];
    this.faults = {};
    this.executions = []; // 完了した実行の記録
    this.warnings = [];
    this.seq = 0;
    this.live = new Map();
  }

  now() { return Date.now() + this.clockOffset; }
  setClock(t) { this.clockOffset = new Date(t).getTime() - Date.now(); }
  advanceClock(ms) { this.clockOffset += ms; }
  reloadSources() { this.project = loadProject(this.projectDir); }

  createSpreadsheet(opts) { return this.store.createSpreadsheet({ tz: this.timeZone, ...opts }); }
  setScriptProperties(obj) { for (const [k, v] of Object.entries(obj)) this.props.script.set(k, String(v)); }
  getScriptProperty(k) { return this.props.script.has(k) ? this.props.script.get(k) : null; }
  dumpSheet(ssId, name) { return this.store.dumpSheet(ssId, name); }

  /** 障害注入。例: host.setFaults({ lock: { mode: 'timeout' }, mail: { failAll: true } }) */
  setFaults(f) { this.faults = { ...this.faults, ...f }; }
  clearFaults() { this.faults = {}; }

  // ---------- 利用者情報（デプロイ設定に依存。仮定 A-10〜A-12） ----------
  _accessAllowed(kind, user) {
    if (!['client', 'doGet'].includes(kind)) return true;
    const { access } = this.deployment;
    if (access === 'MYSELF') return user === this.owner;
    if (access === 'DOMAIN') return !!user && !!this.sameDomain && user.endsWith(`@${this.sameDomain}`);
    if (access === 'ANYONE') return !!user;
    return true; // ANYONE_ANONYMOUS
  }

  _session(kind, user) {
    const d = this.deployment;
    if (kind === 'trigger' || kind === 'editor' || kind === 'direct') {
      const u = kind === 'direct' ? (user ?? this.owner) : this.owner;
      return { active: u || '', effective: this.owner };
    }
    if (d.executeAs === 'USER_ACCESSING') return { active: user || '', effective: user || '' };
    // USER_DEPLOYING: 所有者本人か、同一Workspaceドメインの場合だけメールが取れる
    const sameDom = this.sameDomain && user && user.endsWith(`@${this.sameDomain}`) && this.owner.endsWith(`@${this.sameDomain}`);
    return { active: user && (user === this.owner || sameDom) ? user : '', effective: this.owner };
  }

  // ---------- 実行 ----------
  /**
   * 1回の実行を行う。
   * kind: 'client'（google.script.run 経由）| 'doGet' | 'trigger' | 'editor'（エディタから手動実行）| 'direct'
   */
  run(fn, args = [], opts = {}) {
    return this._start(fn, args, opts, false).promise;
  }

  /** 複数の実行を「同時に」開始する。全員の読み込み完了を待ってから一斉に走らせる。 */
  async runConcurrently(calls) {
    const handles = calls.map((c) => this._start(c.fn, c.args || [], c, true));
    await Promise.all(handles.map((h) => h.ready));
    for (const h of handles) h.go();
    return Promise.all(handles.map((h) => h.promise));
  }

  _start(fn, args, opts, barrier) {
    const kind = opts.kind || 'client';
    const user = opts.user === undefined ? this.owner : opts.user;
    const execId = `E${++this.seq}`;
    const label = `${execId}:${fn}`;
    const rec = {
      execId, fn, kind, user, label, startedAt: this.now(), t0: process.hrtime.bigint(),
      ops: {}, estMs: 0, lockWaits: [], writes: 0, logs: [], locksHeld: new Set(), pending: [],
    };
    if (!this._accessAllowed(kind, user)) {
      const res = { ok: false, denied: true, execId, error: { name: 'AccessDenied', message: `Access denied for ${user || 'anonymous'} (webapp access=${this.deployment.access})` }, logs: [], metrics: {} };
      return { ready: Promise.resolve(), go() {}, promise: Promise.resolve(res) };
    }
    const sab = new SharedArrayBuffer(16 + SAB_BYTES);
    const ctrl = new Int32Array(sab, 0, 4);
    const sess = this._session(kind, user);
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
      workerData: {
        sab, barrier, fn, kind, argsJson: encode(args), sources: this.project.sources, html: this.project.html,
        clockOffset: this.clockOffset, maxExecutionMs: opts.timeoutMs || this.maxExecutionMs,
        env: {
          activeUser: sess.active, effectiveUser: sess.effective, timeZone: this.timeZone,
          boundSpreadsheetId: this.boundSpreadsheetId, webUrl: this.webUrl, execId, kind,
          tempKey: crypto.createHash('sha256').update(`${user}|tempkey`).digest('base64').slice(0, 24),
        },
      },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.live.set(execId, { worker, rec });
    let readyResolve; const ready = new Promise((r) => { readyResolve = r; });
    let pendingChunks = null;
    const respond = (payload) => {
      const bytes = Buffer.from(payload, 'utf8');
      pendingChunks = { bytes, off: 0 };
      sendChunk();
    };
    const sendChunk = () => {
      const { bytes, off } = pendingChunks;
      const n = Math.min(SAB_BYTES, bytes.length - off);
      new Uint8Array(sab, 16, n).set(bytes.subarray(off, off + n));
      pendingChunks.off += n;
      Atomics.store(ctrl, 1, n);
      Atomics.store(ctrl, 2, pendingChunks.off < bytes.length ? 1 : 0);
      Atomics.store(ctrl, 0, 1);
      Atomics.notify(ctrl, 0);
    };

    const promise = new Promise((resolve) => {
      let finished = false;
      const finish = (res) => {
        if (finished) return; finished = true;
        if (res.killed) rec.pending = [];
        // ロックは実行の終わりで解放される。未反映の書込みは少し遅れて反映される（仮定 A-82：最悪の場合）
        this._releaseAll(rec);
        rec.wallMs = Number(process.hrtime.bigint() - rec.t0) / 1e6;
        worker.terminate().catch(() => {});
        const complete = () => {
          this.live.delete(execId);
          const metrics = {
            wallMs: round(rec.wallMs), estGasMs: round(rec.estMs), ops: rec.ops,
            lockWaitMs: round(rec.lockWaits.reduce((a, b) => a + b, 0)), lockAcquisitions: rec.lockWaits.length,
          };
          const out = { ...res, execId, fn, kind, user, logs: rec.logs, metrics };
          this.executions.push({ execId, fn, kind, user, ok: res.ok, error: res.error, metrics, startedAt: rec.startedAt });
          resolve(out);
        };
        if (!rec.pending.length) { complete(); return; }
        const { max = 0 } = this.faults.latency || this.latency;
        setTimeout(() => {
          try { this._flush(rec); } catch (e) { this.warnings.push({ execId, fn, code: 'FLUSH_AT_END_FAILED', message: e.message }); }
          complete();
        }, this.commitDelayMs ?? Math.max(30, max * 10));
      };
      worker.on('message', async (m) => {
        if (m.t === 'ready') return readyResolve();
        if (m.t === 'log') { rec.logs.push(m.line); return; }
        if (m.t === 'warn') { this.warnings.push({ execId, fn, ...m.w }); return; }
        if (m.t === 'more') return sendChunk();
        if (m.t === 'done') return finish(m.res.ok ? { ok: true, value: m.res.value === undefined ? undefined : decode(m.res.value), raw: m.res } : { ok: false, error: m.res.error });
        if (m.t === 'call') {
          let reply;
          try {
            const v = await this._handle(m.op, decode(m.args), rec);
            reply = encode({ ok: true, v: v === undefined ? null : v });
          } catch (e) {
            if (e && e.kill) { finish({ ok: false, killed: true, error: { name: 'Terminated', message: e.message } }); return; }
            reply = encode({ ok: false, e: { name: e.name || 'Error', message: e.message } });
          }
          respond(reply);
        }
      });
      worker.on('error', (e) => finish({ ok: false, error: { name: e.name, message: e.message, stack: e.stack } }));
      worker.on('exit', (code) => finish({ ok: false, error: { name: 'WorkerExit', message: `execution ended unexpectedly (code ${code})` } }));
    });
    const go = () => { Atomics.store(ctrl, 3, 1); Atomics.notify(ctrl, 3); };
    if (!barrier) readyResolve();
    return { ready, go, promise };
  }

  async _delay() {
    const { min = 0, max = 0 } = this.faults.latency || this.latency;
    if (max <= 0) return;
    const ms = min + (max - min) * this.rand();
    await new Promise((r) => setTimeout(r, ms));
  }

  _count(rec, op) {
    rec.ops[op] = (rec.ops[op] || 0) + 1;
    rec.estMs += this.cost[op] ?? this.cost.default ?? 0;
  }

  _faultFor(name, rec) {
    const f = this.faults[name];
    if (!f) return null;
    if (f.fn && f.fn !== rec.fn) return null;
    return f;
  }

  async _handle(op, a, rec) {
    const st = this.store;
    this._count(rec, op);
    if (op.startsWith('sh.') || op.startsWith('ss.')) await this._delay();
    const isWrite = ['sh.set', 'sh.append', 'sh.clear', 'sh.insertRows', 'sh.deleteRows', 'ss.insertSheet', 'ss.deleteSheet', 'sh.fmt'].includes(op);
    if (isWrite) {
      rec.writes++;
      const fw = this._faultFor('sheetWrite', rec);
      if (fw && fw.failAt === rec.writes) {
        throw new GasError(`Service Spreadsheets timed out while accessing document with id ${a.id}.`);
      }
    }
    let result;
    // 書込みの遅延（仮定 A-82）：実GASはシートへの書込みをまとめて後で反映することがある。
    // 同じ実行の読取り・flush()・実行終了で反映されるが、ロックの解放では反映されない。
    // そのため flush() せずにロックを解放すると、次の実行が古い内容を読みうる。最悪の場合に合わせて再現する。
    if (this.deferWrites && DEFERRABLE.includes(op)) {
      if (op !== 'sh.append') { // 範囲の検査は呼んだ時点で行う（実GASも getRange の時点で範囲外エラーになる）
        const sh = st.sheet(a.id, a.sheetId);
        const extra = rec.pending.filter((p) => p.op === 'sh.append' && p.a.sheetId === a.sheetId).length;
        const nr = op === 'sh.set' ? a.values.length : op === 'sh.fmt' ? a.formats.length : a.nr;
        const nc = op === 'sh.set' ? (a.values[0] || []).length : op === 'sh.fmt' ? a.formats[0].length : a.nc;
        const saved = sh.maxRows;
        sh.maxRows = Math.max(saved, st.dims(a.id, a.sheetId).lastRow + extra);
        try { st._check(sh, a.r, a.c, nr, nc); } finally { sh.maxRows = saved; }
      }
      rec.pending.push({ op, a });
      const fk0 = this._faultFor('terminateAfterWrite', rec);
      if (fk0 && fk0.at === rec.writes) { const e = new Error(`harness: execution terminated after write #${rec.writes} (fault terminateAfterWrite)`); e.kill = true; throw e; }
      return null;
    }
    if (op === 'ss.flush') { this._flush(rec); return null; }
    // 同じ実行がシートの内容を読む・構造を変えるときは、先に自分の未反映の書込みを反映する
    if (FLUSHING.includes(op)) this._flush(rec);
    switch (op) {
      case 'ss.open': st.book(a.id); return st.meta(a.id);
      case 'ss.active':
        if (['client', 'doGet', 'trigger'].includes(rec.kind)) {
          this.warnings.push({ execId: rec.execId, fn: rec.fn, code: 'ACTIVE_SPREADSHEET', message: 'Webアプリ/トリガーの処理で getActiveSpreadsheet() が使われた（要件7.2：設定したIDから開くこと）' });
        }
        return this.boundSpreadsheetId ? st.meta(this.boundSpreadsheetId) : null;
      case 'ss.create': { const id = `SS_${crypto.randomUUID().slice(0, 8)}`; st.createSpreadsheet({ id, name: a.name, tz: this.timeZone }); return st.meta(id); }
      case 'ss.meta': return st.meta(a.id);
      case 'ss.insertSheet': return st.insertSheet(a.id, a.name, a.index);
      case 'ss.deleteSheet': return st.deleteSheet(a.id, a.sheetId);
      case 'ss.renameSheet': return st.renameSheet(a.id, a.sheetId, a.name);
      case 'ss.setTz': st.book(a.id).tz = a.tz; return null;
      case 'ss.rename': st.book(a.id).name = a.name; return null;
      case 'sh.dims': return st.dims(a.id, a.sheetId);
      case 'sh.get': return st.getValues(a.id, a.sheetId, a.r, a.c, a.nr, a.nc, a.mode);
      case 'sh.set': st.setValues(a.id, a.sheetId, a.r, a.c, a.values, rec.label); result = null; break;
      case 'sh.append': result = st.appendRow(a.id, a.sheetId, a.row, rec.label); break;
      case 'sh.fmt': st.setFormats(a.id, a.sheetId, a.r, a.c, a.formats); result = null; break;
      case 'sh.clear': st.clear(a.id, a.sheetId, a.r, a.c, a.nr, a.nc, a.contentsOnly); result = null; break;
      case 'sh.insertRows': st.insertRows(a.id, a.sheetId, a.before, a.n); result = null; break;
      case 'sh.deleteRows': st.deleteRows(a.id, a.sheetId, a.start, a.n); result = null; break;
      case 'sh.maxCols': st.setMaxColumns(a.id, a.sheetId, a.n); return null;
      case 'sh.find': return st.find(a.id, a.sheetId, a.r, a.c, a.nr, a.nc, a.text, a.opts);
      case 'sh.frozen': st.setFrozenRows(a.id, a.sheetId, a.n); return null;
      case 'sh.hidden': st.setHidden(a.id, a.sheetId, a.hidden); return null;
      case 'lock.acquire': return this._lockAcquire(a, rec);
      case 'lock.release': this._lockRelease(a.key, rec); return null;
      case 'lock.has': return this.locks.get(a.key)?.holder === rec.execId;
      case 'props': return this._props(a, rec);
      case 'cache': return this._cache(a, rec);
      case 'mail.send': return this._mail(a, rec);
      case 'mail.quota': return Math.max(0, this.mailQuota - this.mailSentToday);
      case 'trigger.create': return this._triggerCreate(a, rec);
      case 'trigger.list': return this.triggers.map((t) => ({ id: t.id, fn: t.fn, type: t.type }));
      case 'trigger.delete': this.triggers = this.triggers.filter((t) => t.id !== a.id); return null;
      case 'util.uuid': return crypto.randomUUID();
      case 'util.digest': return [...crypto.createHash(a.alg).update(Buffer.from(a.bytes.map((b) => b & 255))).digest()].map((b) => (b > 127 ? b - 256 : b));
      case 'util.hmac': return [...crypto.createHmac(a.alg, Buffer.from(a.key.map((b) => b & 255))).update(Buffer.from(a.bytes.map((b) => b & 255))).digest()].map((b) => (b > 127 ? b - 256 : b));
      case 'warn': this.warnings.push({ execId: rec.execId, fn: rec.fn, ...a }); return null;
      default: throw new GasError(`harness: unknown host op ${op}`);
    }
    // 書き込み後に実行を強制終了する障害（処理途中での停止を再現）
    const fk = this._faultFor('terminateAfterWrite', rec);
    if (isWrite && fk && fk.at === rec.writes) {
      const e = new Error(`harness: execution terminated after write #${rec.writes} (fault terminateAfterWrite)`); e.kill = true; throw e;
    }
    return result;
  }

  _flush(rec) {
    const q = rec.pending.splice(0);
    for (const { op, a } of q) {
      const st = this.store;
      if (op === 'sh.set') st.setValues(a.id, a.sheetId, a.r, a.c, a.values, rec.label);
      else if (op === 'sh.append') st.appendRow(a.id, a.sheetId, a.row, rec.label);
      else if (op === 'sh.fmt') st.setFormats(a.id, a.sheetId, a.r, a.c, a.formats);
      else if (op === 'sh.clear') st.clear(a.id, a.sheetId, a.r, a.c, a.nr, a.nc, a.contentsOnly);
    }
  }

  // ---------- LockService ----------
  _lockAcquire(a, rec) {
    const f = this._faultFor('lock', rec);
    if (f && f.mode === 'timeout') return Promise.resolve(false);
    const key = a.key;
    let L = this.locks.get(key);
    if (!L) { L = { holder: null, queue: [] }; this.locks.set(key, L); }
    const t0 = process.hrtime.bigint();
    if (L.holder === rec.execId) { rec.lockWaits.push(0); return Promise.resolve(true); }
    if (!L.holder) { L.holder = rec.execId; rec.locksHeld.add(key); rec.lockWaits.push(0); return Promise.resolve(true); }
    if (!a.timeoutMs) { rec.lockWaits.push(0); return Promise.resolve(false); }
    return new Promise((resolve) => {
      const entry = {
        rec,
        resolve: (ok) => { rec.lockWaits.push(Number(process.hrtime.bigint() - t0) / 1e6); resolve(ok); },
      };
      entry.timer = setTimeout(() => { L.queue = L.queue.filter((x) => x !== entry); entry.resolve(false); }, Math.min(a.timeoutMs, 300000));
      L.queue.push(entry);
    });
  }

  _lockRelease(key, rec) {
    const L = this.locks.get(key);
    if (!L || L.holder !== rec.execId) return;
    rec.locksHeld.delete(key);
    L.holder = null;
    const next = L.queue.shift();
    if (next) {
      clearTimeout(next.timer);
      L.holder = next.rec.execId; next.rec.locksHeld.add(key);
      next.resolve(true);
    }
  }

  _releaseAll(rec) { for (const k of [...rec.locksHeld]) this._lockRelease(k, rec); }

  // ---------- Properties / Cache ----------
  _props(a, rec) {
    let m;
    if (a.scope === 'script') m = this.props.script;
    else if (a.scope === 'user') {
      const u = rec.user || '(anonymous)';
      if (!this.props.user.has(u)) this.props.user.set(u, new Map());
      m = this.props.user.get(u);
    } else m = this.props.document;
    switch (a.op) {
      case 'get': return m.has(a.key) ? m.get(a.key) : null;
      case 'getAll': return Object.fromEntries(m);
      case 'keys': return [...m.keys()];
      case 'set': {
        const v = String(a.value);
        if (Buffer.byteLength(v) > 9 * 1024) throw new GasError('Argument too large: value');
        m.set(String(a.key), v); return null;
      }
      case 'setAll': if (a.deleteOthers) m.clear(); for (const [k, v] of Object.entries(a.values)) m.set(k, String(v)); return null;
      case 'delete': m.delete(a.key); return null;
      case 'deleteAll': m.clear(); return null;
      default: throw new GasError('bad props op');
    }
  }

  _cache(a, rec) {
    const scope = a.scope === 'user' ? `user:${rec.user}` : a.scope;
    const k = (key) => `${scope}|${key}`;
    const now = this.now();
    const get = (key) => { const e = this.cache.get(k(key)); if (!e || e.exp < now) return null; return e.v; };
    switch (a.op) {
      case 'get': return get(a.key);
      case 'getAll': return Object.fromEntries(a.keys.map((x) => [x, get(x)]).filter(([, v]) => v !== null));
      case 'put': {
        if (String(a.key).length > 250) throw new GasError('Argument too large: key');
        if (Buffer.byteLength(String(a.value)) > 100 * 1024) throw new GasError('Argument too large: value');
        const ttl = Math.min(a.ttl ?? 600, 21600);
        this.cache.set(k(a.key), { v: String(a.value), exp: now + ttl * 1000 }); return null;
      }
      case 'putAll': for (const [kk, v] of Object.entries(a.values)) this.cache.set(k(kk), { v: String(v), exp: now + Math.min(a.ttl ?? 600, 21600) * 1000 }); return null;
      case 'remove': this.cache.delete(k(a.key)); return null;
      case 'removeAll': for (const x of a.keys) this.cache.delete(k(x)); return null;
      default: throw new GasError('bad cache op');
    }
  }

  // ---------- Mail ----------
  _mail(a, rec) {
    const attempt = { at: this.now(), execId: rec.execId, to: a.to, subject: a.subject, ok: false };
    this.mailAttempts.push(attempt);
    const f = this._faultFor('mail', rec);
    if (f) {
      if (f.failAll || (f.failNext && f.failNext > 0)) {
        if (f.failNext) f.failNext--;
        attempt.error = f.message || 'Service unavailable: Gmail';
        throw new GasError(attempt.error);
      }
    }
    if (!a.to || !String(a.to).trim()) { attempt.error = 'Failed to send email: no recipient'; throw new GasError(attempt.error); }
    for (const addr of String(a.to).split(',').map((s) => s.trim())) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) { attempt.error = `Invalid email: ${addr}`; throw new GasError(attempt.error); }
    }
    const n = String(a.to).split(',').length;
    if (this.mailSentToday + n > this.mailQuota) { attempt.error = 'Service invoked too many times for one day: email.'; throw new GasError(attempt.error); }
    this.mailSentToday += n;
    attempt.ok = true;
    this.outbox.push({ ...a, at: this.now(), execId: rec.execId });
    return null;
  }

  // ---------- Triggers ----------
  _triggerCreate(a, rec) {
    if (this.triggers.length >= 20) throw new GasError('This script has too many triggers. Triggers must be deleted from the script before more can be added.');
    const id = String(Math.floor(this.rand() * 1e15));
    const t = { id, fn: a.fn, type: a.type, owner: this.owner };
    if (a.type === 'after') t.dueAt = this.now() + Math.max(a.ms, 0);
    else if (a.type === 'every') { t.everyMs = a.ms; t.dueAt = this.now() + a.ms; } else t.dueAt = Infinity;
    this.triggers.push(t);
    void rec;
    return { id, fn: a.fn, type: a.type };
  }

  /** 期限の来た時間主導トリガーを実行する。仮想時計を進めてから呼ぶ。 */
  async fireDueTriggers() {
    const due = this.triggers.filter((t) => t.dueAt <= this.now());
    const results = [];
    for (const t of due) {
      if (t.type === 'after') this.triggers = this.triggers.filter((x) => x !== t);
      else t.dueAt = this.now() + t.everyMs;
      results.push(await this.run(t.fn, [{ triggerUid: t.id, authMode: 'FULL' }], { kind: 'trigger' }));
    }
    return results;
  }

  /** 試験終了時に、各シートを CSV で書き出す（人とAIが中身を目視確認するため） */
  exportCsv(dir) {
    fs.mkdirSync(dir, { recursive: true });
    for (const b of this.store.books.values()) {
      for (const s of b.sheets) {
        fs.writeFileSync(path.join(dir, `${b.id}__${s.name}.csv`.replace(/[\\/:*?"<>|]/g, '_')), this.store.toCsv(b.id, s.sheetId));
      }
    }
  }

  async close() {
    for (const { worker } of this.live.values()) await worker.terminate().catch(() => {});
    this.live.clear();
  }
}

const DEFERRABLE = ['sh.set', 'sh.append', 'sh.clear', 'sh.fmt'];
const FLUSHING = ['sh.get', 'sh.dims', 'sh.find', 'sh.insertRows', 'sh.deleteRows', 'sh.maxCols', 'ss.insertSheet', 'ss.deleteSheet', 'ss.renameSheet'];

function round(n) { return Math.round(n * 10) / 10; }

module.exports = { GasHost, encode, decode, loadProject };
