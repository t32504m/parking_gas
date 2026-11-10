'use strict';
// 権限と公開範囲（要件9・8「セキュリティ」「監査性」・A-08）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS, DAY, CONTRACT, findLeaks, piiOf } = require('../helpers');

const R = ACTORS.residents;
const PRIVILEGED = Object.entries(CONTRACT.surface.functions).filter(([, lvl]) => lvl !== 'public').map(([fn]) => fn);

function snapshot(host, except) {
  const out = [];
  for (const b of host.store.books.values()) {
    for (const s of b.sheets) if (!except.includes(s.name)) out.push(`${s.name}\n${host.store.toCsv(b.id, s.sheetId)}`);
  }
  return out.join('\n---\n') + JSON.stringify([...host.props.script]) + host.triggers.length;
}

test('[9][8セキュリティ] 管理者・運用・ジョブ用の関数は、匿名・一般利用者が直接呼んでも何も変えられない', async (t) => withEnv(t, async (env) => {
  assert.ok(PRIVILEGED.length > 0, 'contract.json の surface.functions に admin/operator/job の関数が宣言されていない');
  await env.adapter.submit(env.host, env.req(R[0], { slotId: 'S1' }), R[0]);
  // 案内のメールは利用日の前日に送る（2026-11-10 依頼者の決定）。通知のジョブに送るものがある状態にして、
  // 呼出し元を確かめないジョブが、匿名・一般利用者からメールの送信や台帳の変更を起こせないことを確かめる
  env.host.setClock(`${new Date(Date.parse(`${DAY}T00:00:00Z`) - 86400000).toISOString().slice(0, 10)}T23:00:00+09:00`);
  const except = CONTRACT.surface.auditSheetsWritableOnDenied || [];
  const attempts = [[], [{}], [{ reservationId: 'x', date: DAY, slotId: 'S1', quantity: 1, name: '攻撃', building: 'A棟', room: '1', reason: 'x', requestId: 'atk' }]];
  for (const who of [ACTORS.anonymous, R[5]]) {
    for (const fn of PRIVILEGED) {
      for (const args of attempts) {
        const before = snapshot(env.host, except);
        const r = await env.host.run(fn, args, { kind: 'client', user: who.email });
        const after = snapshot(env.host, except);
        assert.equal(after, before, `${who.role} が ${fn}(${JSON.stringify(args).slice(0, 60)}) を呼ぶと台帳等が変化した`);
        const leaks = findLeaks(r.value, piiOf([R[0]]));
        assert.deepEqual(leaks, [], `${who.role} が ${fn} を呼ぶと個人情報が返った: ${leaks}`);
      }
    }
  }
}));

test('[9][A-05] 一般利用者は管理者用の予約一覧を見られない', async (t) => withEnv(t, async (env) => {
  await env.adapter.submit(env.host, env.req(R[0], { slotId: 'S1' }), R[0]);
  for (const who of [ACTORS.anonymous, R[1]]) {
    const r = await env.adapter.adminList(env.host, { date: DAY }, who);
    assert.equal(r.status, 'DENIED', `${who.role} の一覧取得が ${r.status}`);
    assert.deepEqual(findLeaks(r.raw, piiOf([R[0]])), [], '拒否の応答に個人情報が含まれる');
  }
}));

test('[9] 管理者用の秘密やURLを知らない者は、管理者になりすませない（画面の切替だけを認証にしない）', async (t) => withEnv(t, async (env) => {
  const fake = { ...ACTORS.admin, secret: 'wrong-secret', email: 'kanri1@example.org' };
  const r = await env.adapter.adminRegister(env.host, env.req(R[2], { slotId: 'S2', channel: 'PHONE' }), fake);
  assert.equal(r.status, 'DENIED', `誤った資格情報での代行登録が ${r.status}`);
  const noSecret = { ...ACTORS.admin, secret: undefined };
  const r2 = await env.adapter.adminRegister(env.host, env.req(R[2], { slotId: 'S2', channel: 'PHONE' }), noSecret);
  assert.equal(r2.status, 'DENIED', `資格情報なしでの代行登録が ${r2.status}`);
}));

test('[A-08][8監査性] 代行登録と取消しについて、誰が・いつ・何を・なぜ行ったか記録される', async (t) => withEnv(t, async (env) => {
  const reg = await env.adapter.adminRegister(env.host, env.req(R[3], { slotId: 'S3', channel: 'COUNTER', email: undefined }), ACTORS.admin);
  assert.equal(reg.status, 'CONFIRMED');
  const c = await env.adapter.adminCancel(env.host, { reservationId: reg.reservationId, reason: '利用者都合（電話）', requestId: 'cx-audit' }, ACTORS.admin2);
  assert.equal(c.status, 'CANCELLED');
  const audit = env.table('audit').rows;
  const mine = audit.filter((a) => String(a.reservation_id) === String(reg.reservationId));
  assert.ok(mine.length >= 2, `監査記録が ${mine.length} 件（登録と取消しの2件以上を期待）`);
  const cancel = mine.find((a) => /cancel|取消/i.test(String(a.action)));
  assert.ok(cancel, '取消しの監査記録が無い');
  assert.ok(String(cancel.operator).includes(ACTORS.admin2.name) || String(cancel.operator).includes(ACTORS.admin2.email), `取消しの操作者 "${cancel.operator}" が管理者2と分からない`);
  assert.ok(String(cancel.reason).includes('利用者都合'), '取消し理由が記録されていない');
}));
