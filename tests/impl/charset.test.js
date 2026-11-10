'use strict';
// 画面とサーバーのコードに使う文字は Shift_JIS（JIS X 0208）の範囲に限る（利用者の指示、2026-10-19）。
// 範囲外の記号（✓ や全角ハイフン －など）は、端末によって中国語の字形や豆腐（□）で出るため。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

function sjisSet() {
  const dec = new TextDecoder('shift_jis', { fatal: true });
  const set = new Set();
  for (let a = 0x81; a <= 0xfc; a++) {
    if (a > 0x9f && a < 0xe0) continue;
    for (let b = 0x40; b <= 0xfc; b++) {
      if (b === 0x7f) continue;
      try { const s = dec.decode(Uint8Array.of(a, b)); if (s.length === 1) set.add(s); } catch (e) { /* 未定義 */ }
    }
  }
  // 同じ Shift_JIS の文字でも、対応づけが JIS 規格（U+301C など）と Windows 系（U+FF5E など）で違うものは両方を認める
  const ALT = { '\uFF5E': '\u301C', '\u2225': '\u2016', '\uFF0D': '\u2212', '\uFFE0': '\u00A2', '\uFFE1': '\u00A3', '\uFFE2': '\u00AC', '\u2015': '\u2014' };
  for (const [k, v] of Object.entries(ALT)) if (set.has(k)) set.add(v);
  for (let c = 0xa1; c <= 0xdf; c++) set.add(new TextDecoder('shift_jis').decode(Uint8Array.of(c)));
  return set;
}

test('src/ の文字は Shift_JIS の範囲に収まっている', () => {
  const ok = sjisSet();
  const SRC = path.join(__dirname, '..', '..', 'src');
  const bad = [];
  for (const f of fs.readdirSync(SRC)) {
    const lines = fs.readFileSync(path.join(SRC, f), 'utf8').split('\n');
    lines.forEach((line, i) => { for (const ch of line) { if (ch.charCodeAt(0) >= 0x80 && !ok.has(ch)) bad.push(`${f}:${i + 1} 「${ch}」U+${ch.codePointAt(0).toString(16).toUpperCase()}`); } });
  }
  assert.deepEqual(bad, []);
});
