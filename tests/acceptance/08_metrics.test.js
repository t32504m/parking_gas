'use strict';
// 時間の測定（要件8「性能」・11「測定する時間」）。
// 合格基準は未確定（要件8）。contract/perf-budget.json に値が入っている項目だけ判定し、他は記録のみ。
// 注意: ローカルの実時間は実GASより大幅に速い。estGasMs（操作回数×推定単価）を主に見ること。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { withEnv, ACTORS, DAY, recordMetric } = require('../helpers');

const R = ACTORS.residents;
const BUDGET = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'contract', 'perf-budget.json'), 'utf8')).budgets;

function judge(name, value) {
  recordMetric(name, value, 'ms');
  const b = BUDGET[name];
  if (b && typeof b.maxMs === 'number') assert.ok(value <= b.maxMs, `${name} = ${value}ms が予算 ${b.maxMs}ms を超えた`);
}

test('[8性能] 空き表示・受付・確定の推定所要時間（予約が多い状態）', async (t) => withEnv(t, async (env) => {
  // 30日分のうち、ある程度予約が入った状態を作る
  let k = 0;
  for (let d = 0; d < 10; d++) {
    const date = new Date(Date.parse(`${DAY}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
    for (const s of ['S1', 'S2', 'S3', 'S4']) {
      const who = R[k++ % R.length];
      await env.adapter.submit(env.host, env.req(who, { date, slotId: s }), who);
    }
  }
  const nExec = env.host.executions.length;
  await env.adapter.getAvailability(env.host, { from: '2026-10-19', to: '2026-11-18' }, ACTORS.anonymous);
  const av = env.host.executions.slice(nExec).at(-1);
  judge('availability.month.estGasMs', av.metrics.estGasMs);
  recordMetric('availability.month.sheetOps', Object.entries(av.metrics.ops).filter(([o]) => o.startsWith('sh.') || o.startsWith('ss.')).reduce((a, [, n]) => a + n, 0), 'ops');

  const n2 = env.host.executions.length;
  await env.adapter.submit(env.host, env.req(R[0], { date: '2026-11-05', slotId: 'S2' }), R[0]);
  const sub = env.host.executions.slice(n2).at(-1);
  judge('submit.estGasMs', sub.metrics.estGasMs);
  recordMetric('submit.lockWaitMs', sub.metrics.lockWaitMs, 'ms');
  recordMetric('submit.sheetOps', Object.entries(sub.metrics.ops).filter(([o]) => o.startsWith('sh.') || o.startsWith('ss.')).reduce((a, [, n]) => a + n, 0), 'ops');
}));

test('[8性能][11競合] 同時10件の申込みでのロック待ち時間（推定ではなくエミュレータ上の実測）', async (t) => withEnv(t, { latency: { min: 5, max: 15 } }, async (env) => {
  const people = R.slice(0, 10);
  const t0 = Date.now();
  await Promise.all(people.map((p, i) => env.adapter.submit(env.host, env.req(p, { slotId: ['S1', 'S2', 'S3', 'S4'][i % 4], date: i < 4 ? DAY : '2026-10-27' }), p)));
  const waits = env.host.executions.slice(-10).map((e) => e.metrics.lockWaitMs).sort((a, b) => a - b);
  recordMetric('race10.lockWaitMaxMs', waits.at(-1), 'ms');
  recordMetric('race10.lockWaitMedianMs', waits[5], 'ms');
  recordMetric('race10.totalWallMs', Date.now() - t0, 'ms');
}));
