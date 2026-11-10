'use strict';
/**
 * 台帳の行が増えたとき、1回の処理がどれだけ遅くなるかを、エミュレータの中で測る（検討 3章）。
 *   node tools/measure-growth.js
 *
 * 過去の予約を「毎日4コマ×2台が全て埋まった」最悪の場合で、0年・1年・3年分入れ、主な処理を5回ずつ呼ぶ。
 * 最後に、3年分を入れてから保管（D-023）を動かした後も測る。
 * ・wallMs   … このパソコンでの実時間（シートの中身の受け渡しを含む）。行が増えた分の重さの目安
 * ・estGasMs … 本物の GAS での推定。ただし推定は「シートを呼んだ回数」だけで決まり、読んだ量は数えない（cost-model.json）
 * ・cells    … 1回に読んだセルの数（読んだ量）
 * 本物の GAS での時間は、ここからは分からない。本物の GAS での試験で測る（docs/REAL_ENV_CHECKLIST.md）。
 */
const { createEnv, ACTORS } = require('../tests/helpers');

const DAY_MS = 86400000;
const ymd = (t) => new Date(t + 9 * 3600000).toISOString().slice(0, 10);
const SLOT = { S1: ['A 朝 08:00〜11:00', '08:00', '11:00', 0, 300], S2: ['B 昼 11:00〜14:00', '11:00', '14:00', 0, 300], S3: ['C 午後 14:00〜17:00', '14:00', '17:00', 0, 300], S4: ['D 夜 17:00〜08:00', '17:00', '08:00', 1, 600] };

function sheetIdOf(host, ssId, name) {
  return host.store.meta(ssId).sheets.find((s) => s.name === name).sheetId;
}

/** 今日より前の days 日分、全てのコマに2台ずつ入った台帳を作る */
function seed(env, days) {
  const { host, spreadsheetId: ss } = env;
  const ids = { res: sheetIdOf(host, ss, '予約'), alc: sheetIdOf(host, ss, '割当て'), ntf: sheetIdOf(host, ss, '通知'), log: sheetIdOf(host, ss, '操作履歴') };
  const today = Date.parse('2026-10-19T00:00:00+09:00');
  let n = 0;
  for (let i = days; i >= 1; i--) {
    const date = ymd(today - i * DAY_MS);
    for (const slotId of ['S1', 'S2', 'S3', 'S4']) {
      const [label, st, en, off, price] = SLOT[slotId];
      const next = ymd(today - i * DAY_MS + off * DAY_MS);
      for (const space of ['91', '92']) {
        const id = String(100000 + (n++ % 899999));
        const at = `${date}T07:00:00+09:00`;
        host.store.appendRow(ss, ids.res, [`'${id}`, `'seed-${n}`, "'確定", "'PHONE", `'${date}`, `'${slotId}`, `'${label}`, 1, price,
          `'${date}T${st}:00+09:00`, `'${next}T${en}:00+09:00`, "'過去 太郎", "'A棟", `'${100 + (n % 300)}`, "'090-0000-0000", '', "'電話",
          `'${at}`, `'${at}`, `'${at}`, "'管理 一郎 <admin@example.org>", '', '', '']);
        host.store.appendRow(ss, ids.alc, [`'${id}`, `'${date}`, `'${slotId}`, `'${space}`, "'有効", `'${at}`]);
        host.store.appendRow(ss, ids.ntf, [`'${id}`, "'電話連絡済み", '', 0, '', `'${at}`, "'管理 一郎", `'${at}`]);
        host.store.appendRow(ss, ids.log, [`'${at}`, "'代行登録", "'管理 一郎", `'${id}`, "'電話受付", `'${label}`]);
      }
    }
  }
  return n;
}

const auth = { email: ACTORS.admin.email, secret: ACTORS.admin.secret };
const CALLS = [
  ['電話の登録（1件）', 'api_admin_register', (i) => [auth, { requestId: `rq-m-${i}-${Date.now()}`, date: '2026-10-28', slotId: ['S1', 'S2', 'S3', 'S4'][i % 4], quantity: 1, channel: 'PHONE', name: '測定 花子', room: '101', phone: '090-1111-2222' }]],
  ['住民の空き状況（1か月）', 'api_getAvailability', () => [{ from: '2026-11-01', to: '2026-11-30' }]],
  ['管理者の台帳（1週間）', 'api_admin_availability', () => [auth, { from: '2026-10-19', to: '2026-10-25' }]],
  ['管理者の予約一覧（1週間）', 'api_admin_list', () => [auth, { from: '2026-10-19', to: '2026-10-25' }]],
  ['電話連絡の一覧', 'api_admin_callList', () => [auth]],
  ['名前で探す', 'api_admin_list', () => [auth, { text: '測定' }]],
];

async function measure(years, archive) {
  const env = await createEnv({ rules: { maxQuantityPerRequest: 1, capacityPerSlot: 2, residentBooking: false, viewMonths: 3 } });
  const rows = seed(env, Math.round(365 * years));
  const out = { years, rows, label: `${years}年分${archive ? '・保管後' : ''}`, items: [] };
  if (archive) {
    // 保管（D-023）を1回動かす。初めての保管なので、ほぼ全ての行を移す
    const r = await env.host.run('job_archiveLedger', [], { kind: 'trigger' });
    if (!r.ok || r.value.status !== 'OK') throw new Error('保管が失敗: ' + JSON.stringify(r.error || r.value));
    out.archive = { moved: r.value.moved, wallMs: r.metrics.wallMs, estGasMs: r.metrics.estGasMs };
  }
  for (const [name, fn, args] of CALLS) {
    const ms = []; const est = []; let ok = true;
    for (let i = 0; i < 5; i++) {
      const r = await env.host.run(fn, args(i), { kind: 'client', user: ACTORS.admin.email });
      if (!r.ok) ok = false;
      ms.push(r.metrics.wallMs); est.push(r.metrics.estGasMs);
    }
    ms.sort((a, b) => a - b); est.sort((a, b) => a - b);
    out.items.push({ name, wallMs: ms[2], estGasMs: est[2], ok });
  }
  await env.host.close();
  return out;
}

module.exports = { seed };

if (require.main === module) (async () => {
  const res = [];
  for (const y of [0, 1, 3]) res.push(await measure(y, false));
  res.push(await measure(3, true));
  const names = res[0].items.map((x) => x.name);
  console.log('台帳の行が増えたときの処理時間（エミュレータ。5回の中央値）');
  console.log(`過去の予約の行数：${res.map((r) => `${r.years}年分=${r.rows}行`).join('、')}`);
  console.log('');
  console.log(['処理', ...res.map((r) => `${r.label} 実時間`), '推定（GAS）'].join(' | '));
  names.forEach((n, i) => {
    console.log([n, ...res.map((r) => `${r.items[i].wallMs}ms${r.items[i].ok ? '' : '（失敗）'}`), `${res[0].items[i].estGasMs}ms`].join(' | '));
  });
  const a = res[res.length - 1].archive;
  console.log('');
  console.log(`初めての保管（3年分のうち ${a.moved}件を移す）：実時間 ${a.wallMs}ms、推定 ${a.estGasMs}ms`);
})().catch((e) => { console.error(e); process.exit(1); });
