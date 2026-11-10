'use strict';
// スプレッドシートの保存領域（ホスト側・全実行で共有）。
// 実際の Google スプレッドシートが持つ「書き込み時の自動型変換」を再現するのが最重要の役割。
// ここで再現している挙動の根拠と確度は harness/real-gas/ASSUMPTIONS.md を参照。
const { zonedToUtc, partsInTz, pad } = require('./tz');

const MAX_CELL_CHARS = 50000;

class GasError extends Error {
  constructor(message, name = 'Exception') { super(message); this.name = name; }
}

// 書き込まれた値をスプレッドシートと同様に解釈する。
// 戻り値: { v: 保存値, f: 数式文字列|undefined, note: 変換が起きた場合の説明 }
function convertInput(value, fmt, tz, nowMs) {
  if (value === null || value === undefined) return { v: '' };
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return { v: '', note: 'Invalid Date は空欄として保存' };
    return { v: new Date(value.getTime()) };
  }
  if (typeof value === 'number') {
    if (!isFinite(value)) return { v: '#NUM!', note: '非有限数' };
    return { v: value };
  }
  if (typeof value === 'boolean') return { v: value };
  if (typeof value === 'object') {
    // GAS は配列やオブジェクトを書くと文字列化する（例: "[object Object]"）。
    const s = Array.isArray(value) ? value.join(',') : '[object Object]';
    return { v: s, note: `オブジェクトが文字列 "${s}" として保存された` };
  }
  const s = String(value);
  if (s.length > MAX_CELL_CHARS) {
    throw new GasError(`Your input contains more than the maximum of ${MAX_CELL_CHARS} characters in a single cell.`);
  }
  if (s === '') return { v: '' };
  if (fmt === '@') return { v: s }; // 書式なしテキスト。変換しない。
  if (s.startsWith("'")) return { v: s.slice(1) };
  if (s.startsWith('=') && s.length > 1) {
    return { v: '', f: s, note: '数式はエミュレータで評価されない（値は空として読まれる）' };
  }
  const t = s.trim();
  // 数値（先頭ゼロは失われる。電話番号などで起きやすい落とし穴）
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) {
    const n = Number(t);
    return { v: n, note: String(n) !== t ? `文字列 "${s}" が数値 ${n} に変換された` : `文字列 "${s}" が数値に変換された` };
  }
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) {
    const n = Number(t.replace(/,/g, ''));
    return { v: n, note: `文字列 "${s}" が数値 ${n} に変換された` };
  }
  if (/^[+-]?\d+(\.\d+)?%$/.test(t)) {
    const n = Number(t.slice(0, -1)) / 100;
    return { v: n, note: `文字列 "${s}" が数値 ${n} に変換された` };
  }
  if (/^(true|false)$/i.test(t)) {
    return { v: /^true$/i.test(t), note: `文字列 "${s}" が真偽値に変換された` };
  }
  let m;
  // 年月日（任意で時刻）。"T" 区切りの ISO 形式は文字列のまま（仮定 A-03）。
  if ((m = t.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/))) {
    const [y, mo, d, h, mi, se] = [+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)];
    if (validYmd(y, mo, d) && h < 24 && mi < 60 && se < 60) {
      return { v: new Date(zonedToUtc(tz, y, mo, d, h, mi, se)), note: `文字列 "${s}" が日付に変換された` };
    }
  }
  // 年なしの月/日 → 今年の日付（仮定 A-04。年のない日付の落とし穴）
  if ((m = t.match(/^(\d{1,2})\/(\d{1,2})$/))) {
    const y = partsInTz(nowMs, tz).y;
    if (validYmd(y, +m[1], +m[2])) {
      return { v: new Date(zonedToUtc(tz, y, +m[1], +m[2])), note: `年のない文字列 "${s}" が ${y} 年の日付に変換された` };
    }
  }
  // 時刻のみ → 1899-12-30 の日時
  if ((m = t.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/))) {
    const [h, mi, se] = [+m[1], +m[2], +(m[3] || 0)];
    if (h < 24 && mi < 60 && se < 60) {
      return { v: new Date(zonedToUtc(tz, 1899, 12, 30, h, mi, se)), note: `文字列 "${s}" が時刻(1899-12-30)に変換された` };
    }
  }
  return { v: s };
}

function validYmd(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return d <= dim;
}

function displayOf(v, tz) {
  if (v instanceof Date) {
    const p = partsInTz(v.getTime(), tz);
    if (p.y === 1899 && p.mo === 12 && p.d === 30) return `${p.h}:${pad(p.mi)}:${pad(p.s)}`;
    if (p.h === 0 && p.mi === 0 && p.s === 0) return `${p.y}/${pad(p.mo)}/${pad(p.d)}`;
    return `${p.y}/${pad(p.mo)}/${pad(p.d)} ${p.h}:${pad(p.mi)}:${pad(p.s)}`;
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

class SheetsStore {
  constructor({ clock }) {
    this.clock = clock; // () => ms
    this.books = new Map();
    this.nextSheetId = 1000;
    this.conversionLog = []; // 自動変換の記録（レポートで警告として表示）
  }

  createSpreadsheet({ id, name = 'Untitled spreadsheet', tz = 'Asia/Tokyo', sheets = ['シート1'] }) {
    if (this.books.has(id)) throw new Error(`spreadsheet ${id} already exists`);
    const book = { id, name, tz, sheets: [] };
    this.books.set(id, book);
    for (const s of sheets) this._newSheet(book, s);
    return book;
  }

  _newSheet(book, name, index) {
    const sh = { sheetId: this.nextSheetId++, name, rows: [], fmts: new Map(), maxRows: 1000, maxCols: 26, frozenRows: 0, hidden: false };
    if (index === undefined || index > book.sheets.length) book.sheets.push(sh);
    else book.sheets.splice(index, 0, sh);
    return sh;
  }

  book(id) {
    const b = this.books.get(id);
    if (!b) throw new GasError(`Unexpected error while getting the method or property openById on object SpreadsheetApp.`);
    return b;
  }

  sheet(id, sheetId) {
    const s = this.book(id).sheets.find((x) => x.sheetId === sheetId);
    if (!s) throw new GasError('Sheet not found (deleted?)');
    return s;
  }

  meta(id) {
    const b = this.book(id);
    return { id: b.id, name: b.name, tz: b.tz, sheets: b.sheets.map((s) => ({ sheetId: s.sheetId, name: s.name })) };
  }

  insertSheet(id, name, index) {
    const b = this.book(id);
    if (name === undefined || name === null) {
      let i = b.sheets.length + 1;
      while (b.sheets.some((s) => s.name === `シート${i}`)) i++;
      name = `シート${i}`;
    }
    if (b.sheets.some((s) => s.name === name)) {
      throw new GasError(`A sheet with the name "${name}" already exists. Please enter another name.`);
    }
    return this._newSheet(b, String(name), index).sheetId;
  }

  deleteSheet(id, sheetId) {
    const b = this.book(id);
    if (b.sheets.length <= 1) throw new GasError("You can't remove all the sheets in a document.");
    b.sheets = b.sheets.filter((s) => s.sheetId !== sheetId);
  }

  renameSheet(id, sheetId, name) {
    const b = this.book(id);
    if (b.sheets.some((s) => s.name === name && s.sheetId !== sheetId)) {
      throw new GasError(`A sheet with the name "${name}" already exists. Please enter another name.`);
    }
    this.sheet(id, sheetId).name = String(name);
  }

  dims(id, sheetId) {
    const s = this.sheet(id, sheetId);
    let lastRow = 0; let lastCol = 0;
    s.rows.forEach((row, ri) => {
      if (!row) return;
      row.forEach((cell, ci) => {
        if (cell && (cell.v !== '' || cell.f)) { lastRow = Math.max(lastRow, ri + 1); lastCol = Math.max(lastCol, ci + 1); }
      });
    });
    return { lastRow, lastCol, maxRows: s.maxRows, maxCols: s.maxCols, frozenRows: s.frozenRows, hidden: s.hidden, index: this.book(id).sheets.indexOf(s) + 1 };
  }

  _check(s, r, c, nr, nc) {
    if (r < 1) throw new GasError('The starting row of the range is too small.');
    if (c < 1) throw new GasError('The starting column of the range is too small.');
    if (nr < 1) throw new GasError('The number of rows in the range must be at least 1.');
    if (nc < 1) throw new GasError('The number of columns in the range must be at least 1.');
    if (r + nr - 1 > s.maxRows || c + nc - 1 > s.maxCols) {
      throw new GasError('The coordinates of the range are outside the dimensions of the sheet.');
    }
  }

  getValues(id, sheetId, r, c, nr, nc, mode = 'values') {
    const b = this.book(id); const s = this.sheet(id, sheetId);
    this._check(s, r, c, nr, nc);
    const out = [];
    for (let i = 0; i < nr; i++) {
      const row = s.rows[r - 1 + i] || [];
      const line = [];
      for (let j = 0; j < nc; j++) {
        const cell = row[c - 1 + j];
        if (mode === 'formulas') line.push(cell && cell.f ? cell.f : '');
        else if (mode === 'formats') line.push(s.fmts.get(`${r + i},${c + j}`) || 'General');
        else if (mode === 'display') line.push(cell ? displayOf(cell.v, b.tz) : '');
        else line.push(cell ? (cell.v instanceof Date ? new Date(cell.v.getTime()) : cell.v) : '');
      }
      out.push(line);
    }
    return out;
  }

  setValues(id, sheetId, r, c, values, ctxLabel) {
    const b = this.book(id); const s = this.sheet(id, sheetId);
    const nr = values.length; const nc = nr ? values[0].length : 0;
    this._check(s, r, c, nr, nc);
    const now = this.clock();
    for (let i = 0; i < nr; i++) {
      if (!s.rows[r - 1 + i]) s.rows[r - 1 + i] = [];
      for (let j = 0; j < nc; j++) {
        const fmt = s.fmts.get(`${r + i},${c + j}`);
        const conv = convertInput(values[i][j], fmt, b.tz, now);
        s.rows[r - 1 + i][c - 1 + j] = { v: conv.v, f: conv.f };
        if (conv.note) {
          this.conversionLog.push({ at: now, sheet: s.name, cell: `${colName(c + j)}${r + i}`, note: conv.note, by: ctxLabel });
        }
      }
    }
  }

  appendRow(id, sheetId, row, ctxLabel) {
    const s = this.sheet(id, sheetId);
    const { lastRow } = this.dims(id, sheetId);
    const target = lastRow + 1;
    if (target > s.maxRows) s.maxRows = target;
    if (row.length > s.maxCols) s.maxCols = row.length;
    this.setValues(id, sheetId, target, 1, [row], ctxLabel);
    return target;
  }

  setFormats(id, sheetId, r, c, formats) {
    const s = this.sheet(id, sheetId);
    this._check(s, r, c, formats.length, formats[0].length);
    formats.forEach((row, i) => row.forEach((f, j) => s.fmts.set(`${r + i},${c + j}`, f)));
  }

  clear(id, sheetId, r, c, nr, nc, contentsOnly) {
    const s = this.sheet(id, sheetId);
    this._check(s, r, c, nr, nc);
    for (let i = 0; i < nr; i++) {
      const row = s.rows[r - 1 + i];
      for (let j = 0; j < nc; j++) {
        if (row) row[c - 1 + j] = undefined;
        if (!contentsOnly) s.fmts.delete(`${r + i},${c + j}`);
      }
    }
  }

  insertRows(id, sheetId, beforeRow, n) {
    const s = this.sheet(id, sheetId);
    if (beforeRow < 1 || beforeRow > s.maxRows + 1) throw new GasError('Those rows are out of bounds.');
    s.rows.splice(beforeRow - 1, 0, ...Array.from({ length: n }, () => []));
    s.maxRows += n;
    this._shiftFormats(s, beforeRow, n);
  }

  deleteRows(id, sheetId, start, n) {
    const s = this.sheet(id, sheetId);
    if (start < 1 || start + n - 1 > s.maxRows) throw new GasError('Those rows are out of bounds.');
    if (n >= s.maxRows) throw new GasError("You can't delete all the rows on the sheet.");
    s.rows.splice(start - 1, n);
    s.maxRows -= n;
    this._shiftFormats(s, start + n, -n);
  }

  // fromRow 以降の行の書式を delta だけ移動する。delta<0 のとき [fromRow+delta, fromRow) は削除された行。
  _shiftFormats(s, fromRow, delta) {
    const next = new Map();
    for (const [k, f] of s.fmts) {
      const [r, c] = k.split(',').map(Number);
      if (r >= fromRow) next.set(`${r + delta},${c}`, f);
      else if (delta < 0 && r >= fromRow + delta) continue;
      else next.set(k, f);
    }
    s.fmts = next;
  }

  setMaxColumns(id, sheetId, n) { this.sheet(id, sheetId).maxCols = n; }

  find(id, sheetId, r, c, nr, nc, text, opts) {
    const b = this.book(id);
    const vals = this.getValues(id, sheetId, r, c, nr, nc, 'display');
    const hits = [];
    let re;
    if (opts.regex) re = new RegExp(text, opts.matchCase ? '' : 'i');
    vals.forEach((row, i) => row.forEach((v, j) => {
      let a = String(v); let q = String(text);
      if (!opts.matchCase && !opts.regex) { a = a.toLowerCase(); q = q.toLowerCase(); }
      let ok;
      if (re) ok = opts.entire ? new RegExp(`^(?:${text})$`, opts.matchCase ? '' : 'i').test(a) : re.test(a);
      else ok = opts.entire ? a === q : a.includes(q);
      if (ok) hits.push([r + i, c + j]);
    }));
    void b;
    return hits;
  }

  setFrozenRows(id, sheetId, n) { this.sheet(id, sheetId).frozenRows = n; }
  setHidden(id, sheetId, h) { this.sheet(id, sheetId).hidden = h; }

  // 試験・不変条件用：見出し行をキーにしたオブジェクト配列で返す
  dumpSheet(id, name, { headerRow = 1 } = {}) {
    const b = this.book(id);
    const s = b.sheets.find((x) => x.name === name);
    if (!s) return null;
    const { lastRow, lastCol } = this.dims(id, s.sheetId);
    if (lastRow < headerRow) return { header: [], rows: [] };
    const all = this.getValues(id, s.sheetId, 1, 1, lastRow, Math.max(lastCol, 1));
    const header = all[headerRow - 1].map(String);
    const rows = all.slice(headerRow).map((r, i) => {
      const o = { __row: headerRow + i + 1 };
      header.forEach((h, j) => { if (h) o[h] = r[j]; });
      return o;
    });
    return { header, rows };
  }

  toCsv(id, sheetId) {
    const b = this.book(id);
    const { lastRow, lastCol } = this.dims(id, sheetId);
    if (!lastRow) return '';
    return this.getValues(id, sheetId, 1, 1, lastRow, lastCol).map((r) => r.map((v) => {
      const sv = v instanceof Date ? displayOf(v, b.tz) : String(v);
      return /[",\n]/.test(sv) ? `"${sv.replace(/"/g, '""')}"` : sv;
    }).join(',')).join('\n');
  }
}

function colName(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

module.exports = { SheetsStore, GasError, convertInput, displayOf, colName };
