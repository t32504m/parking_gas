'use strict';
// E. 権限（REQ 9, D-001, D-009, D-014, D-022, D-023, 検討 1）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, ADMIN, ADMIN2, PEOPLE, rid, pii, leaks } = require('./spec-env');

const D = '2026-11-20';
const OK_STATES = ['OK', 'CONFIRMED', 'CHANGED', 'PREVIEW', 'CANCELLED'];

function snapshot(env) {
  const o = {};
  for (const n of env.sheetNames()) if (n !== '操作履歴') o[n] = JSON.stringify(env.grid(n));
  return o;
}

test('[S-060] 管理者用の関数を、資格なしで直接呼んでも、何も返さない・何も変えない', async (t) => {
  await withSpec(t, async (env) => {
    const p = PEOPLE[3];
    const a = await env.register({ date: D, person: p, email: 'secret-mail@example.net' });
    const b = await env.admin('api_admin_addBlock', { requestId: rid(), from: D, to: D, slots: ['S4'], spaces: ['93'], reason: '工事・点検', memo: 'メモ', confirm: true });
    const id = a.reservationId;
    const calls = {
      api_admin_register: env.regReq({ date: D, slotId: 'S2' }),
      api_admin_list: { from: D, to: D },
      api_admin_cancel: { reservationId: id, reason: '管理者の判断', requestId: rid() },
      api_admin_change: { reservationId: id, date: '2026-11-21', slotId: 'S3', name: 'x', building: '', room: '1', phone: '0', email: '' },
      api_admin_callList: undefined,
      api_admin_markCalled: { reservationId: id },
      api_admin_addBlock: { requestId: rid(), from: D, to: D, slots: ['S1'], spaces: ['91', '92', '93'], reason: '行事', memo: '', confirm: true },
      api_admin_releaseBlock: { blockId: b.blockId },
      api_admin_blockList: {},
      api_admin_availability: { from: D, to: D },
      api_admin_monthTable: { month: '2026-11' },
      api_admin_exportMonth: { month: '2026-11' },
    };
    const creds = [
      ['資格なし', {}], ['空', { email: '', secret: '' }], ['null', null],
      ['パスコード違い', { email: ADMIN.email, secret: 'wrong-pass-0000' }],
      ['別の管理者のパスコード', { email: ADMIN.email, secret: ADMIN2.secret }],
      ['知らないメール', { email: 'stranger@example.com', secret: ADMIN.secret }],
      ['偽の確認の印', { token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }],
      ['大文字だけ違うメール', { email: ADMIN.email.toUpperCase(), secret: 'x' }],
    ];
    const before = snapshot(env);
    const needles = pii([p]).concat(['secret-mail@example.net', 'メモ']);
    for (const [fn, q] of Object.entries(calls)) {
      for (const [label, cr] of creds) {
        const args = q === undefined ? [cr] : [cr, q];
        const r = env.val(await env.raw(fn, args));
        assert.ok(!OK_STATES.includes(r.status), `${fn}（${label}）が ${r.status} を返した`);
        assert.deepEqual(leaks(r, needles), [], `${fn}（${label}）が個人情報を返した`);
      }
      // 資格を渡さない（引数なし）
      const r0 = env.val(await env.raw(fn, []));
      assert.ok(!OK_STATES.includes(r0.status), `${fn}（引数なし）が ${r0.status}`);
    }
    assert.deepEqual(snapshot(env), before, '資格なしの呼び出しで台帳が変わった');
  });
});

test('[S-061] 住民のメールでは管理者になれない', async (t) => {
  await withSpec(t, async (env) => {
    const r = await env.pub('api_admin_login', { email: 'resident1@example.net', secret: 'anything-1234' });
    assert.notEqual(r.status, 'OK');
    assert.ok(!r.token);
    const l = await env.admin('api_admin_list', { from: D, to: D }, { email: 'resident1@example.net', secret: 'anything-1234' });
    assert.notEqual(l.status, 'OK');
  });
});

test('[S-062] 正しいメールとパスコードで確認でき、確認の印でも操作できる。印は6時間で切れる', async (t) => {
  await withSpec(t, async (env) => {
    const lg = await env.pub('api_admin_login', { email: ADMIN.email, secret: ADMIN.secret });
    assert.equal(lg.status, 'OK');
    assert.ok(lg.token);
    const tok = { token: lg.token };
    assert.equal(env.val(await env.raw('api_admin_list', [tok, { from: D, to: D }])).status, 'OK');
    env.host.advanceClock(5 * 3600 * 1000 + 59 * 60 * 1000);
    assert.equal(env.val(await env.raw('api_admin_list', [tok, { from: D, to: D }])).status, 'OK');
    env.host.advanceClock(2 * 60 * 1000);
    assert.notEqual(env.val(await env.raw('api_admin_list', [tok, { from: D, to: D }])).status, 'OK', '6時間を過ぎた印で操作できた');
    const reg = env.val(await env.raw('api_admin_register', [tok, env.regReq({ date: D })]));
    assert.notEqual(reg.status, 'CONFIRMED');
  });
});

test('[S-063] 5回続けて間違えると15分止まる。その間は正しいパスコードでも入れない', async (t) => {
  await withSpec(t, async (env) => {
    for (let i = 0; i < 5; i++) assert.notEqual((await env.pub('api_admin_login', { email: ADMIN.email, secret: `bad-${i}-xxxx` })).status, 'OK');
    const r = await env.pub('api_admin_login', { email: ADMIN.email, secret: ADMIN.secret });
    assert.notEqual(r.status, 'OK', '止まっている間に正しいパスコードで入れた');
    assert.equal(r.reason, 'LOCKED');
    const l = await env.admin('api_admin_list', { from: D, to: D });
    assert.notEqual(l.status, 'OK', '止まっている間に、パスコードを付けた関数の呼び出しが通った');
    // 別の管理者は止まらない
    assert.equal((await env.pub('api_admin_login', { email: ADMIN2.email, secret: ADMIN2.secret })).status, 'OK');
    env.host.advanceClock(15 * 60 * 1000 + 1000);
    assert.equal((await env.pub('api_admin_login', { email: ADMIN.email, secret: ADMIN.secret })).status, 'OK');
  });
});

test('[S-064] パスコードの前後の空白・改行は無視する', async (t) => {
  await withSpec(t, async (env) => {
    assert.equal((await env.pub('api_admin_login', { email: ADMIN.email, secret: `  ${ADMIN.secret}\n` })).status, 'OK');
    assert.equal((await env.pub('api_admin_login', { email: ` ${ADMIN.email} `, secret: ADMIN.secret })).status, 'OK');
  });
});

async function archivable(env) {
  const r = await env.register({ date: '2026-09-02', slotId: 'S1', email: 'old@example.net' });
  await env.runTrigger('job_processNotifications');
  env.host.setClock('2026-11-09T03:00:00+09:00');
  return r;
}

test('[S-065] トリガー用の関数を画面から呼んでも、何もしない', async (t) => {
  await withSpec(t, { now: '2026-09-01T09:00:00+09:00' }, async (env) => {
    await archivable(env);
    const b = await env.register({ date: '2026-11-25', email: 'new@example.net' });
    const before = snapshot(env);
    const sent0 = env.host.outbox.length;
    for (const user of [null, 'resident1@example.net']) {
      await env.raw('job_archiveLedger', [], user);
      await env.raw('job_archiveLedger', [{ triggerUid: 'x', authMode: 'FULL' }], user);
      await env.raw('job_processNotifications', [], user);
    }
    assert.deepEqual(snapshot(env), before, '画面からの呼び出しで台帳が変わった');
    assert.equal(env.host.outbox.length, sent0, '画面からの呼び出しでメールが送られた');
    assert.ok(b.reservationId);
  });
});

test('[S-066] 初期設定の関数を画面から呼んでも、管理者や設定が変わらない', async (t) => {
  await withSpec(t, async (env) => {
    const evil = { email: 'evil@example.com', name: '悪い 人', secret: 'evil-pass-9999' };
    const props0 = JSON.stringify([...env.host.props.script.entries()]);
    await env.raw('setup_init', [{ residentBooking: true, residentLookup: true }, [evil]]);
    await env.raw('setup_run', []);
    assert.equal(JSON.stringify([...env.host.props.script.entries()]), props0, 'スクリプトプロパティが変わった');
    assert.notEqual((await env.pub('api_admin_login', { email: evil.email, secret: evil.secret })).status, 'OK');
    assert.equal((await env.pub('api_submitReservation', env.regReq({ date: D }))).status, 'REJECTED');
  });
});

test('[S-067] 住民の申込みは、閉じているとき台帳に何も書かずに断る', async (t) => {
  await withSpec(t, async (env) => {
    const before = snapshot(env);
    const r = await env.pub('api_submitReservation', env.regReq({ date: D }));
    assert.notEqual(r.status, 'CONFIRMED');
    assert.equal(r.reason, 'CLOSED');
    assert.deepEqual(snapshot(env), before);
    // 管理者の資格を足しても、住民の入口からは確定しない
    const r2 = await env.pub('api_submitReservation', { ...env.regReq({ date: D }), email: ADMIN.email, secret: ADMIN.secret, channel: 'PHONE' });
    assert.notEqual(r2.status, 'CONFIRMED');
  });
});

test('[S-068] 予約の確認は、閉じているとき正しい番号と下4けたでも中身を返さない', async (t) => {
  await withSpec(t, async (env) => {
    const p = PEOPLE[1];
    const a = await env.register({ date: D, slotId: 'S4', person: p });
    const r = await env.pub('api_lookupReservation', { reservationId: a.reservationId, phoneTail: p.phone.slice(-4) });
    assert.notEqual(r.status, 'OK');
    const s = JSON.stringify(r);
    assert.ok(!s.includes(D) && !s.includes('600') && !s.includes(p.name), s);
  });
});

test('[S-069] 予約の確認を開いたとき：正しい組合せだけ答え、氏名・電話番号は返さない', async (t) => {
  await withSpec(t, { rules: { residentLookup: true } }, async (env) => {
    const p = PEOPLE[2];
    const a = await env.register({ date: D, slotId: 'S4', person: p });
    const r = await env.pub('api_lookupReservation', { reservationId: a.reservationId, phoneTail: p.phone.slice(-4) });
    const s = JSON.stringify(r);
    assert.ok(s.includes(D) && s.includes('600'), s);
    assert.deepEqual(leaks(r, pii([p])), []);
    const w = await env.pub('api_lookupReservation', { reservationId: a.reservationId, phoneTail: '0000' });
    assert.ok(!JSON.stringify(w).includes(D), '下4けた違いで中身が返った');
    const e = await env.pub('api_lookupReservation', { reservationId: a.reservationId, phoneTail: '' });
    assert.ok(!JSON.stringify(e).includes(D), '下4けたが空で中身が返った');
  });
});

test('[S-070] 操作履歴に、誰が登録・変更・取消しをしたかが残る', async (t) => {
  await withSpec(t, async (env) => {
    const req = env.regReq({ date: D });
    const a = await env.register(req);
    await env.admin('api_admin_change', { reservationId: a.reservationId, date: D, slotId: 'S2', name: req.name, building: req.building, room: req.room, phone: req.phone, email: '' }, ADMIN2);
    await env.admin('api_admin_cancel', { reservationId: a.reservationId, reason: '本人から電話', requestId: rid() }, ADMIN2);
    const au = env.audit().filter((x) => String(x['予約番号']) === String(a.reservationId));
    assert.equal(au.length, 3, JSON.stringify(au));
    assert.ok(String(au[0]['操作者']).includes(ADMIN.email));
    assert.ok(String(au[1]['操作者']).includes(ADMIN2.email));
    assert.ok(String(au[2]['操作者']).includes(ADMIN2.email));
    assert.ok(String(au[2]['理由']).includes('本人から電話'));
  });
});
