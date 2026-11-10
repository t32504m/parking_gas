#!/usr/bin/env node
'use strict';
/**
 * 検証の一括実行とレポート作成。実装AIは変更のたびにこれを実行し、reports/latest.md を読んで次の作業を決める。
 *   npm run verify            … 全部（ペルソナ評価は既存の結果を集計するだけ）
 *   npm run verify -- --quick … 競合試験の繰り返し回数を減らして速く回す（作業中の確認用）
 *   npm run verify -- --strict… ペルソナ評価の合格も必須にする（完了判定に使う）
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const RAW = path.join(ROOT, 'reports', 'raw');
const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const STRICT = argv.includes('--strict');
const NO_UI = argv.includes('--no-ui');

const readJson = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };
const readJsonl = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean) : []);

function runTests(label, files, extraEnv = {}) {
  return new Promise((resolve) => {
    const dest = path.join(RAW, `${label}.jsonl`);
    if (!files.length) { fs.writeFileSync(dest, ''); resolve({ label, results: [], code: 0, stderr: '' }); return; }
    const args = ['--test', `--test-reporter=${path.join(__dirname, 'json-reporter.js')}`, `--test-reporter-destination=${dest}`, ...files];
    const p = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...extraEnv } });
    let stderr = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => {
      const results = readJsonl(dest);
      const c = { pass: 0, fail: 0, skip: 0 };
      for (const r of results) c[r.status === 'pass' ? 'pass' : r.status === 'fail' ? 'fail' : 'skip']++;
      console.log(`  ${label}: 合格 ${c.pass} / 不合格 ${c.fail} / 保留 ${c.skip}`);
      resolve({ label, results, code, stderr });
    });
  });
}

const tagsOf = (name) => [...String(name).matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].split(' ')[0]);

function newestMtime(dir) {
  if (!fs.existsSync(dir)) return 0;
  return Math.max(0, ...fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
}

(async () => {
  const t0 = Date.now();
  fs.rmSync(RAW, { recursive: true, force: true });
  fs.mkdirSync(RAW, { recursive: true });
  fs.rmSync(path.join(ROOT, 'reports', 'sheets'), { recursive: true, force: true });
  const srcDir = path.join(ROOT, 'src');
  const hasImpl = fs.existsSync(srcDir) && fs.readdirSync(srcDir).some((f) => /\.(gs|js)$/.test(f));
  const R = { at: new Date().toISOString(), mode: QUICK ? 'quick' : 'full', hasImpl, gates: {} };

  console.log('▶ 保護ファイルの照合');
  R.integrity = require('./integrity').check();

  console.log('▶ GAS 静的検査');
  spawnSync(process.execPath, [path.join(ROOT, 'harness', 'lint', 'gas-lint.js'), srcDir, '--json', path.join(RAW, 'lint.json')], { cwd: ROOT, stdio: 'inherit' });
  R.lint = readJson(path.join(RAW, 'lint.json'), { errors: 1, findings: [{ level: 'error', code: 'LINT_CRASH', message: 'lint が実行できなかった' }] });

  console.log('▶ エミュレータ単体試験');
  const emu = await runTests('emulator', [path.join(ROOT, 'harness', 'selftest', 'emulator.test.js')]);

  console.log('\n▶ 受入試験');
  const acc = await runTests('acceptance', fs.readdirSync(path.join(ROOT, 'tests', 'acceptance')).filter((f) => f.endsWith('.test.js')).map((f) => path.join(ROOT, 'tests', 'acceptance', f)), QUICK ? { HARNESS_RACE_ROUNDS: '2' } : {});

  let ui = { results: [] };
  if (!NO_UI) {
    console.log('\n▶ 画面試験（tests/ui）');
    const uiFiles = fs.readdirSync(path.join(ROOT, 'tests', 'ui')).filter((f) => f.endsWith('.ui.test.js')).map((f) => path.join(ROOT, 'tests', 'ui', f));
    ui = await runTests('ui', uiFiles);
    const implFiles = fs.existsSync(path.join(ROOT, 'tests', 'impl')) ? fs.readdirSync(path.join(ROOT, 'tests', 'impl')).filter((f) => f.endsWith('.test.js')).map((f) => path.join(ROOT, 'tests', 'impl', f)) : [];
    R.impl = (await runTests('impl', implFiles)).results;
    console.log('\n▶ 画面の自動監査');
    if (hasImpl) spawnSync(process.execPath, [path.join(ROOT, 'harness', 'persona', 'ui-audit.js')], { cwd: ROOT, stdio: 'inherit' });
    R.uiAudit = readJson(path.join(RAW, 'ui-audit.json'), { pass: false, results: [], error: hasImpl ? '監査結果が無い' : '実装が無い' });
  }

  console.log('\n▶ ペルソナ評価の集計（評価役AIの実行は別手順）');
  const { score } = require('../persona/score');
  R.persona = score();
  const personaDir = R.persona.runId ? path.join(ROOT, 'reports', 'persona', R.persona.runId) : null;
  R.persona.stale = !personaDir || newestMtime(personaDir) < newestMtime(srcDir);

  // ---- 集計
  R.emulator = emu.results;
  R.acceptance = acc.results;
  R.ui = ui.results;
  R.metrics = readJsonl(path.join(RAW, 'metrics.jsonl'));
  R.findings = readJsonl(path.join(RAW, 'findings.jsonl'));
  R.selftest = readJson(path.join(RAW, '..', 'selftest-last.json'));
  const count = (rs) => ({ pass: rs.filter((x) => x.status === 'pass').length, fail: rs.filter((x) => x.status === 'fail').length, skip: rs.filter((x) => x.status === 'skip').length, total: rs.length });

  const reqUi = readJson(path.join(ROOT, 'contract', 'ui-tests-required.json')).required;
  const uiStatus = reqUi.map((u) => {
    const ts = R.ui.filter((x) => x.name.includes(`[${u.id}]`));
    return { ...u, status: !ts.length ? 'missing' : ts.every((x) => x.status === 'pass') ? 'pass' : 'fail' };
  });
  R.uiRequired = uiStatus;

  const accC = count(R.acceptance);
  R.gates = {
    integrity: { ok: R.integrity.ok, label: '保護ファイルが封印時のまま' },
    lint: { ok: hasImpl && R.lint.errors === 0, label: `GAS 静的検査のエラー 0${hasImpl ? '' : '（実装なし）'}` },
    emulator: { ok: count(R.emulator).fail === 0 && R.emulator.length > 0, label: 'エミュレータの前提が崩れていない' },
    acceptance: { ok: accC.total > 0 && accC.fail === 0 && accC.pass > 0, label: `受入試験 全合格（${accC.pass}/${accC.total}、未実装skip ${accC.skip}）` },
    ui: { ok: NO_UI ? null : uiStatus.filter((u) => u.stage === 1).every((u) => u.status === 'pass'), label: '第1段階の必須画面試験が存在し合格' },
    uiAudit: { ok: NO_UI ? null : !!(R.uiAudit && R.uiAudit.pass), label: '画面の自動監査（スマホ幅・文字・押しやすさ・コントラスト）' },
    persona: { ok: R.persona.pass && !R.persona.stale, label: `ペルソナ評価が合格${R.persona.stale ? '（※実装変更後の評価が無い）' : ''}`, required: STRICT },
  };
  const blocking = Object.entries(R.gates).filter(([k, g]) => g.ok === false && (k !== 'persona' || STRICT));
  R.ok = blocking.length === 0;
  R.seconds = Math.round((Date.now() - t0) / 1000);

  // ---- 要件の追跡
  const idx = readJson(path.join(ROOT, 'docs', 'requirements-index.json')).items;
  const all = [...R.acceptance, ...R.ui, ...(R.impl || [])];
  R.trace = idx.map((it) => {
    const ts = all.filter((x) => tagsOf(x.name).includes(it.id));
    const uis = uiStatus.filter((u) => u.req.includes(it.id));
    const st = !ts.length && !uis.length ? 'uncovered' : ts.some((x) => x.status === 'fail') || uis.some((u) => u.status === 'fail') ? 'fail' : ts.every((x) => x.status === 'pass') && uis.every((u) => u.status === 'pass') ? 'pass' : 'partial';
    return { ...it, status: st, tests: ts.length, uiTests: uis.map((u) => `${u.id}:${u.status}`) };
  });

  fs.writeFileSync(path.join(ROOT, 'reports', 'latest.json'), JSON.stringify(R, null, 2));
  fs.writeFileSync(path.join(ROOT, 'reports', 'latest.md'), renderMd(R));
  appendHistory(R, accC);
  console.log(`\n${R.ok ? '✅ 合格' : '❌ 不合格'}（${R.seconds}秒） → reports/latest.md`);
  process.exit(R.ok ? 0 : 1);
})();

function appendHistory(R, accC) {
  const p = path.join(ROOT, 'reports', 'history.jsonl');
  fs.appendFileSync(p, `${JSON.stringify({ at: R.at, ok: R.ok, mode: R.mode, acceptance: accC, lintErrors: R.lint.errors, ui: R.uiRequired.filter((u) => u.status === 'pass').length, persona: R.persona.pass, gates: Object.fromEntries(Object.entries(R.gates).map(([k, g]) => [k, g.ok])) })}\n`);
}

function renderMd(R) {
  const mark = (ok) => (ok === null ? '－' : ok ? '✅' : '❌');
  const L = [];
  L.push(`# 検証レポート（${R.at.replace('T', ' ').slice(0, 19)} UTC・${R.mode}・${R.seconds}秒）`, '');
  L.push(`**総合: ${R.ok ? '✅ 合格' : '❌ 不合格'}**${R.hasImpl ? '' : '　※ src/ に実装がまだ無い'}`, '');
  L.push('| 関門 | 状態 | 内容 |', '|---|---|---|');
  for (const [k, g] of Object.entries(R.gates)) L.push(`| ${k} | ${mark(g.ok)} | ${g.label}${k === 'persona' && !g.required ? '（--strict で必須）' : ''} |`);
  L.push('');

  // 次にやること
  const todo = [];
  if (!R.integrity.ok) todo.push(`保護ファイルが変わっている: ${[...R.integrity.changed, ...R.integrity.added, ...R.integrity.removed].slice(0, 5).join(', ')} ${R.integrity.note || ''}。実装AIは元に戻すこと（変更が必要なら人に相談）`);
  for (const f of (R.lint.findings || []).filter((x) => x.level === 'error').slice(0, 8)) todo.push(`[lint ${f.code}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}`);
  // 同じ理由で落ちている試験はまとめる（例: adapter 未実装）
  const groups = new Map();
  for (const t of R.acceptance.filter((x) => x.status === 'fail')) {
    const key = String(t.message || '').split('\n')[0];
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  for (const [, ts] of [...groups].slice(0, 12)) {
    const t = ts[0];
    const head = ts.length > 1 ? `[受入 ${ts.length}件が同じ理由] ${t.name} ほか` : `[受入] ${t.name}`;
    todo.push(`${head}\n    → ${String(t.message || '').split('\n').slice(0, 4).join('\n      ')}`);
  }
  for (const u of R.uiRequired.filter((x) => x.stage === 1 && x.status !== 'pass')) todo.push(`[画面 ${u.id}] ${u.status === 'missing' ? '試験が無い' : '不合格'}: ${u.what}`);
  for (const a of ((R.uiAudit && R.uiAudit.results) || []).filter((x) => !x.pass)) for (const p of a.problems) todo.push(`[監査 ${a.page}@${a.device}] ${p}`);
  if (R.uiAudit && R.uiAudit.error && R.hasImpl) todo.push(`[監査] ${R.uiAudit.error}`);
  if (todo.length) { L.push('## 次にやること（上から順に）', ''); todo.slice(0, 30).forEach((t, i) => L.push(`${i + 1}. ${t}`)); L.push(''); }

  // 受入試験
  L.push('## 受入試験', '');
  if (!R.acceptance.length) L.push('（結果なし）');
  for (const t of R.acceptance) L.push(`- ${t.status === 'pass' ? '✅' : t.status === 'skip' ? '⏸' : '❌'} ${t.name}${t.status === 'skip' && t.skipReason ? `（${t.skipReason}）` : ''}`);
  const notImpl = R.acceptance.filter((t) => /adapter未実装/.test(t.message || '')).length;
  if (notImpl) L.push('', `> ${notImpl} 件は contract/adapter.js が未実装のため失敗している。`);
  L.push('');

  // 画面
  L.push('## 必須の画面試験', '', '| ID | 段階 | 状態 | 内容 |', '|---|---|---|---|');
  for (const u of R.uiRequired) L.push(`| ${u.id} | ${u.stage} | ${u.status === 'pass' ? '✅' : u.status === 'missing' ? '未作成' : '❌'} | ${u.what} |`);
  L.push('');
  if (R.uiAudit && R.uiAudit.results && R.uiAudit.results.length) {
    L.push('## 画面の自動監査', '');
    for (const a of R.uiAudit.results) {
      L.push(`- ${a.pass ? '✅' : '❌'} ${a.page} @ ${a.device}（${a.screenshot || '画像なし'}）`);
      for (const p of a.problems) L.push(`  - ${p}`);
      for (const w of a.warnings || []) L.push(`  - 注意: ${w}`);
    }
    L.push('');
  }

  // ペルソナ
  L.push('## ペルソナ評価', '');
  if (!R.persona.runId) L.push('まだ実行されていない。CLAUDE.md の「ペルソナ評価の回し方」に従い、評価役AIで実行する。');
  else {
    L.push(`実行: ${R.persona.runId}　${R.persona.pass ? '✅ 合格' : '❌ 不合格'}${R.persona.stale ? '　⚠ 実装が評価後に変更されている（再評価が必要）' : ''}`, '');
    for (const p of R.persona.personas) {
      const sats = (p.subjective.tasks || []).map((t) => `${t.taskId}:満足${t.satisfaction ?? '-'}/確信${t.confidence ?? '-'}`).join(' ');
      L.push(`- ${p.pass ? '✅' : '❌'} ${p.name}　${sats}`);
      for (const t of p.objective) for (const pr of t.problems) L.push(`  - 客観(${t.taskId}): ${pr}`);
      for (const pr of p.subjective.problems) L.push(`  - 主観: ${pr}`);
      for (const t of p.subjective.tasks || []) for (const s of (t.suggestions || []).slice(0, 2)) L.push(`  - 要望(${t.taskId}): ${s}`);
    }
  }
  L.push('', '> ペルソナ評価はAIによる予測であり、実際の住民・管理者の満足を保証しない。docs/REAL_ENV_CHECKLIST.md の「人による確認」で必ず裏づけること。', '');

  // 要件の追跡
  L.push('## 要件ごとの状況', '', '| 要件 | 段階 | 状態 | 試験数 | 画面試験 | 内容 |', '|---|---|---|---|---|---|');
  const sm = { pass: '✅', fail: '❌', partial: '△', uncovered: '未対応' };
  for (const t of R.trace) L.push(`| ${t.id} | ${t.stage} | ${sm[t.status]} | ${t.tests} | ${t.uiTests.join(' ')} | ${t.text} |`);
  L.push('');

  // 計測
  if (R.metrics.length) {
    L.push('## 計測（合格基準は未確定。推定値は cost-model.json の仮単価による）', '', '| 指標 | 値 |', '|---|---|');
    const by = {};
    for (const m of R.metrics) (by[m.name] = by[m.name] || []).push(m.value);
    for (const [k, v] of Object.entries(by)) L.push(`| ${k} | ${v.length > 1 ? `最大 ${Math.max(...v)} / 平均 ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)}` : v[0]} ${R.metrics.find((m) => m.name === k).unit || ''} |`);
    L.push('');
  }

  // 実GASとの差に関わる警告
  const warns = R.findings.filter((f) => f.kind === 'warning').flatMap((f) => f.items.map((i) => `${i.code}: ${i.message}`));
  const conv = R.findings.filter((f) => f.kind === 'conversion').flatMap((f) => f.items.map((i) => `${i.sheet}!${i.cell} ${i.note}`));
  if (warns.length || conv.length) {
    L.push('## 実GASで問題になりうる挙動（エミュレータが検出）', '');
    for (const w of [...new Set(warns)].slice(0, 15)) L.push(`- ${w}`);
    if (conv.length) {
      L.push(`- スプレッドシートの自動変換が ${conv.length} 回起きた（意図しない変換なら書式 '@' やアポストロフィで防ぐ）。例:`);
      for (const c of [...new Set(conv)].slice(0, 8)) L.push(`  - ${c}`);
    }
    L.push('');
  }
  const lw = (R.lint.findings || []).filter((x) => x.level !== 'error');
  if (lw.length) { L.push('## lint の注意', ''); for (const f of lw.slice(0, 15)) L.push(`- [${f.code}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.message}`); L.push(''); }

  // 未決定事項
  const rules = readJson(path.join(ROOT, 'contract', 'provisional-rules.json'), {});
  L.push('## 仮ルール・未決定事項（人の判断待ち）', '');
  for (const [k, v] of Object.entries(rules)) if (!k.startsWith('_')) L.push(`- ${k} = ${v.value}（${v.status === 'provisional' ? '仮' : '未決定'}）${v.note ? ` — ${v.note}` : ''}`);
  L.push('', '実環境（本物のGoogle）でしか確かめられない事項は docs/REAL_ENV_CHECKLIST.md を参照。', '');
  return L.join('\n');
}
