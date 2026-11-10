#!/usr/bin/env node
'use strict';
// 保護ファイル（ハーネス・受入試験・ペルソナ・合格基準）の改変検出。
// 実装AIが「試験を甘くして合格させる」ことを防ぐ。正当な変更は人が確認してから seal し直す。
//   node harness/report/integrity.js check   … 照合（verify が自動で実行）
//   node harness/report/integrity.js seal    … 現在の内容を正として記録（人が行う）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const SEAL = path.join(ROOT, 'harness', 'INTEGRITY.json');
const PROTECTED = ['harness', 'tests/acceptance', 'tests/helpers.js', 'tests/ui/ui-helpers.js', 'personas', 'contract/provisional-rules.json', 'contract/ui-tests-required.json', 'contract/perf-budget.json', 'docs/requirements-index.json', 'docs/REQUIREMENTS.md'];
const SKIP = [/harness[\\/]INTEGRITY\.json$/, /node_modules/, /[\\/]\.DS_Store$/];

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs).flatMap((f) => walk(path.join(rel, f)));
}

function current() {
  const out = {};
  for (const f of PROTECTED.flatMap(walk).filter((f) => !SKIP.some((re) => re.test(f))).sort()) {
    out[f.split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, f))).digest('hex').slice(0, 16);
  }
  return out;
}

function check() {
  if (!fs.existsSync(SEAL)) return { ok: false, sealed: false, changed: [], added: [], removed: [], note: '封印ファイルが無い（npm run harness:seal を人が実行する）' };
  const want = JSON.parse(fs.readFileSync(SEAL, 'utf8')).files;
  const have = current();
  const changed = Object.keys(want).filter((f) => have[f] && have[f] !== want[f]);
  const removed = Object.keys(want).filter((f) => !have[f]);
  const added = Object.keys(have).filter((f) => !want[f]);
  return { ok: !changed.length && !removed.length && !added.length, sealed: true, changed, added, removed };
}

if (require.main === module) {
  const cmd = process.argv[2] || 'check';
  if (cmd === 'seal') {
    fs.writeFileSync(SEAL, JSON.stringify({ sealedAt: new Date().toISOString(), note: '人が内容を確認したうえで封印すること', files: current() }, null, 2));
    console.log(`封印しました: ${Object.keys(current()).length} ファイル`);
  } else {
    const r = check();
    if (r.ok) console.log('保護ファイルは封印時のまま');
    else { console.log('保護ファイルが封印時と異なる'); for (const k of ['changed', 'added', 'removed']) for (const f of r[k]) console.log(`  ${k}: ${f}`); if (r.note) console.log(r.note); }
    process.exit(r.ok ? 0 : 1);
  }
}

module.exports = { check, current };
