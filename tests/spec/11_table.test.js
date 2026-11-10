'use strict';
// K. 予約表（D-017）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, rid, ADMIN, PEOPLE } = require('./spec-env');

const NOV = '予約表 2026年11月';
const SLOT_I = { S1: 0, S2: 1, S3: 2, S4: 3 };
const SP_COL = { 91: 2, 92: 4, 93: 6 };
/** 見出し2行のあと、1日4行（A〜D）。列は 日付・時間帯・(申込者・適用)×3 */
function cell(env, sheet, date, slotId, space) {
  const g = env.grid(sheet);
  const day = Number(date.slice(8, 10));
  const row = g[2 + (day - 1) * 4 + SLOT_I[slotId]];
  return { name: String(row[SP_COL[space]] ?? ''), note: String(row[SP_COL[space] + 1] ?? ''), slotText: String(row[1]), dateText: String(row[0]) };
}
const spaceOf = (env, id) => String(env.allocations().find((a) => String(a['予約番号']) === String(id) && a['状態'] === '有効')['駐車場']);

test('[S-160] 登録すると月の予約表のシートができ、日付×A〜D×区画の位置に氏名が入る', async (t) => {
  await withSpec(t, async (env) => {
    const p = PEOPLE[7];
    const r = await env.register({ date: '2026-11-20', slotId: 'S3', person: p });
    assert.ok(env.sheetNames().includes(NOV));
    const c = cell(env, NOV, '2026-11-20', 'S3', spaceOf(env, r.reservationId));
    assert.equal(c.name, p.name);
    assert.ok(c.slotText.startsWith('C'));
  });
});

test('[S-161] 適用に棟・部屋番号と経路（電話・窓口）が入る', async (t) => {
  await withSpec(t, async (env) => {
    const p = PEOPLE[8];
    const a = await env.register({ date: '2026-11-21', slotId: 'S1', person: p, channel: 'PHONE' });
    const b = await env.register({ date: '2026-11-21', slotId: 'S2', person: PEOPLE[9], channel: 'COUNTER' });
    const ca = cell(env, NOV, '2026-11-21', 'S1', spaceOf(env, a.reservationId));
    assert.ok(ca.note.includes(p.room), ca.note);
    assert.ok(ca.note.includes(p.building), ca.note);
    assert.ok(ca.note.includes('電話'), ca.note);
    const cb = cell(env, NOV, '2026-11-21', 'S2', spaceOf(env, b.reservationId));
    assert.ok(cb.note.includes('窓口'), cb.note);
  });
});

test('[S-162] 使用禁止は「使用禁止」、管理者が使うときは「管理者」と出る', async (t) => {
  await withSpec(t, async (env) => {
    await env.admin('api_admin_addBlock', { requestId: rid(), from: '2026-11-22', to: '2026-11-23', slots: ['S1'], spaces: ['91'], reason: '工事・点検', memo: '舗装', confirm: true });
    await env.admin('api_admin_addBlock', { requestId: rid(), from: '2026-11-22', to: '2026-11-22', slots: ['S4'], spaces: ['93'], reason: '管理者が使う', memo: '', confirm: true });
    const a = cell(env, NOV, '2026-11-22', 'S1', '91');
    assert.equal(a.name, '使用禁止');
    assert.ok(a.note.includes('工事・点検') && a.note.includes('舗装'), a.note);
    assert.equal(cell(env, NOV, '2026-11-23', 'S1', '91').name, '使用禁止');
    assert.equal(cell(env, NOV, '2026-11-22', 'S4', '93').name, '管理者');
    assert.equal(cell(env, NOV, '2026-11-22', 'S1', '92').name, '');
  });
});

test('[S-163] 取り消した予約は予約表から消える。解除した使用禁止も消える', async (t) => {
  await withSpec(t, async (env) => {
    const p = PEOPLE[10];
    const r = await env.register({ date: '2026-11-24', person: p });
    const sp = spaceOf(env, r.reservationId);
    await env.admin('api_admin_cancel', { reservationId: r.reservationId, reason: '本人から電話', requestId: rid() });
    assert.equal(cell(env, NOV, '2026-11-24', 'S1', sp).name, '');
    const b = await env.admin('api_admin_addBlock', { requestId: rid(), from: '2026-11-25', to: '2026-11-25', slots: ['S2'], spaces: ['92'], reason: '行事', memo: '', confirm: true });
    await env.admin('api_admin_releaseBlock', { blockId: b.blockId });
    assert.equal(cell(env, NOV, '2026-11-25', 'S2', '92').name, '');
  });
});

test('[S-164] 書き出しで作り直せ、操作履歴に残る。手で書き換えた予約表は上書きされる', async (t) => {
  await withSpec(t, async (env) => {
    const p = PEOPLE[11];
    const r = await env.register({ date: '2026-11-26', person: p });
    const sp = spaceOf(env, r.reservationId);
    const sh = env.host.store.book(env.ssId).sheets.find((x) => x.name === NOV);
    const row = 3 + 25 * 4;
    env.host.store.setValues(env.ssId, sh.sheetId, row, SP_COL[sp] + 1, [['いたずら']], 'test');
    assert.equal(cell(env, NOV, '2026-11-26', 'S1', sp).name, 'いたずら');
    const ex = await env.admin('api_admin_exportMonth', { month: '2026-11' });
    assert.equal(ex.status, 'OK', JSON.stringify(ex));
    assert.equal(cell(env, NOV, '2026-11-26', 'S1', sp).name, p.name);
    assert.ok(env.audit().some((x) => String(x['操作']).includes('予約表') || String(x['内容']).includes('予約表')), '書き出しが操作履歴に無い');
    // 台帳は予約表の書き換えで変わらない
    assert.equal(env.resById(r.reservationId)['氏名'], p.name);
  });
});

test('[S-165] 画面の予約表とシートの中身が同じ予約を示す', async (t) => {
  await withSpec(t, async (env) => {
    for (let i = 0; i < 6; i++) await env.register({ date: `2026-11-${10 + i}`, slotId: ['S1', 'S4'][i % 2], person: PEOPLE[i] });
    await env.admin('api_admin_addBlock', { requestId: rid(), from: '2026-11-16', to: '2026-11-16', slots: ['S2'], spaces: ['93'], reason: '管理者が使う', memo: '', confirm: true });
    const mt = await env.admin('api_admin_monthTable', { month: '2026-11' });
    assert.equal(mt.status, 'OK');
    const g = env.grid(NOV);
    assert.equal(mt.rows.length, 30 * 4);
    mt.rows.forEach((row, i) => {
      row.cells.forEach((c, j) => {
        assert.equal(String(g[2 + i][2 + j * 2] ?? ''), String(c.name ?? ''), `${row.date} ${row.slotId} ${mt.spaces[j]}`);
      });
    });
  });
});

test('[S-166] 見出しは駐車場枠91・92・93、1日4行で、夜は翌朝8:00まで', async (t) => {
  await withSpec(t, async (env) => {
    await env.register({ date: '2026-11-20' });
    const g = env.grid(NOV);
    const h = g[0].join('|');
    for (const s of ['91', '92', '93']) assert.ok(h.includes(s), h);
    assert.deepEqual(g[1].slice(0, 4), ['日付', '時間帯', '申込者', '適用']);
    assert.equal(g.length, 2 + 30 * 4);
    const d = g[2 + 3];
    assert.ok(String(d[1]).startsWith('D') && String(d[1]).includes('翌朝8:00'), String(d[1]));
    assert.ok(String(g[2][0]).includes('1'), '1日目の日付の欄');
  });
});

test('[S-167] 書込みがどこで失敗しても、応答と台帳が食い違わない（予約表の失敗で予約の結果を変えない）', async (t) => {
  await withSpec(t, async (env) => {
    for (let k = 1; k <= 14; k++) {
      const req = env.regReq({ date: `2026-11-${String(10 + k).padStart(2, '0')}`, slotId: 'S2' });
      env.host.setFaults({ sheetWrite: { fn: 'api_admin_register', failAt: k } });
      const r = env.val(await env.raw('api_admin_register', [env.auth(ADMIN), req]));
      env.host.clearFaults();
      const row = env.reservations().find((x) => x['受付要求ID'] === req.requestId);
      const inLedger = !!row && row['状態'] === '確定';
      if (r.status === 'CONFIRMED') assert.ok(inLedger, `k=${k}: 確定と答えたのに台帳に無い`);
      if (inLedger) assert.ok(r.status === 'CONFIRMED' || r.status === 'ERROR', `k=${k}: 台帳では確定なのに ${r.status} と答えた`);
      const st = await env.pub('api_getRequestStatus', { requestId: req.requestId });
      assert.equal(st.status === 'CONFIRMED', inLedger, `k=${k}: 結果の確かめと台帳が食い違う`);
    }
  });
});

test('[S-168] 登録の実行が途中で止まり、送り直されなくても、見えない予約が枠をふさぎ続けない', async (t) => {
  for (let at = 1; at <= 6; at++) await withSpec(t, async (env) => {
    const req = env.regReq({ date: '2026-11-20', slotId: 'S2' });
    env.host.setFaults({ terminateAfterWrite: { fn: 'api_admin_register', at } });
    await env.raw('api_admin_register', [env.auth(ADMIN), req]);
    env.host.clearFaults();
    // 管理者は送り直さない。時間がたち、ほかの操作が続く
    env.host.advanceClock(3600 * 1000);
    await env.register({ date: '2026-11-21' });
    await env.runTrigger('job_processNotifications');
    const held = env.activeAllocs('2026-11-20', 'S2').filter((a) => {
      const r = env.resById(a['予約番号']);
      return !r || r['状態'] !== '確定';
    });
    const list = await env.admin('api_admin_list', { from: '2026-11-20', to: '2026-11-20' });
    assert.ok(held.length === 0 || list.reservations.length > 0, `at=${at}: 確定していない予約が枠をふさぎ、管理者の一覧にも出ない`);
  });
});
