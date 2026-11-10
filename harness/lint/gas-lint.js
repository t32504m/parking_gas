#!/usr/bin/env node
'use strict';
// GAS 向けの静的検査。「ローカルの Node では動くが、実GASでは動かない／危ない」書き方を見つける。
// 使い方: node harness/lint/gas-lint.js [srcDir] [--json out.json]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const srcDir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(ROOT, 'src'));
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const contractPath = process.env.HARNESS_CONTRACT || path.join(ROOT, 'contract', 'contract.json');
const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

const findings = [];
const add = (level, file, line, code, message) => findings.push({ level, file, line, code, message });

// コメントと文字列を空白に置き換え（行番号は保つ）
function strip(code) {
  let out = ''; let i = 0; const n = code.length;
  while (i < n) {
    const c = code[i]; const d = code[i + 1];
    if (c === '/' && d === '/') { while (i < n && code[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { out += '  '; i += 2; while (i < n && !(code[i] === '*' && code[i + 1] === '/')) { out += code[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += q; i++;
      while (i < n && code[i] !== q) { if (code[i] === '\\') { out += '  '; i += 2; continue; } out += code[i] === '\n' ? '\n' : ' '; i++; }
      out += q; i++; continue;
    }
    out += c; i++;
  }
  return out;
}
const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;

const files = fs.existsSync(srcDir) ? fs.readdirSync(srcDir) : [];
const serverFiles = files.filter((f) => /\.(gs|js)$/.test(f));
const htmlFiles = files.filter((f) => f.endsWith('.html'));

if (!fs.existsSync(path.join(srcDir, 'appsscript.json'))) add('error', 'appsscript.json', 0, 'NO_MANIFEST', 'appsscript.json が無い');
else {
  const m = JSON.parse(fs.readFileSync(path.join(srcDir, 'appsscript.json'), 'utf8'));
  if (m.timeZone !== 'Asia/Tokyo') add('error', 'appsscript.json', 0, 'TIMEZONE', `timeZone が ${m.timeZone}（Asia/Tokyo にすること）`);
  if (m.runtimeVersion !== 'V8') add('error', 'appsscript.json', 0, 'RUNTIME', 'runtimeVersion を V8 にすること');
  if (!m.webapp) add('warn', 'appsscript.json', 0, 'NO_WEBAPP', 'webapp 設定が無い（executeAs / access）');
}

const FORBIDDEN = [
  [/\brequire\s*\(/, 'require は GAS に無い'],
  [/^\s*import\s/m, 'import 文は GAS で使えない'],
  [/^\s*export\s/m, 'export 文は GAS で使えない'],
  [/\bmodule\.exports\b/, 'module.exports は GAS に無い（試験用にも使わないこと）'],
  [/\bprocess\.\w/, 'process は GAS に無い'],
  [/\bsetTimeout\s*\(|\bsetInterval\s*\(/, 'setTimeout/setInterval は GAS サーバー側に無い（Utilities.sleep を使う）'],
  [/(^|[^.\w])fetch\s*\(/, 'fetch は GAS サーバー側に無い（UrlFetchApp を使う）'],
  [/\bBuffer\./, 'Buffer は GAS に無い'],
  [/\b(window|document|localStorage)\./, 'ブラウザの API はサーバー側(.gs)で使えない'],
  [/\bstructuredClone\s*\(/, 'structuredClone は GAS で使えない可能性が高い'],
];

const defs = new Map(); // function name -> [file:line]
for (const f of serverFiles) {
  const code = fs.readFileSync(path.join(srcDir, f), 'utf8');
  try { new vm.Script(code, { filename: f }); } catch (e) { add('error', f, 0, 'SYNTAX', e.message); continue; }
  const s = strip(code);
  for (const [re, msg] of FORBIDDEN) {
    const m = s.match(re);
    if (m) add('error', f, lineOf(s, m.index), 'NOT_IN_GAS', msg);
  }
  let m;
  const reAct = /SpreadsheetApp\s*\.\s*(getActiveSpreadsheet|getActive)\s*\(/g;
  while ((m = reAct.exec(s))) add('error', f, lineOf(s, m.index), 'ACTIVE_SPREADSHEET', '要件7.2: アクティブなスプレッドシートに依存しない（設定したIDから openById で開く）');
  const reFn = /^(?:async\s+)?function\s*\*?\s*([A-Za-z$][\w$]*)\s*\(/gm;
  while ((m = reFn.exec(s))) {
    const name = m[1];
    if (!defs.has(name)) defs.set(name, []);
    defs.get(name).push(`${f}:${lineOf(s, m.index)}`);
    if (/^async\s/.test(m[0]) && !name.endsWith('_')) add('warn', f, lineOf(s, m.index), 'ASYNC_PUBLIC', `${name} は async。google.script.run からは解決値が受け取れない`);
  }
  // 最上位で実行される処理（毎回の実行で動く）
  const top = s.split('\n');
  let depth = 0;
  top.forEach((ln, i) => {
    if (depth === 0 && /^\s*(const|let|var)\s+\w+\s*=\s*.*\b(SpreadsheetApp|PropertiesService|CacheService|LockService|MailApp|Session)\./.test(ln)) {
      add('warn', f, i + 1, 'TOP_LEVEL_SERVICE_CALL', '最上位でサービスを呼んでいる。全ての実行（doGet等）で毎回動き、遅くなる・失敗しうる');
    }
    for (const ch of ln) { if (ch === '{') depth++; else if (ch === '}') depth--; }
  });
  if (/\bnew Date\s*\(\s*['"`]\d{4}-\d{2}-\d{2}['"`]\s*\)/.test(code)) {
    add('warn', f, 0, 'DATE_PARSE_UTC', "new Date('YYYY-MM-DD') は UTC 0時として解釈される（日本時間では9時）。日付の扱いを明示すること");
  }
}

for (const [name, where] of defs) {
  if (where.length > 1) add('error', where[1].split(':')[0], +where[1].split(':')[1], 'DUPLICATE_FUNCTION', `関数 ${name} が複数定義されている（${where.join(', ')}）。GAS では後に読み込まれた方が黙って勝つ`);
}

const declared = contract.surface.functions;
const publicNames = [...defs.keys()].filter((n) => !n.endsWith('_'));
for (const n of publicNames) {
  if (!(n in declared)) add('error', defs.get(n)[0].split(':')[0], +defs.get(n)[0].split(':')[1], 'UNDECLARED_PUBLIC', `${n} は google.script.run から誰でも呼べる。contract.json の surface.functions に権限区分を宣言するか、名前の末尾を _ にして非公開にすること`);
}
for (const n of Object.keys(declared)) {
  if (serverFiles.length && !defs.has(n)) add('warn', 'contract.json', 0, 'DECLARED_MISSING', `surface に宣言された ${n} が src に無い`);
}

// HTML
let serverUsesViewport = false;
for (const f of serverFiles) if (/addMetaTag\s*\(\s*['"]viewport['"]/.test(fs.readFileSync(path.join(srcDir, f), 'utf8'))) serverUsesViewport = true;
for (const f of htmlFiles) {
  const code = fs.readFileSync(path.join(srcDir, f), 'utf8');
  if (/<meta[^>]+name=["']viewport["']/i.test(code) && !serverUsesViewport) {
    add('error', f, 0, 'VIEWPORT', 'HTML 内の <meta name="viewport"> は GAS の外側ページに効かない。doGet で .addMetaTag("viewport", ...) を使うこと（スマホ表示が崩れる）');
  }
  const re = /google\s*\.\s*script\s*\.\s*run\b/g; let m;
  while ((m = re.exec(code))) {
    let i = m.index + m[0].length; let depth = 0; let name = null;
    while (i < code.length) {
      const ch = code[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && ch === ';') break;
      else if (depth === 0 && ch === '.') {
        const mm = code.slice(i + 1).match(/^\s*([A-Za-z_$][\w$]*)\s*\(/);
        if (mm && !/^with(SuccessHandler|FailureHandler|UserObject)$/.test(mm[1])) { name = mm[1]; break; }
      }
      i++;
    }
    if (!name) continue;
    if (name.endsWith('_')) add('error', f, lineOf(code, m.index), 'CALL_PRIVATE', `google.script.run.${name}: 末尾 _ の関数は呼べない`);
    else if (serverFiles.length && !defs.has(name)) add('error', f, lineOf(code, m.index), 'CALL_MISSING', `google.script.run.${name}: サーバーに関数が無い`);
    const seg = code.slice(m.index, i + 200);
    if (!/withFailureHandler/.test(code.slice(m.index, i))) add('warn', f, lineOf(code, m.index), 'NO_FAILURE_HANDLER', `google.script.run.${name} に withFailureHandler が無い（通信エラーを利用者に示せない：U-07）`);
    void seg;
  }
  const aRe = /<a\s[^>]*href=["'](https?:)?[^"'#][^"']*["'][^>]*>/gi;
  while ((m = aRe.exec(code))) if (!/target=/.test(m[0])) add('warn', f, lineOf(code, m.index), 'LINK_TARGET', 'GAS の iframe 内ではリンクに target="_top" か "_blank" が必要');
}

const errors = findings.filter((x) => x.level === 'error');
const summary = { srcDir, files: serverFiles.length + htmlFiles.length, errors: errors.length, warnings: findings.length - errors.length, findings };
if (jsonOut) { fs.mkdirSync(path.dirname(jsonOut), { recursive: true }); fs.writeFileSync(jsonOut, JSON.stringify(summary, null, 2)); }
for (const x of findings) console.log(`${x.level === 'error' ? 'ERROR' : 'warn '} ${x.file}${x.line ? `:${x.line}` : ''} [${x.code}] ${x.message}`);
console.log(`gas-lint: ${summary.files} files, ${errors.length} errors, ${summary.warnings} warnings`);
process.exit(errors.length ? 1 : 0);
