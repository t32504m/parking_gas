'use strict';
// L. 通知・電話連絡（REQ 6.6, D-007, D-012）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, CONTRACT } = require('./spec-env');

const D = '2026-11-20';

test('[S-180] メールの無い電話受付は「電話連絡」として一覧に出て、対応済みにできる', async (t) => {
  await withSpec(t, async (env) => {
    const r = await env.register({ date: D, email: '' });
    const l1 = await env.admin('api_admin_callList');
    const it = l1.items.find((x) => x.reservationId === r.reservationId);
    assert.ok(it && !it.contactDone);
    const m = await env.admin('api_admin_markCalled', { reservationId: r.reservationId });
    assert.ok(m.status !== 'ERROR' && m.status !== 'DENIED', JSON.stringify(m));
    const n = env.sheet('通知').find((x) => String(x['予約番号']) === String(r.reservationId));
    assert.equal(n['状態'], '電話連絡済み');
    const l2 = await env.admin('api_admin_callList');
    const it2 = l2.items.find((x) => x.reservationId === r.reservationId);
    assert.ok(!it2 || it2.contactDone);
  });
});

// 依頼者の決定（2026-11-10）で、メールは受付のときではなく利用日の前日の案内になった。
// 前の S-181（受付のメールの再送）は、前日の案内の送信の失敗に読み替えた。
test('[S-181] 前日の案内の送信が失敗しても、予約は確定のまま。後で送れても2通にならない', async (t) => {
  await withSpec(t, { rules: { remindHour: 18 } }, async (env) => {
    const jobs = async () => { for (const [j, k] of Object.entries(CONTRACT.surface.functions)) if (k === 'job') await env.runTrigger(j); };
    const r = await env.register({ date: D, email: 'mail@example.net' });
    env.host.setClock('2026-11-19T18:00:00+09:00');
    env.host.setFaults({ mail: { failAll: true } });
    await jobs();
    env.host.clearFaults();
    assert.equal(env.resById(r.reservationId)['状態'], '確定');
    assert.equal(env.activeAllocs(D).length, 1);
    assert.equal(env.host.outbox.length, 0);
    for (const iso of ['2026-11-19T18:10:00+09:00', '2026-11-19T21:00:00+09:00', '2026-11-20T07:00:00+09:00']) {
      env.host.setClock(iso);
      await jobs();
    }
    assert.ok(env.host.outbox.filter((m) => m.to === 'mail@example.net').length <= 1, '同じ予約に2通送った');
  });
});
