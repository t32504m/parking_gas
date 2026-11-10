#!/usr/bin/env node
'use strict';
// ペルソナ評価の集計と合否判定。
//   node harness/persona/score.js [実行ID]   （省略時は最新の実行）
// 客観指標（操作ログ・台帳）と主観評価（評価役AIの eval.json）の両方が基準を満たして初めて合格。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PDIR = path.join(ROOT, 'reports', 'persona');
const personas = JSON.parse(fs.readFileSync(path.join(ROOT, 'personas', 'personas.json'), 'utf8')).personas;
const TH = JSON.parse(fs.readFileSync(path.join(ROOT, 'personas', 'thresholds.json'), 'utf8'));

function latestRun() {
  if (!fs.existsSync(PDIR)) return null;
  const runs = fs.readdirSync(PDIR).filter((d) => !d.startsWith('.') && fs.statSync(path.join(PDIR, d)).isDirectory());
  runs.sort((a, b) => fs.statSync(path.join(PDIR, b)).mtimeMs - fs.statSync(path.join(PDIR, a)).mtimeMs);
  return runs[0] || null;
}

function readLog(file) {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function objective(persona, task, log, dirOfLog) {
  const o = TH.objective;
  const r = { taskId: task.id, problems: [] };
  if (!log) { r.pass = false; r.problems.push('操作ログが無い（未実施）'); return r; }
  const end = log.find((x) => ['done', 'giveup', 'limit'].includes(x.action));
  const acts = log.filter((x) => !['think', 'pageerror', 'start'].includes(x.action));
  const steps = Math.max(0, ...log.map((x) => x.step || 0));
  const uniq = (arr) => [...new Set(arr)];
  r.ended = end ? end.action : null;
  const vf = path.join(dirOfLog, 'verify.json');
  const ver = fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf, 'utf8')) : (end && end.verify) || null;
  r.success = !!(ver && ver.taskOk);
  r.verifyDetail = ver ? ver.detail : null;
  r.invariantViolations = ver ? ver.invariants.length : null;
  r.steps = steps;
  r.maxSteps = persona.constraints.maxSteps;
  r.actionErrors = acts.filter((x) => x.error).length;
  r.backs = acts.filter((x) => x.action === 'back').length;
  r.pageErrors = log.filter((x) => x.action === 'pageerror').map((x) => x.text);
  r.unreadable = uniq(log.flatMap((x) => (x.obs ? x.obs.unreadableEls : [])));
  r.smallTargets = uniq(log.flatMap((x) => (x.obs ? x.obs.small : [])));
  r.horizontalScroll = log.some((x) => x.obs && x.obs.hscroll);
  r.unfamiliarWords = uniq(log.flatMap((x) => (x.obs ? x.obs.unfamiliar : [])));
  r.maxEstUserWaitMs = Math.max(0, ...log.map((x) => x.estUserWaitMs || 0));
  if (!end) r.problems.push('課題が終了していない（done/giveup が無い）');
  if (o.taskSuccessRequired && !r.success) r.problems.push(`課題を達成できていない（台帳の判定: ${r.verifyDetail || 'なし'}${r.ended === 'giveup' ? '、本人は諦めた' : ''}${r.ended === 'limit' ? '、手数の上限' : ''}）`);
  if (o.maxStepsFromPersona && r.ended === 'limit') r.problems.push(`手数の上限 ${r.maxSteps} 手に達した`);
  if (r.unreadable.length > o.unreadableInteractiveAllowed) r.problems.push(`このペルソナには小さくて読めない操作部品: ${r.unreadable.join('、')}`);
  if (r.smallTargets.length > o.smallTapTargetAllowed) r.problems.push(`押しにくい（${o.smallTapTargetMinPx}px 未満の）部品: ${r.smallTargets.join('、')}`);
  if (!o.horizontalScrollAllowed && r.horizontalScroll) r.problems.push('横スクロールが発生した');
  if (r.unfamiliarWords.length > o.unfamiliarWordHitsAllowed) r.problems.push(`このペルソナに通じない言葉が表示された: ${r.unfamiliarWords.join('、')}`);
  if ((r.invariantViolations || 0) > o.invariantViolationsAllowed) r.problems.push('台帳の不変条件違反が起きた');
  if (r.pageErrors.length) r.problems.push(`画面のJavaScriptエラー: ${r.pageErrors.slice(0, 2).join(' / ')}`);
  r.pass = r.problems.length === 0;
  return r;
}

function subjective(persona, evalObj, logs) {
  const s = TH.subjective;
  const r = { problems: [] };
  if (!evalObj) { r.pass = false; r.problems.push('評価ファイルが無い（評価役AIによる評価が未実施）'); return r; }
  if (evalObj.evaluator !== 'fresh-agent') r.problems.push('評価者が「実装と別の新しいAI」と申告していない');
  const validSteps = (taskId) => new Set((logs[taskId] || []).map((x) => x.step));
  r.tasks = [];
  let majors = 0;
  for (const task of persona.tasks) {
    const e = (evalObj.tasks || []).find((x) => x.taskId === task.id);
    if (!e) { r.problems.push(`課題 ${task.id} の評価が無い`); continue; }
    const vs = validSteps(task.id);
    const cites = [...(e.complaints || []), ...(e.moments || []), ...(e.praise || [])];
    const bad = cites.filter((c) => !vs.has(c.step));
    if (TH.process.evidenceStepRequired && bad.length) r.problems.push(`課題 ${task.id}: 根拠の手番号がログに無い記述が ${bad.length} 件（無効）`);
    const crit = (e.complaints || []).filter((c) => c.severity === 'critical');
    majors += (e.complaints || []).filter((c) => c.severity === 'major').length;
    if (crit.length > s.criticalComplaintsAllowed) r.problems.push(`課題 ${task.id}: 致命的な不満 ${crit.map((c) => `「${c.text}」(手${c.step})`).join(' ')}`);
    if (!(e.satisfaction >= s.minTaskSatisfaction)) r.problems.push(`課題 ${task.id}: 満足度 ${e.satisfaction} < ${s.minTaskSatisfaction}`);
    if (!(e.confidence >= s.minTaskConfidence)) r.problems.push(`課題 ${task.id}: 結果への確信 ${e.confidence} < ${s.minTaskConfidence}`);
    if (s.minTaskOverview && !(e.overview >= s.minTaskOverview)) r.problems.push(`課題 ${task.id}: 見通し（一覧性） ${e.overview ?? '未記入'} < ${s.minTaskOverview}`);
    r.tasks.push({ taskId: task.id, satisfaction: e.satisfaction, confidence: e.confidence, overview: e.overview, effort: e.effort, believedOutcome: e.believedOutcome, complaints: e.complaints || [], suggestions: e.suggestions || [] });
  }
  if (majors > s.majorComplaintsAllowedPerPersona) r.problems.push(`大きな不満が ${majors} 件（許容 ${s.majorComplaintsAllowedPerPersona}）`);
  const ov = evalObj.overall || {};
  if (!(ov.satisfaction >= s.minOverallSatisfaction)) r.problems.push(`総合満足度 ${ov.satisfaction} < ${s.minOverallSatisfaction}`);
  r.overall = ov;
  r.pass = r.problems.length === 0;
  return r;
}

function score(runId) {
  runId = runId || latestRun();
  if (!runId) return { runId: null, pass: false, personas: [], note: 'ペルソナ評価の実行記録が無い' };
  const dir = path.join(PDIR, runId);
  const out = { runId, at: new Date().toISOString(), personas: [] };
  for (const p of personas) {
    const logs = {};
    const obj = p.tasks.map((t) => { const l = readLog(path.join(dir, `${p.id}__${t.id}`, 'log.jsonl')); logs[t.id] = l || []; return objective(p, t, l, path.join(dir, `${p.id}__${t.id}`)); });
    const ef = path.join(dir, `${p.id}.eval.json`);
    let ev = null;
    if (fs.existsSync(ef)) { try { ev = JSON.parse(fs.readFileSync(ef, 'utf8')); } catch (e) { ev = { tasks: [], overall: {}, parseError: e.message }; } }
    const sub = subjective(p, ev, logs);
    out.personas.push({ id: p.id, name: p.name, objective: obj, subjective: sub, pass: obj.every((x) => x.pass) && sub.pass });
  }
  out.pass = out.personas.length > 0 && out.personas.every((x) => x.pass);
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(out, null, 2));
  fs.mkdirSync(path.join(ROOT, 'reports', 'raw'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'reports', 'raw', 'persona.json'), JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  const r = score(process.argv[2]);
  console.log(`ペルソナ評価 ${r.runId || '(なし)'}: ${r.pass ? '合格' : '不合格'}`);
  for (const p of r.personas) {
    console.log(`\n${p.pass ? '○' : '×'} ${p.name}`);
    for (const t of p.objective) for (const pr of t.problems) console.log(`   [客観:${t.taskId}] ${pr}`);
    for (const pr of p.subjective.problems) console.log(`   [主観] ${pr}`);
  }
  process.exit(r.pass ? 0 : 1);
}

module.exports = { score, latestRun };
