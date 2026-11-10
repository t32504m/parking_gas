'use strict';
// 受入試験の共通部品。試験ファイルからは withEnv() を使う。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { GasHost } = require('../harness/emulator/host');
const { checkLedger, readNamed } = require('../harness/invariants');

const ROOT = path.join(__dirname, '..');
const PROJECT_DIR = process.env.HARNESS_PROJECT_DIR ? path.resolve(process.env.HARNESS_PROJECT_DIR) : path.join(ROOT, 'src');
const ADAPTER_PATH = process.env.HARNESS_ADAPTER ? path.resolve(process.env.HARNESS_ADAPTER) : path.join(ROOT, 'contract', 'adapter.js');
const CONTRACT = JSON.parse(fs.readFileSync(process.env.HARNESS_CONTRACT ? path.resolve(process.env.HARNESS_CONTRACT) : path.join(ROOT, 'contract', 'contract.json'), 'utf8'));
const RULES_FILE = JSON.parse(fs.readFileSync(path.join(ROOT, 'contract', 'provisional-rules.json'), 'utf8'));
const REPORT_DIR = process.env.HARNESS_REPORT_DIR ? path.resolve(process.env.HARNESS_REPORT_DIR) : path.join(ROOT, 'reports');
const adapter = require(ADAPTER_PATH);

const RULES = Object.fromEntries(Object.entries(RULES_FILE).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, v.value]));

// 試験の基準時刻（仮想時計）。利用日は 1 週間後の月曜。
const NOW = '2026-10-19T09:00:00+09:00';
const DAY = '2026-10-26';

// 架空の住民。氏名・部屋・連絡先は「一般公開の画面に出てはいけない文字列」として漏えい検査にも使う。
const SURNAMES = ['青柳', '笹島', '桐生', '早乙女', '鬼頭', '東雲', '雨宮', '御手洗', '久遠', '霧島', '朝比奈', '鳳'];
const GIVEN = ['澄子', '巌', '千鶴', '甚八', '小百合', '鉄之助', '綾乃', '権三', '紫苑', '与一', '菫', '玄'];
function resident(i) {
  return {
    role: 'resident', email: `resident${i}@example.net`, name: `${SURNAMES[i % 12]} ${GIVEN[i % 12]}`,
    building: ['A棟', 'B棟', 'C棟'][i % 3], room: String(101 + i * 7), phone: `090-${String(4100 + i).padStart(4, '0')}-${String(7300 + i).padStart(4, '0')}`,
  };
}
const ACTORS = {
  owner: { role: 'owner', email: 'owner@example.com' },
  admin: { role: 'admin', email: 'kanri1@example.org', name: '管理 一郎', secret: crypto.randomBytes(12).toString('hex') },
  admin2: { role: 'admin', email: 'kanri2@example.org', name: '管理 二葉', secret: crypto.randomBytes(12).toString('hex') },
  anonymous: { role: 'anonymous', email: null },
  residents: Array.from({ length: 12 }, (_, i) => resident(i + 1)),
};

function newRequestId() { return `rq-${crypto.randomUUID()}`; }

function reqFor(actor, o = {}) {
  return {
    requestId: newRequestId(), date: DAY, slotId: 'S1', quantity: 1,
    name: actor.name, building: actor.building, room: actor.room, email: actor.email, phone: actor.phone, ...o,
  };
}

let envSeq = 0;
async function createEnv(opts = {}) {
  const host = new GasHost({
    projectDir: PROJECT_DIR, now: opts.now || NOW, latency: opts.latency || { min: 0, max: 0 },
    seed: opts.seed || 7, deployment: opts.deployment, maxExecutionMs: opts.maxExecutionMs,
  });
  const spreadsheetId = `SS_TEST_${++envSeq}`;
  host.createSpreadsheet({ id: spreadsheetId, name: '駐車場予約（試験）' });
  const rules = { ...RULES, ...(opts.rules || {}) };
  await adapter.setup(host, { spreadsheetId, rules, admins: [ACTORS.admin, ACTORS.admin2], contract: CONTRACT });
  const env = {
    host, adapter, spreadsheetId, rules, contract: CONTRACT, actors: ACTORS,
    check: () => checkLedger(host, spreadsheetId, CONTRACT),
    table: (name) => readNamed(host, spreadsheetId, CONTRACT.ledger[name]),
    req: reqFor,
  };
  return env;
}

function slug(s) { return s.replace(/[^\w぀-ヿ一-龯-]+/g, '_').slice(0, 80); }

/**
 * 試験環境を作って fn を実行し、最後に台帳の不変条件を必ず検査する。
 * 失敗時はシートの中身を reports/sheets/<試験名>/ に CSV で残す（原因調査用）。
 */
async function withEnv(t, opts, fn) {
  if (typeof opts === 'function') { fn = opts; opts = {}; }
  const env = await createEnv(opts);
  let err = null;
  try {
    await fn(env);
  } catch (e) { err = e; }
  const inv = env.check();
  const warnings = env.host.warnings.slice();
  if (warnings.length) recordFinding({ test: t.name, kind: 'warning', items: warnings });
  if (env.host.store.conversionLog.length) recordFinding({ test: t.name, kind: 'conversion', items: env.host.store.conversionLog.slice(0, 50) });
  if (err || !inv.ok) env.host.exportCsv(path.join(REPORT_DIR, 'sheets', slug(t.name)));
  await env.host.close();
  if (err) throw err;
  if (!inv.ok) {
    const e = new Error(`台帳の不変条件違反:\n${inv.violations.map((v) => `  [${v.code}] ${v.message}`).join('\n')}`);
    e.violations = inv.violations;
    throw e;
  }
}

/** adapter の任意メソッド。未実装なら試験を「未実装」として skip する。 */
async function optional(t, p) {
  try { return await p; } catch (e) {
    if (e && e.name === 'NotImplemented') { t.skip(`未実装: ${e.message}`); return undefined; }
    throw e;
  }
}

function recordMetric(name, value, unit, meta = {}) {
  fs.mkdirSync(path.join(REPORT_DIR, 'raw'), { recursive: true });
  fs.appendFileSync(path.join(REPORT_DIR, 'raw', 'metrics.jsonl'), `${JSON.stringify({ name, value, unit, ...meta, at: new Date().toISOString() })}\n`);
}
function recordFinding(f) {
  fs.mkdirSync(path.join(REPORT_DIR, 'raw'), { recursive: true });
  fs.appendFileSync(path.join(REPORT_DIR, 'raw', 'findings.jsonl'), `${JSON.stringify(f)}\n`);
}

/** オブジェクトの中に、指定した文字列のどれかが含まれていればそれを返す（個人情報の漏えい検査） */
function findLeaks(obj, needles) {
  const s = JSON.stringify(obj ?? null);
  return needles.filter((n) => n && s.includes(n));
}
function piiOf(actors) {
  return actors.flatMap((a) => [a.name, a.name && a.name.split(' ')[0], a.email, a.phone, a.phone && a.phone.replace(/-/g, '')].filter(Boolean))
    .concat(actors.map((a) => a.room && `${a.building}${a.room}`).filter(Boolean));
}

module.exports = {
  createEnv, withEnv, optional, recordMetric, recordFinding, findLeaks, piiOf, newRequestId, reqFor,
  ACTORS, NOW, DAY, RULES, CONTRACT, PROJECT_DIR, adapter,
};
