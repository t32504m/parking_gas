'use strict';
// F. 入力の誤り・式の注入・電話番号（REQ 7.2, CLAUDE 5, 検討 1, D-021）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, ADMIN, hasDate, rid } = require('./spec-env');

const D = '2026-11-20';

test('[S-080] 誤った日付・コマ・台数は断り、台帳に書かない', async (t) => {
  await withSpec(t, async (env) => {
    const bad = [
      { date: '2026/11/20' }, { date: '20261120' }, { date: '2027-02-30' }, { date: '2026-11-31' }, { date: '' }, { date: null },
      { date: '2026-11-20T00:00:00Z' }, { slotId: 'S5' }, { slotId: '' }, { slotId: 's1' }, { slotId: '朝' },
      { quantity: 2 }, { quantity: 0 }, { quantity: -1 }, { quantity: 1.5 }, { quantity: 'abc' }, { quantity: 3 },
    ];
    for (const o of bad) {
      const r = await env.register({ date: D, ...o });
      assert.notEqual(r.status, 'CONFIRMED', `${JSON.stringify(o)} が確定した`);
    }
    assert.equal(env.allocations().length, 0);
    assert.equal(env.reservations().filter((x) => x['状態'] === '確定').length, 0);
  });
});

test('[S-081] 氏名が空・長すぎる・制御文字を含むものは断る', async (t) => {
  await withSpec(t, async (env) => {
    for (const name of ['', '   ', 'あ'.repeat(1000)]) {
      const r = await env.register({ date: D, slotId: 'S3', name });
      assert.notEqual(r.status, 'CONFIRMED', `氏名 ${JSON.stringify(name).slice(0, 30)} が確定した`);
    }
    // 制御文字は、断るか、取り除いて保存する（シートに制御文字が入らない）
    for (const name of ['山田\u0000太郎', '山田\u0007', '山田\u001b[31m']) {
      const r = await env.register({ date: '2026-11-21', slotId: 'S1', name });
      if (r.status === 'CONFIRMED') {
        const v = env.resById(r.reservationId)['氏名'];
        assert.ok(!/[\u0000-\u001f\u007f]/.test(v), `制御文字がシートに入った: ${JSON.stringify(v)}`);
        await env.admin('api_admin_cancel', { reservationId: r.reservationId, reason: '管理者の判断', requestId: rid() });
      }
    }
    const e = await env.register({ date: '2026-11-22', slotId: 'S4', email: 'a@example.net\u0000' });
    if (e.status === 'CONFIRMED') assert.ok(!/[\u0000-\u001f]/.test(env.resById(e.reservationId)['メール']), 'メールに制御文字が入った');
    for (const o of [{ room: 'x'.repeat(500) }, { phone: '1'.repeat(300) }, { email: 'x'.repeat(400) + '@example.net' }, { email: 'メールではない' }]) {
      const r = await env.register({ date: D, slotId: 'S4', ...o });
      assert.notEqual(r.status, 'CONFIRMED', `${JSON.stringify(o).slice(0, 40)} が確定した`);
    }
    assert.equal(env.activeAllocs(D).length, 0);
  });
});

test('[S-082] 式を入れても、シートでは文字のまま（式として動かない）', async (t) => {
  await withSpec(t, async (env) => {
    const evil = ['=HYPERLINK("http://example.com","x")', '+1', '-1', '@SUM(A1)', '=1+1', "'=1+1", '=IMPORTXML("http://e","//a")'];
    const ids = [];
    for (let i = 0; i < evil.length; i++) {
      const r = await env.register({ date: `2026-11-${11 + i}`, slotId: 'S2', name: evil[i], building: evil[(i + 1) % evil.length], room: evil[(i + 2) % evil.length], memo: evil[i] });
      if (r.status === 'CONFIRMED') ids.push([r.reservationId, i]);
    }
    assert.ok(ids.length > 0, '式に見える氏名を全て断った（断るのでもよいが、少なくとも一部は通る想定）');
    const f = env.formulas('予約');
    assert.ok(f.every((row) => row.every((x) => !x)), `予約シートに式が入った: ${JSON.stringify(f.filter((r) => r.some(Boolean)))}`);
    for (const [id, i] of ids) {
      const x = env.resById(id);
      assert.equal(x['氏名'], evil[i]);
      assert.equal(x['棟'], evil[(i + 1) % evil.length]);
      assert.equal(x['部屋番号'], evil[(i + 2) % evil.length]);
    }
    // 予約表・操作履歴にも式が入らない
    for (const n of env.sheetNames()) {
      const g = env.formulas(n);
      assert.ok(g.every((row) => row.every((x) => !x)), `${n} に式が入った`);
    }
  });
});

// D-039（依頼者の決定、2026-11-12）：電話番号は保存のときに書き方をそろえる。前は「入れた形のまま保存」を確かめていた。
const PHONE_CASES = [
  ['09012345678', '090-1234-5678'],
  ['０９０－１２３４－５６７８', '090-1234-5678'],
  ['090 1234 5678', '090-1234-5678'],
  ['(090)1234-5678', '090-1234-5678'],
  ['（０９０）１２３４ー５６７８', '090-1234-5678'],
  ['070‐1234‐5678', '070-1234-5678'],
  ['080−1234−5678', '080-1234-5678'],
  ['0312345678', '03-1234-5678'],
  ['0612345678', '06-1234-5678'],
  ['03-1234-5678', '03-1234-5678'],
  ['045-123-4567', '045-123-4567'],
  ['0451234567', '0451234567'],
  ['0120 123 456', '0120-123-456'],
  ['0120123456', '0120-123-456'],
  ['08001234567', '0800-123-4567'],
  ['+81 90 1234 5678', '+819012345678'],
  ['+81-90-1234-5678', '+81-90-1234-5678'],
];
const digitsOf = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/\D/g, '');

test('[S-083] 電話番号は保存のときに書き方をそろえる。先頭の0・けたは失われず、文字列のまま', async (t) => {
  await withSpec(t, async (env) => {
    const ids = [];
    for (let i = 0; i < PHONE_CASES.length; i++) {
      const [input, want] = PHONE_CASES[i];
      const r = await env.register({ date: `2026-11-${10 + i}`, phone: input });
      assert.equal(r.status, 'CONFIRMED', `${input}: ${JSON.stringify(r)}`);
      const x = env.resById(r.reservationId);
      assert.equal(typeof x['電話番号'], 'string', `${input} が文字列でない`);
      assert.equal(x['電話番号'], want, `${input} の保存の形`);
      assert.equal(digitsOf(x['電話番号']), digitsOf(input), `${input} の数字（先頭の0・けた）が変わった`);
      ids.push([r.reservationId, want]);
    }
    assert.equal(env.host.store.conversionLog.length, 0, `文字が自動で変換された: ${JSON.stringify(env.host.store.conversionLog.slice(0, 5))}`);
    // 管理者の一覧も、そろえた形を返す
    const list = await env.admin('api_admin_list', { from: '2026-11-10', to: '2026-11-30' });
    for (const [id, want] of ids) assert.equal(list.reservations.find((y) => y.reservationId === id).phone, want);
  });
});

test('[S-087] 書き方をそろえた後も、予約の確認（電話の下4けた）は今までどおり通る', async (t) => {
  await withSpec(t, { rules: { residentLookup: true } }, async (env) => {
    const inputs = ['０９０－１２３４－５６７８', '09012345678', '0120 123 456', '+81 90 1234 5678', '045-123-4567', '0451234567'];
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];
      const date = `2026-11-${20 + i}`;
      const r = await env.register({ date, slotId: 'S4', phone: input });
      assert.equal(r.status, 'CONFIRMED', JSON.stringify(r));
      const tail = digitsOf(input).slice(-4);
      // 住民は、入れたときの書き方に関係なく、数字の下4けたで確かめる
      for (const t4 of [tail, tail.replace(/[0-9]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0))]) {
        const ok = await env.pub('api_lookupReservation', { reservationId: r.reservationId, phoneTail: t4 });
        if (t4 === tail || ok.status === 'OK') assert.ok(JSON.stringify(ok).includes(date), `${input}：下4けた ${t4} で確認できない: ${JSON.stringify(ok)}`);
      }
      const ng = await env.pub('api_lookupReservation', { reservationId: r.reservationId, phoneTail: tail === '0000' ? '1111' : '0000' });
      assert.ok(!JSON.stringify(ng).includes(date), `${input}：違う下4けたで中身が返った`);
    }
  });
});

test('[S-084] 部屋番号・棟が数や日付に変わらない', async (t) => {
  await withSpec(t, async (env) => {
    const cases = [['101', 'A棟'], ['10/20', '1'], ['1-2', '2026-11-20'], ['0101', 'TRUE'], ['1,234', '50%']];
    for (let i = 0; i < cases.length; i++) {
      const r = await env.register({ date: `2026-11-${11 + i}`, room: cases[i][0], building: cases[i][1] });
      assert.equal(r.status, 'CONFIRMED');
      const x = env.resById(r.reservationId);
      assert.equal(x['部屋番号'], cases[i][0]);
      assert.equal(x['棟'], cases[i][1]);
    }
    assert.equal(env.host.store.conversionLog.length, 0, `文字が自動で変換された: ${JSON.stringify(env.host.store.conversionLog.slice(0, 5))}`);
  });
});

test('[S-085] 棟は空でも登録できる', async (t) => {
  await withSpec(t, async (env) => {
    const r = await env.register({ date: D, building: '' });
    assert.equal(r.status, 'CONFIRMED');
  });
});

test('[S-086] 画面へ返る値に Date が無い', async (t) => {
  await withSpec(t, async (env) => {
    const req = env.regReq({ date: D, email: 'x@example.net' });
    const rs = [
      await env.register(req),
      await env.avail('2026-11-14', '2026-12-14'),
      await env.adminAvail('2026-11-09', '2026-12-09'),
      await env.admin('api_admin_list', { from: D, to: D }),
      await env.admin('api_admin_list', { text: req.name }),
      await env.admin('api_admin_callList'),
      await env.admin('api_admin_blockList', {}),
      await env.admin('api_admin_monthTable', { month: '2026-11' }),
      await env.admin('api_admin_addBlock', { requestId: rid(), from: '2026-11-21', to: '2026-11-21', slots: ['S1'], spaces: ['91'], reason: '行事', memo: '', confirm: false }),
      await env.pub('api_getRequestStatus', { requestId: req.requestId }),
      await env.pub('api_admin_login', { email: ADMIN.email, secret: ADMIN.secret }),
    ];
    rs.forEach((r, i) => assert.ok(!hasDate(r), `${i} 番目の応答に Date がある`));
  });
});
