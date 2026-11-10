// GAS の組込みサービスの模擬（GAS コンテキスト内で動く）。
// 実データはホスト側にあり、操作ごとに __H.host() で同期的に問い合わせる。
// ここに無いメソッドを呼ぶと TypeError になる。必要なら追加し、ASSUMPTIONS.md に根拠を書くこと。
(function () {
  'use strict';
  const { env, host, warn, enc, dec, RealDate } = __H;
  const G = globalThis;
  const isDate = (v) => v instanceof RealDate;

  // ---------------------------------------------------------------- A1 表記
  function colToNum(s) { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
  function numToCol(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function parseA1(a1) {
    let sheetName = null; let ref = String(a1).trim();
    const bang = ref.lastIndexOf('!');
    if (bang >= 0) { sheetName = ref.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'"); ref = ref.slice(bang + 1); }
    const parts = ref.split(':');
    const cell = (p) => {
      const m = p.match(/^\$?([A-Za-z]*)\$?(\d*)$/);
      if (!m || (!m[1] && !m[2])) throw new Error(`Range not found`);
      return { c: m[1] ? colToNum(m[1]) : null, r: m[2] ? +m[2] : null };
    };
    const a = cell(parts[0]); const b = parts[1] ? cell(parts[1]) : a;
    return { sheetName, r1: a.r, c1: a.c, r2: b.r, c2: b.c };
  }

  // ---------------------------------------------------------------- SpreadsheetApp
  class Spreadsheet {
    constructor(meta) { this._id = meta.id; this._name = meta.name; }
    getId() { return this._id; }
    getName() { return host('ss.meta', { id: this._id }).name; }
    rename(n) { host('ss.rename', { id: this._id, name: n }); }
    getUrl() { return `https://docs.google.com/spreadsheets/d/${this._id}/edit`; }
    getSheets() { return host('ss.meta', { id: this._id }).sheets.map((s) => new Sheet(this, s.sheetId, s.name)); }
    getSheetByName(name) { const s = host('ss.meta', { id: this._id }).sheets.find((x) => x.name === name); return s ? new Sheet(this, s.sheetId, s.name) : null; }
    getSheetById(id) { const s = host('ss.meta', { id: this._id }).sheets.find((x) => x.sheetId === id); return s ? new Sheet(this, s.sheetId, s.name) : null; }
    getActiveSheet() { return this.getSheets()[0]; }
    insertSheet(a, b) {
      let name; let index;
      if (typeof a === 'string') { name = a; if (typeof b === 'number') index = b; } else if (typeof a === 'number') index = a;
      const sheetId = host('ss.insertSheet', { id: this._id, name, index });
      return this.getSheetById(sheetId);
    }
    deleteSheet(sheet) { host('ss.deleteSheet', { id: this._id, sheetId: sheet.getSheetId() }); }
    getSpreadsheetTimeZone() { return host('ss.meta', { id: this._id }).tz; }
    setSpreadsheetTimeZone(tz) { host('ss.setTz', { id: this._id, tz }); }
    getRange(a1) {
      const p = parseA1(a1);
      const sh = p.sheetName ? this.getSheetByName(p.sheetName) : this.getActiveSheet();
      if (!sh) throw new Error('Range not found');
      return sh.getRange(a1.slice(a1.lastIndexOf('!') + 1));
    }
    toast() {}
    getOwner() { return { getEmail: () => '' }; }
    addEditor() { return this; }
    removeEditor() { return this; }
    getEditors() { return []; }
  }

  class Sheet {
    constructor(ss, sheetId, name) { this._ss = ss; this._sid = sheetId; this._name = name; }
    _a(extra) { return Object.assign({ id: this._ss._id, sheetId: this._sid }, extra); }
    _dims() { return host('sh.dims', this._a()); }
    getParent() { return this._ss; }
    getSheetId() { return this._sid; }
    getName() { return host('ss.meta', { id: this._ss._id }).sheets.find((s) => s.sheetId === this._sid)?.name ?? this._name; }
    setName(n) { host('ss.renameSheet', this._a({ name: n })); this._name = n; return this; }
    getIndex() { return this._dims().index; }
    getLastRow() { return this._dims().lastRow; }
    getLastColumn() { return this._dims().lastCol; }
    getMaxRows() { return this._dims().maxRows; }
    getMaxColumns() { return this._dims().maxCols; }
    getFrozenRows() { return this._dims().frozenRows; }
    setFrozenRows(n) { host('sh.frozen', this._a({ n })); return this; }
    hideSheet() { host('sh.hidden', this._a({ hidden: true })); return this; }
    showSheet() { host('sh.hidden', this._a({ hidden: false })); return this; }
    isSheetHidden() { return this._dims().hidden; }
    getRange(a, b, c, d) {
      if (typeof a === 'string') {
        const p = parseA1(a);
        let { r1, c1, r2, c2 } = p;
        if (r1 === null || c1 === null) {
          const dm = this._dims();
          if (r1 === null) { r1 = 1; r2 = dm.maxRows; }
          if (c1 === null) { c1 = 1; c2 = dm.maxCols; }
        }
        return new Range(this, Math.min(r1, r2), Math.min(c1, c2), Math.abs(r2 - r1) + 1, Math.abs(c2 - c1) + 1);
      }
      if (typeof a !== 'number' || typeof b !== 'number' || isNaN(a) || isNaN(b)) {
        throw new Error(`The parameters (${[a, b, c, d].filter((x) => x !== undefined).map((x) => (typeof x === 'number' ? 'number' : x === null ? 'null' : typeof x === 'string' ? 'String' : typeof x)).join(',')}) don't match the method signature for SpreadsheetApp.Sheet.getRange.`);
      }
      const nr = c === undefined ? 1 : c; const nc = d === undefined ? 1 : d;
      if (a < 1) throw new Error('The starting row of the range is too small.');
      if (b < 1) throw new Error('The starting column of the range is too small.');
      if (nr < 1) throw new Error('The number of rows in the range must be at least 1.');
      if (nc < 1) throw new Error('The number of columns in the range must be at least 1.');
      return new Range(this, a, b, nr, nc);
    }
    getDataRange() { const d = this._dims(); return new Range(this, 1, 1, Math.max(d.lastRow, 1), Math.max(d.lastCol, 1)); }
    appendRow(row) {
      if (!Array.isArray(row)) throw new Error("The parameters (String) don't match the method signature for SpreadsheetApp.Sheet.appendRow.");
      host('sh.append', this._a({ row })); return this;
    }
    insertRowsAfter(after, n) { host('sh.insertRows', this._a({ before: after + 1, n })); return this; }
    insertRowAfter(after) { return this.insertRowsAfter(after, 1); }
    insertRowsBefore(before, n) { host('sh.insertRows', this._a({ before, n })); return this; }
    insertRowBefore(before) { return this.insertRowsBefore(before, 1); }
    insertRows(before, n = 1) { return this.insertRowsBefore(before, n); }
    deleteRow(r) { host('sh.deleteRows', this._a({ start: r, n: 1 })); return this; }
    deleteRows(r, n) { host('sh.deleteRows', this._a({ start: r, n })); return this; }
    clear() { const d = this._dims(); host('sh.clear', this._a({ r: 1, c: 1, nr: d.maxRows, nc: d.maxCols, contentsOnly: false })); return this; }
    clearContents() { const d = this._dims(); host('sh.clear', this._a({ r: 1, c: 1, nr: d.maxRows, nc: d.maxCols, contentsOnly: true })); return this; }
    createTextFinder(text) { const d = this._dims(); return new TextFinder(new Range(this, 1, 1, Math.max(d.lastRow, 1), Math.max(d.lastCol, 1)), text); }
    protect() { return protectionStub(); }
    getProtections() { return []; }
    activate() { return this; }
  }
  for (const m of ['autoResizeColumns', 'autoResizeColumn', 'setColumnWidth', 'setColumnWidths', 'setRowHeight', 'setRowHeights', 'setTabColor', 'hideColumns', 'showColumns', 'hideRows', 'showRows', 'setConditionalFormatRules', 'setFrozenColumns']) {
    Sheet.prototype[m] = function () { return this; };
  }

  function protectionStub() {
    const p = {};
    for (const m of ['setDescription', 'setWarningOnly', 'addEditor', 'addEditors', 'removeEditor', 'removeEditors', 'setDomainEdit', 'setUnprotectedRanges']) p[m] = () => p;
    p.getEditors = () => []; p.canEdit = () => true; p.remove = () => {};
    return p;
  }

  class Range {
    constructor(sheet, r, c, nr, nc) { this._sh = sheet; this._r = r; this._c = c; this._nr = nr; this._nc = nc; }
    _a(extra) { return this._sh._a(Object.assign({ r: this._r, c: this._c, nr: this._nr, nc: this._nc }, extra)); }
    getSheet() { return this._sh; }
    getRow() { return this._r; }
    getColumn() { return this._c; }
    getLastRow() { return this._r + this._nr - 1; }
    getLastColumn() { return this._c + this._nc - 1; }
    getNumRows() { return this._nr; }
    getNumColumns() { return this._nc; }
    getHeight() { return this._nr; }
    getWidth() { return this._nc; }
    getA1Notation() {
      const a = `${numToCol(this._c)}${this._r}`;
      return this._nr === 1 && this._nc === 1 ? a : `${a}:${numToCol(this.getLastColumn())}${this.getLastRow()}`;
    }
    getValues() { return host('sh.get', this._a({ mode: 'values' })); }
    getValue() { return host('sh.get', this._a({ nr: 1, nc: 1, mode: 'values' }))[0][0]; }
    getDisplayValues() { return host('sh.get', this._a({ mode: 'display' })); }
    getDisplayValue() { return host('sh.get', this._a({ nr: 1, nc: 1, mode: 'display' }))[0][0]; }
    getFormulas() { return host('sh.get', this._a({ mode: 'formulas' })); }
    getFormula() { return this.getFormulas()[0][0]; }
    getNumberFormats() { return host('sh.get', this._a({ mode: 'formats' })); }
    getNumberFormat() { return this.getNumberFormats()[0][0]; }
    setValues(values) {
      if (!Array.isArray(values) || (values.length && !Array.isArray(values[0]))) {
        throw new Error("The parameters (number[]) don't match the method signature for SpreadsheetApp.Range.setValues.");
      }
      if (values.length !== this._nr) throw new Error(`The number of rows in the data does not match the number of rows in the range. The data has ${values.length} but the range has ${this._nr}.`);
      for (const row of values) {
        if (row.length !== this._nc) throw new Error(`The number of columns in the data does not match the number of columns in the range. The data has ${row.length} but the range has ${this._nc}.`);
      }
      host('sh.set', this._a({ values })); return this;
    }
    setValue(v) {
      const values = Array.from({ length: this._nr }, () => Array.from({ length: this._nc }, () => v));
      host('sh.set', this._a({ values })); return this;
    }
    setFormula(f) { return this.setValue(f); }
    setNumberFormat(f) { return this.setNumberFormats(Array.from({ length: this._nr }, () => Array.from({ length: this._nc }, () => f))); }
    setNumberFormats(f) { host('sh.fmt', this._a({ formats: f })); return this; }
    clearContent() { host('sh.clear', this._a({ contentsOnly: true })); return this; }
    clear() { host('sh.clear', this._a({ contentsOnly: false })); return this; }
    offset(dr, dc, nr, nc) { return new Range(this._sh, this._r + dr, this._c + dc, nr ?? this._nr, nc ?? this._nc); }
    getCell(r, c) { return new Range(this._sh, this._r + r - 1, this._c + c - 1, 1, 1); }
    isBlank() { return this.getValues().every((row) => row.every((v) => v === '')); }
    createTextFinder(text) { return new TextFinder(this, text); }
    protect() { return protectionStub(); }
    activate() { return this; }
  }
  for (const m of ['setFontWeight', 'setFontWeights', 'setBackground', 'setBackgrounds', 'setFontColor', 'setFontColors', 'setHorizontalAlignment', 'setVerticalAlignment', 'setWrap', 'setWrapStrategy', 'setBorder', 'setDataValidation', 'setDataValidations', 'setNote', 'setNotes', 'merge', 'breakApart', 'setFontSize', 'setFontFamily', 'setFontStyle', 'setTextStyle', 'setShowHyperlink']) {
    Range.prototype[m] = function () { return this; };
  }

  class TextFinder {
    constructor(range, text) { this._range = range; this._text = String(text); this._opts = { entire: false, matchCase: false, regex: false }; this._hits = null; this._i = 0; }
    matchEntireCell(b) { this._opts.entire = !!b; return this; }
    matchCase(b) { this._opts.matchCase = !!b; return this; }
    useRegularExpression(b) { this._opts.regex = !!b; return this; }
    matchFormulaText() { return this; }
    ignoreDiacritics() { return this; }
    _load() { if (!this._hits) this._hits = host('sh.find', this._range._a({ text: this._text, opts: this._opts })); }
    findAll() { this._load(); return this._hits.map(([r, c]) => new Range(this._range._sh, r, c, 1, 1)); }
    findNext() { this._load(); const h = this._hits[this._i++]; return h ? new Range(this._range._sh, h[0], h[1], 1, 1) : null; }
    findPrevious() { this._load(); this._i = Math.max(0, this._i - 2); return this.findNext(); }
  }

  G.SpreadsheetApp = {
    openById(id) {
      if (typeof id !== 'string' || !id) throw new Error('Invalid argument: id');
      return new Spreadsheet(host('ss.open', { id }));
    },
    openByUrl(url) { const m = String(url).match(/\/d\/([^/]+)/); if (!m) throw new Error('Invalid argument: url'); return this.openById(m[1]); },
    getActiveSpreadsheet() { const m = host('ss.active'); return m ? new Spreadsheet(m) : null; },
    getActive() { return this.getActiveSpreadsheet(); },
    create(name) { return new Spreadsheet(host('ss.create', { name })); },
    flush() { host('ss.flush'); },
    getUi() { throw new Error('Cannot call SpreadsheetApp.getUi() from this context.'); },
    newDataValidation() {
      const b = {}; for (const m of ['requireValueInList', 'requireNumberBetween', 'requireDate', 'setAllowInvalid', 'setHelpText', 'requireCheckbox']) b[m] = () => b;
      b.build = () => ({}); return b;
    },
    BorderStyle: {}, WrapStrategy: {},
  };

  // ---------------------------------------------------------------- LockService
  class Lock {
    constructor(key) { this._key = key; }
    tryLock(ms) { return host('lock.acquire', { key: this._key, timeoutMs: Math.max(0, +ms || 0) }); }
    waitLock(ms) {
      if (!host('lock.acquire', { key: this._key, timeoutMs: Math.max(0, +ms || 0) })) {
        throw new Error('Lock timeout: another process was holding the lock for too long.');
      }
    }
    releaseLock() { host('lock.release', { key: this._key }); }
    hasLock() { return host('lock.has', { key: this._key }); }
  }
  G.LockService = {
    getScriptLock: () => new Lock('script'),
    getUserLock: () => new Lock(`user:${env.tempKey}`),
    getDocumentLock: () => (env.boundSpreadsheetId ? new Lock('document') : null),
  };

  // ---------------------------------------------------------------- Properties / Cache
  class Props {
    constructor(scope) { this._s = scope; }
    getProperty(k) { return host('props', { scope: this._s, op: 'get', key: String(k) }); }
    getProperties() { return host('props', { scope: this._s, op: 'getAll' }); }
    getKeys() { return host('props', { scope: this._s, op: 'keys' }); }
    setProperty(k, v) { host('props', { scope: this._s, op: 'set', key: String(k), value: v }); return this; }
    setProperties(values, deleteOthers) { host('props', { scope: this._s, op: 'setAll', values, deleteOthers: !!deleteOthers }); return this; }
    deleteProperty(k) { host('props', { scope: this._s, op: 'delete', key: String(k) }); return this; }
    deleteAllProperties() { host('props', { scope: this._s, op: 'deleteAll' }); return this; }
  }
  G.PropertiesService = {
    getScriptProperties: () => new Props('script'),
    getUserProperties: () => new Props('user'),
    getDocumentProperties: () => (env.boundSpreadsheetId ? new Props('document') : null),
  };
  class Cache {
    constructor(scope) { this._s = scope; }
    get(k) { return host('cache', { scope: this._s, op: 'get', key: String(k) }); }
    getAll(keys) { return host('cache', { scope: this._s, op: 'getAll', keys }); }
    put(k, v, ttl) { host('cache', { scope: this._s, op: 'put', key: String(k), value: v, ttl }); }
    putAll(values, ttl) { host('cache', { scope: this._s, op: 'putAll', values, ttl }); }
    remove(k) { host('cache', { scope: this._s, op: 'remove', key: String(k) }); }
    removeAll(keys) { host('cache', { scope: this._s, op: 'removeAll', keys }); }
  }
  G.CacheService = {
    getScriptCache: () => new Cache('script'),
    getUserCache: () => new Cache('user'),
    getDocumentCache: () => (env.boundSpreadsheetId ? new Cache('document') : null),
  };

  // ---------------------------------------------------------------- Session
  G.Session = {
    getActiveUser: () => ({ getEmail: () => env.activeUser || '', toString: () => env.activeUser || '' }),
    getEffectiveUser: () => ({ getEmail: () => env.effectiveUser || '', toString: () => env.effectiveUser || '' }),
    getScriptTimeZone: () => env.timeZone,
    getActiveUserLocale: () => 'ja',
    getTemporaryActiveUserKey: () => env.tempKey,
  };

  // ---------------------------------------------------------------- Mail
  function normMail(a, b, c, d) {
    if (a && typeof a === 'object') return { to: a.to, subject: a.subject, body: a.body || '', htmlBody: a.htmlBody, name: a.name, replyTo: a.replyTo, cc: a.cc, bcc: a.bcc, noReply: a.noReply };
    return { to: a, subject: b, body: c || '', ...(d || {}) };
  }
  G.MailApp = {
    sendEmail(a, b, c, d) { host('mail.send', normMail(a, b, c, d)); },
    getRemainingDailyQuota: () => host('mail.quota'),
  };
  G.GmailApp = {
    sendEmail(a, b, c, d) { host('mail.send', normMail(a, b, c, d)); return G.GmailApp; },
    search() { throw new Error('harness: GmailApp.search はエミュレートされていない'); },
  };

  // ---------------------------------------------------------------- ScriptApp
  class TriggerObj {
    constructor(t) { this._t = t; }
    getUniqueId() { return this._t.id; }
    getHandlerFunction() { return this._t.fn; }
    getEventType() { return this._t.type === 'event' ? 'ON_EVENT' : 'CLOCK'; }
    getTriggerSource() { return this._t.type === 'event' ? 'SPREADSHEETS' : 'CLOCK'; }
  }
  function clockBuilder(fn) {
    let spec = null;
    const b = {
      after(ms) { spec = { type: 'after', ms }; return b; },
      everyMinutes(n) { if (![1, 5, 10, 15, 30].includes(n)) throw new Error('The value passed to everyMinutes must be one of 1, 5, 10, 15, or 30.'); spec = { type: 'every', ms: n * 60000 }; return b; },
      everyHours(n) { spec = { type: 'every', ms: n * 3600000 }; return b; },
      everyDays(n) { spec = { type: 'every', ms: n * 86400000 }; return b; },
      everyWeeks(n) { spec = { type: 'every', ms: n * 7 * 86400000 }; return b; },
      atHour() { return b; }, nearMinute() { return b; }, inTimezone() { return b; }, onWeekDay() { return b; }, at() { spec = { type: 'after', ms: 0 }; return b; },
      create() { if (!spec) throw new Error('harness: trigger schedule not set'); return new TriggerObj(host('trigger.create', { fn, ...spec })); },
    };
    return b;
  }
  G.ScriptApp = {
    newTrigger(fn) {
      if (typeof fn !== 'string') throw new Error('Invalid argument: functionName');
      const ev = () => ({ create: () => new TriggerObj(host('trigger.create', { fn, type: 'event', ms: 0 })) });
      return {
        timeBased: () => clockBuilder(fn),
        forSpreadsheet: () => ({ onEdit: ev, onOpen: ev, onChange: ev, onFormSubmit: ev }),
        forForm: () => ({ onFormSubmit: ev, onOpen: ev }),
      };
    },
    getProjectTriggers: () => host('trigger.list').map((t) => new TriggerObj(t)),
    getUserTriggers: () => host('trigger.list').map((t) => new TriggerObj(t)),
    deleteTrigger(t) { host('trigger.delete', { id: t.getUniqueId() }); },
    getService: () => ({ getUrl: () => env.webUrl, isEnabled: () => true }),
    getScriptId: () => 'HARNESS_SCRIPT_ID',
    getOAuthToken: () => 'harness-oauth-token',
    AuthMode: { NONE: 'NONE', CUSTOM_FUNCTION: 'CUSTOM_FUNCTION', LIMITED: 'LIMITED', FULL: 'FULL' },
    WeekDay: { MONDAY: 'MONDAY', TUESDAY: 'TUESDAY', WEDNESDAY: 'WEDNESDAY', THURSDAY: 'THURSDAY', FRIDAY: 'FRIDAY', SATURDAY: 'SATURDAY', SUNDAY: 'SUNDAY' },
  };

  // ---------------------------------------------------------------- Utilities
  const WD_SHORT = { Sun: 'Sun', Mon: 'Mon', Tue: 'Tue', Wed: 'Wed', Thu: 'Thu', Fri: 'Fri', Sat: 'Sat' };
  const WD_LONG = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const fmtCache = {};
  function zparts(ms, tz) {
    if (!fmtCache[tz]) {
      fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', timeZoneName: 'short' });
    }
    const o = {}; for (const p of fmtCache[tz].formatToParts(new RealDate(ms))) o[p.type] = p.value;
    const p = { y: +o.year, M: +o.month, d: +o.day, H: +o.hour, m: +o.minute, s: +o.second, S: ((ms % 1000) + 1000) % 1000, E: o.weekday, z: o.timeZoneName };
    const asUtc = RealDate.UTC(p.y, p.M - 1, p.d, p.H, p.m, p.s);
    p.off = Math.round((asUtc - (ms - p.S)) / 60000);
    return p;
  }
  const pad = (n, w) => String(n).padStart(w, '0');
  function formatDate(date, tz, fmt) {
    if (!isDate(date)) throw new Error("The parameters (" + typeof date + ",String,String) don't match the method signature for Utilities.formatDate.");
    if (isNaN(date.getTime())) throw new Error('Invalid argument: date');
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (e) { throw new Error(`Invalid argument: timeZone (${tz})`); }
    const p = zparts(date.getTime(), tz);
    let out = ''; let i = 0;
    while (i < fmt.length) {
      const ch = fmt[i];
      if (ch === "'") {
        const j = fmt.indexOf("'", i + 1);
        if (j === i + 1) { out += "'"; i += 2; continue; }
        out += fmt.slice(i + 1, j < 0 ? fmt.length : j); i = j < 0 ? fmt.length : j + 1; continue;
      }
      if (!/[A-Za-z]/.test(ch)) { out += ch; i++; continue; }
      let n = 1; while (fmt[i + n] === ch) n++;
      const sign = p.off >= 0 ? '+' : '-'; const ao = Math.abs(p.off);
      switch (ch) {
        case 'y': out += n === 2 ? pad(p.y % 100, 2) : pad(p.y, n); break;
        case 'M': out += n >= 4 ? MON[p.M - 1] : n === 3 ? MON[p.M - 1].slice(0, 3) : pad(p.M, n); break;
        case 'd': out += pad(p.d, n); break;
        case 'H': out += pad(p.H, n); break;
        case 'h': out += pad(p.H % 12 || 12, n); break;
        case 'k': out += pad(p.H || 24, n); break;
        case 'm': out += pad(p.m, n); break;
        case 's': out += pad(p.s, n); break;
        case 'S': out += pad(p.S, 3).slice(0, Math.max(n, 3)).padEnd(n, '0').slice(0, n); break;
        case 'E': out += n >= 4 ? WD_LONG[p.E] : WD_SHORT[p.E]; break;
        case 'u': out += String(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.E) + 1); break;
        case 'a': out += p.H < 12 ? 'AM' : 'PM'; break;
        case 'Z': out += sign + pad(Math.floor(ao / 60), 2) + pad(ao % 60, 2); break;
        case 'X': out += p.off === 0 ? 'Z' : n === 1 ? sign + pad(Math.floor(ao / 60), 2) : n === 2 ? sign + pad(Math.floor(ao / 60), 2) + pad(ao % 60, 2) : `${sign}${pad(Math.floor(ao / 60), 2)}:${pad(ao % 60, 2)}`; break;
        case 'z': out += tz === 'Asia/Tokyo' ? 'JST' : p.z; break;
        default: throw new Error(`Illegal pattern character '${ch}'`);
      }
      i += n;
    }
    return out;
  }
  const toBytes = (v) => (Array.isArray(v) ? v : [...unescape(encodeURIComponent(String(v)))].map((c) => { const b = c.charCodeAt(0); return b > 127 ? b - 256 : b; }));
  const fromBytes = (bytes) => decodeURIComponent(escape(bytes.map((b) => String.fromCharCode(b & 255)).join('')));
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  function b64enc(bytes) {
    let s = ''; const u = bytes.map((b) => b & 255);
    for (let i = 0; i < u.length; i += 3) {
      const n = (u[i] << 16) | ((u[i + 1] ?? 0) << 8) | (u[i + 2] ?? 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < u.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < u.length ? B64[n & 63] : '=');
    }
    return s;
  }
  function b64dec(s) {
    s = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    const out = [];
    for (let i = 0; i < s.length; i += 4) {
      const n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
      out.push((n >> 16) & 255); if (s[i + 2] !== undefined && s[i + 2] !== '=') out.push((n >> 8) & 255); if (s[i + 3] !== undefined && s[i + 3] !== '=') out.push(n & 255);
    }
    return out.map((b) => (b > 127 ? b - 256 : b));
  }
  function newBlob(data, contentType, name) {
    let bytes = toBytes(data || '');
    const blob = {
      getBytes: () => bytes.slice(), getDataAsString: () => fromBytes(bytes), getContentType: () => contentType || 'application/octet-stream',
      getName: () => name || null, setName: (n) => { name = n; return blob; }, setBytes: (b) => { bytes = b; return blob; },
      setDataFromString: (s) => { bytes = toBytes(s); return blob; }, copyBlob: () => newBlob(bytes, contentType, name),
    };
    return blob;
  }
  G.Utilities = {
    formatDate,
    formatString: (tmpl, ...args) => { let i = 0; return String(tmpl).replace(/%(\d*\.?\d*)([sdfi%])/g, (m, w, t) => { if (t === '%') return '%'; const v = args[i++]; if (t === 'd' || t === 'i') return String(Math.trunc(v)); if (t === 'f') { const pr = w.includes('.') ? +w.split('.')[1] : 6; return Number(v).toFixed(pr); } return String(v); }); },
    getUuid: () => host('util.uuid'),
    sleep: (ms) => { if (ms > 300000) throw new Error('Invalid argument: milliseconds'); __sleep(ms); },
    computeDigest: (alg, value) => host('util.digest', { alg: alg, bytes: toBytes(value) }),
    computeHmacSha256Signature: (value, key) => host('util.hmac', { alg: 'sha256', bytes: toBytes(value), key: toBytes(key) }),
    base64Encode: (v) => b64enc(toBytes(v)),
    base64EncodeWebSafe: (v) => b64enc(toBytes(v)).replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: (s) => b64dec(s),
    base64DecodeWebSafe: (s) => b64dec(s),
    newBlob,
    parseCsv: (csv, delim = ',') => {
      const rows = []; let row = []; let cur = ''; let q = false; const s = String(csv);
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (q) { if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true;
        else if (ch === delim) { row.push(cur); cur = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; } else cur += ch;
      }
      if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
      return rows;
    },
    DigestAlgorithm: { MD5: 'md5', SHA_1: 'sha1', SHA_256: 'sha256', SHA_384: 'sha384', SHA_512: 'sha512' },
    Charset: { UTF_8: 'UTF_8', US_ASCII: 'US_ASCII' },
  };

  G.Logger = {
    log(fmt, ...args) { const s = args.length ? G.Utilities.formatString(String(fmt), ...args) : (typeof fmt === 'string' ? fmt : JSON.stringify(fmt)); __log(s); return G.Logger; },
    getLog: () => '', clear() {},
  };

  // ---------------------------------------------------------------- HtmlService / ContentService
  class HtmlOutput {
    constructor(content) { this._c = content || ''; this._title = ''; this._meta = []; this._xframe = 'DEFAULT'; this._favicon = null; }
    getContent() { return this._c; }
    setContent(c) { this._c = String(c); return this; }
    append(c) { this._c += String(c); return this; }
    appendUntrusted(c) { this._c += String(c).replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x])); return this; }
    setTitle(t) { this._title = String(t); return this; }
    getTitle() { return this._title; }
    addMetaTag(name, content) {
      const allowed = ['viewport', 'apple-mobile-web-app-capable', 'mobile-web-app-capable', 'google-site-verification'];
      if (!allowed.includes(name)) throw new Error(`Invalid argument: name (${name})`);
      this._meta.push({ name, content }); return this;
    }
    getMetaTags() { return this._meta.map((m) => ({ getName: () => m.name, getContent: () => m.content })); }
    setXFrameOptionsMode(m) { this._xframe = m; return this; }
    setSandboxMode() { return this; }
    setFaviconUrl(u) { this._favicon = u; return this; }
    setWidth() { return this; }
    setHeight() { return this; }
    getAs() { return newBlob(this._c, 'text/html'); }
    getBlob() { return newBlob(this._c, 'text/html'); }
  }
  const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' }[x]));
  const raw = (v) => (v instanceof HtmlOutput ? v.getContent() : (v === undefined || v === null ? '' : String(v)));
  // <?= ?> は文脈に応じてエスケープされる（仮定 A-51）：<script> 内では JavaScript の値として、その他は HTML として。
  const jsEsc = (v) => {
    if (v === undefined) return 'undefined';
    return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  };
  function inScript(src, pos) {
    const before = src.slice(0, pos).toLowerCase();
    return before.lastIndexOf('<script') > before.lastIndexOf('</script');
  }
  function compileTemplate(src) {
    let code = 'var __o=[];with(__t){\n'; const re = /<\?(!=|=)?([\s\S]*?)\?>/g; let last = 0; let m;
    while ((m = re.exec(src))) {
      code += `__o.push(${JSON.stringify(src.slice(last, m.index))});\n`;
      const body = m[2].trim().replace(/;\s*$/, '');
      if (m[1] === '=' && inScript(src, m.index)) code += `__o.push(__jsesc(${body}));\n`;
      else if (m[1] === '=') code += `__o.push(__esc(${body}));\n`;
      else if (m[1] === '!=') code += `__o.push(__raw(${body}));\n`;
      else code += `${m[2]}\n`;
      last = re.lastIndex;
    }
    code += `__o.push(${JSON.stringify(src.slice(last))});}\nreturn __o.join('');`;
    const fn = new Function('__t', '__esc', '__raw', '__jsesc', code); // eslint-disable-line no-new-func
    return (t, e, r) => fn(t, e, r, jsEsc);
  }
  class HtmlTemplate {
    constructor(src) { Object.defineProperty(this, '_src', { value: src, enumerable: false }); }
    getRawContent() { return this._src; }
    getCode() { return compileTemplate(this._src).toString(); }
    evaluate() { return new HtmlOutput(compileTemplate(this._src)(this, esc, raw)); }
  }
  function fileSrc(name) {
    const n = String(name).replace(/\.html$/, '');
    if (!Object.prototype.hasOwnProperty.call(env.html, n)) throw new Error(`No HTML file named ${name} was found.`);
    return env.html[n];
  }
  G.HtmlService = {
    createHtmlOutput: (c) => new HtmlOutput(c && c.getDataAsString ? c.getDataAsString() : c),
    createHtmlOutputFromFile: (n) => new HtmlOutput(fileSrc(n)),
    createTemplate: (s) => new HtmlTemplate(s && s.getDataAsString ? s.getDataAsString() : String(s)),
    createTemplateFromFile: (n) => new HtmlTemplate(fileSrc(n)),
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    SandboxMode: { IFRAME: 'IFRAME', NATIVE: 'NATIVE', EMULATED: 'EMULATED' },
  };
  class TextOutput {
    constructor(c) { this._c = c || ''; this._mime = 'TEXT'; }
    getContent() { return this._c; }
    setContent(c) { this._c = String(c); return this; }
    append(c) { this._c += String(c); return this; }
    setMimeType(m) { this._mime = m; return this; }
    getMimeType() { return this._mime; }
  }
  G.ContentService = {
    createTextOutput: (c) => new TextOutput(c),
    MimeType: { JSON: 'JSON', TEXT: 'TEXT', CSV: 'CSV', JAVASCRIPT: 'JAVASCRIPT', XML: 'XML', ICAL: 'ICAL', VCARD: 'VCARD', RSS: 'RSS', ATOM: 'ATOM' },
  };

  // ---------------------------------------------------------------- 未対応サービス（呼ぶと明確に失敗させる）
  const notEmulated = (svc) => new Proxy({}, { get: (_, k) => { if (k === Symbol.toPrimitive || k === 'toString') return () => svc; throw new Error(`harness: ${svc}.${String(k)} はエミュレートされていない。必要なら harness に追加し、実環境で確認すること`); } });
  for (const s of ['DriveApp', 'UrlFetchApp', 'CalendarApp', 'FormApp', 'DocumentApp', 'SlidesApp', 'ContactsApp', 'Maps', 'XmlService', 'Charts']) G[s] = notEmulated(s);

  // ---------------------------------------------------------------- 実行の入口
  // google.script.run の戻り値に Date が含まれると、実GASでは成功ハンドラに null が渡る（仮定 A-20）。
  function findForbidden(v, p, seen) {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'number' || t === 'string' || t === 'boolean') return null;
    if (t === 'function') return `${p} が関数`;
    if (isDate(v)) return `${p} が Date`;
    if (t === 'object') {
      if (seen.has(v)) return `${p} が循環参照`;
      seen.add(v);
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = findForbidden(v[i], `${p}[${i}]`, seen); if (r) return r; } return null; }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return `${p} がプレーンでないオブジェクト(${v.constructor && v.constructor.name})`;
      for (const k of Object.keys(v)) { const r = findForbidden(v[k], `${p}.${k}`, seen); if (r) return r; }
    }
    return null;
  }

  Object.defineProperty(G, '__invoke', {
    enumerable: false,
    value() {
      const name = env.fn; const kind = env.kind;
      const args = dec(G.__argsJson);
      const f = G[name];
      if (kind === 'client' && (/_$/.test(name) || typeof f !== 'function')) throw new Error(`Script function not found: ${name}`);
      if (typeof f !== 'function') throw new Error(`Script function not found: ${name}`);
      if (kind === 'client') {
        const bad = findForbidden(args, 'args', new Set());
        if (bad) throw new Error(`harness: google.script.run の引数に送れない型 (${bad})`);
      }
      let v = f.apply(null, args);
      if (v && typeof v.then === 'function') {
        warn('ASYNC_RETURN', `${name} が Promise を返した。google.script.run では解決値が渡らない`);
        v = kind === 'client' ? {} : null;
      }
      if (v instanceof HtmlOutput) return JSON.stringify({ ok: true, value: enc({ __type: 'html', content: v._c, title: v._title, meta: v._meta, xframe: v._xframe, favicon: v._favicon }) });
      if (v instanceof TextOutput) return JSON.stringify({ ok: true, value: enc({ __type: 'text', content: v._c, mime: v._mime }) });
      if (kind === 'client') {
        const bad = findForbidden(v, 'return', new Set());
        if (bad) { warn('CLIENT_FORBIDDEN_RETURN', `${name} の戻り値: ${bad}。実GASでは成功ハンドラに null が渡る`); v = null; }
      }
      return JSON.stringify({ ok: true, value: v === undefined ? undefined : enc(v) });
    },
  });
}());
