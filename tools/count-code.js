'use strict';
// コードの量を数える（空行・注釈だけの行を除く）。node tools/count-code.js [フォルダ]
const fs = require('fs');
const path = require('path');
const dir = process.argv[2] || path.join(__dirname, '..', 'src');
let total = 0, all = 0;
for (const f of fs.readdirSync(dir).filter((x) => /\.(gs|html)$/.test(x)).sort()) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/);
  const code = lines.filter((l) => { const t = l.trim(); return t && !/^(\/\/|\/\*\*?|\*|\*\/|<!--)/.test(t); }).length;
  total += code; all += lines.length;
  console.log(`${f.padEnd(14)} ${String(code).padStart(5)}`);
}
console.log(`合計（注釈・空行を除く） ${total}　すべての行 ${all}`);
