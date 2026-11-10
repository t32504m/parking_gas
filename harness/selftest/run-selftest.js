#!/usr/bin/env node
'use strict';
// ハーネスの自己試験：
//  1) エミュレータの単体試験（実GASの挙動の仮定）
//  2) 最小実装(safe)で受入試験が全て合格すること（＝試験が合格可能であること）
//  3) わざと壊した実装（mutants.js）を、受入試験が1つ残らず不合格にすること（＝試験が甘くないこと）
//  4) lint が GAS で動かない書き方を検出すること
// 使い方: node harness/selftest/run-selftest.js [--quick]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const MUTANTS = require('./mutants');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(__dirname, 'fixtures', 'safe');
const quick = process.argv.includes('--quick');
const OUT = path.join(ROOT, 'reports', 'selftest-last.json');

function runNodeTest(files, env, label) {
  return new Promise((resolve) => {
    const args = ['--test', '--test-reporter=tap', ...files];
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => {
      const pass = +(out.match(/^# pass (\d+)/m) || [0, 0])[1];
      const fail = +(out.match(/^# fail (\d+)/m) || [0, 0])[1];
      const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      resolve({ label, code, pass, fail, failed, tail: out.split('\n').slice(-30).join('\n') });
    });
  });
}

function fixtureEnv(dir) {
  return {
    HARNESS_PROJECT_DIR: path.join(dir, 'gas'), HARNESS_ADAPTER: path.join(dir, 'adapter.js'),
    HARNESS_CONTRACT: path.join(dir, 'contract.json'), HARNESS_REPORT_DIR: path.join(dir, 'reports'),
    HARNESS_RACE_ROUNDS: '3',
  };
}

function copyFixture(id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mut-${id}-`));
  fs.cpSync(FIX, dir, { recursive: true });
  // adapter.js が相対パスで contract/adapter.js を読むため、置き場所を合わせる
  const adapterSrc = fs.readFileSync(path.join(FIX, 'adapter.js'), 'utf8').replace("require('../../../../contract/adapter.js')", `require(${JSON.stringify(path.join(ROOT, 'contract', 'adapter.js'))})`);
  fs.writeFileSync(path.join(dir, 'adapter.js'), adapterSrc);
  return dir;
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

(async () => {
  const t0 = Date.now();
  const result = { at: new Date().toISOString(), ok: true, parts: [] };
  const part = (name, ok, detail) => { result.parts.push({ name, ok, ...detail }); if (!ok) result.ok = false; console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail.note ? ` — ${detail.note}` : ''}`); };

  // 1) エミュレータ
  const emu = await runNodeTest([path.join(__dirname, 'emulator.test.js')], {}, 'emulator');
  part('エミュレータ単体試験', emu.code === 0, { note: `${emu.pass} pass / ${emu.fail} fail`, failed: emu.failed });

  // 4) lint（正常系は合格、危険な書き方は検出）
  const lintOk = spawnSync(process.execPath, [path.join(ROOT, 'harness', 'lint', 'gas-lint.js'), path.join(FIX, 'gas')], { env: { ...process.env, HARNESS_CONTRACT: path.join(FIX, 'contract.json') }, encoding: 'utf8' });
  part('lint: 最小実装は合格', lintOk.status === 0, { note: lintOk.stdout.trim().split('\n').pop() });
  const lintBad = [
    ['ACTIVE_SPREADSHEET', "function x_(){ return SpreadsheetApp.getActiveSpreadsheet(); }"],
    ['NOT_IN_GAS', 'function y_(){ setTimeout(function(){}, 1); }'],
    ['UNDECLARED_PUBLIC', 'function debugDump(){ return 1; }'],
    ['DUPLICATE_FUNCTION', 'function doGet(){ return 1; }'],
  ];
  for (const [code, src] of lintBad) {
    const dir = copyFixture(`lint-${code}`);
    fs.writeFileSync(path.join(dir, 'gas', 'Zz.gs'), src);
    const r = spawnSync(process.execPath, [path.join(ROOT, 'harness', 'lint', 'gas-lint.js'), path.join(dir, 'gas')], { env: { ...process.env, HARNESS_CONTRACT: path.join(dir, 'contract.json') }, encoding: 'utf8' });
    part(`lint が ${code} を検出`, r.status !== 0 && r.stdout.includes(`[${code}]`), { note: r.status === 0 ? '検出できなかった' : '' });
  }

  // 2) 最小実装で全試験合格
  const accFiles = fs.readdirSync(path.join(ROOT, 'tests', 'acceptance')).filter((f) => f.endsWith('.test.js')).map((f) => path.join(ROOT, 'tests', 'acceptance', f));
  const safeDir = copyFixture('safe');
  const safe = await runNodeTest(quick ? accFiles.filter((f) => !/0[248]_/.test(f)) : accFiles, fixtureEnv(safeDir), 'safe');
  part('最小実装で受入試験が全て合格（試験が合格可能）', safe.code === 0 && safe.fail === 0, { note: `${safe.pass} pass / ${safe.fail} fail`, failed: safe.failed, tail: safe.code ? safe.tail : undefined });

  // 3) 改変実装が検出されること
  const muts = quick ? MUTANTS.filter((m) => !m.files.some((f) => /0[24]_/.test(f))) : MUTANTS;
  const mres = await pool(muts, Math.max(2, Math.min(4, os.cpus().length)), async (m) => {
    const dir = copyFixture(m.id);
    const p = path.join(dir, 'gas', 'Code.gs');
    let src = fs.readFileSync(p, 'utf8');
    for (const [from, to] of m.edits) {
      if (!src.includes(from)) return { m, applied: false };
      src = src.replace(from, to);
    }
    fs.writeFileSync(p, src);
    const files = m.files.map((f) => path.join(ROOT, 'tests', 'acceptance', `${f}.test.js`));
    return { m, applied: true, r: await runNodeTest(files, fixtureEnv(dir), m.id) };
  });
  for (const x of mres) {
    if (!x.applied) { part(`改変 ${x.m.id} を検出`, false, { note: '改変を適用できない（最小実装と mutants.js がずれている）' }); continue; }
    part(`改変 ${x.m.id} を検出`, x.r.fail > 0, { note: x.r.fail > 0 ? `${x.r.failed.length}件の試験が不合格: ${x.r.failed[0]}` : `見逃した: ${x.m.why}`, why: x.m.why, failed: x.r.failed });
  }

  // 5) 画面の部品と自動監査
  const uiT = await runNodeTest([path.join(__dirname, 'fixture-ui.test.js')], fixtureEnv(safeDir), 'fixture-ui');
  part('画面試験の部品（通信断の再現）が動く', uiT.code === 0, { note: `${uiT.pass} pass / ${uiT.fail} fail`, tail: uiT.code ? uiT.tail : undefined });
  const audOk = spawnSync(process.execPath, [path.join(ROOT, 'harness', 'persona', 'ui-audit.js')], { cwd: ROOT, env: { ...process.env, ...fixtureEnv(safeDir) }, encoding: 'utf8' });
  part('画面監査: 最小実装は合格', audOk.status === 0, { note: audOk.stdout.split('\n').filter((l) => /FAIL|- /.test(l)).slice(0, 3).join(' ') });
  const badUi = copyFixture('ui-bad');
  const cg = path.join(badUi, 'gas', 'Code.gs');
  fs.writeFileSync(cg, fs.readFileSync(cg, 'utf8').replace(".addMetaTag('viewport', 'width=device-width, initial-scale=1')", ''));
  const ih = path.join(badUi, 'gas', 'Index.html');
  fs.writeFileSync(ih, fs.readFileSync(ih, 'utf8').replace('button { font-size: 18px; min-height: 48px; padding: 0 16px; }', 'button { font-size: 10px; min-height: 20px; } h1 { color: #bbb; }'));
  const audBad = spawnSync(process.execPath, [path.join(ROOT, 'harness', 'persona', 'ui-audit.js')], { cwd: ROOT, env: { ...process.env, ...fixtureEnv(badUi) }, encoding: 'utf8' });
  const caught = ['viewport', '12px 未満', '44px 未満', 'コントラスト'].filter((k) => audBad.stdout.includes(k));
  part('画面監査: 悪い画面（viewport無し・小さい文字・小さいボタン・薄い文字）を検出', audBad.status !== 0 && caught.length === 4, { note: `検出: ${caught.join('、')}` });
  // 監査が書いた結果ファイルは自己試験のものなので消す
  fs.rmSync(path.join(ROOT, 'reports', 'raw', 'ui-audit.json'), { force: true });

  result.seconds = Math.round((Date.now() - t0) / 1000);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`\nselftest ${result.ok ? 'PASSED' : 'FAILED'} (${result.seconds}s)`);
  process.exit(result.ok ? 0 : 1);
})();
