'use strict';
// J. 保管（D-023）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, ymdOf, PEOPLE } = require('./spec-env');

const START = '2026-09-01T09:00:00+09:00';
const ARCH_AT = '2026-11-09T03:00:00+09:00';
const ids = (rows) => (rows || []).map((r) => String(r['予約番号']));

/** 9月の予約を作る。email あり＝通知を送って済ませる／電話＝対応済みにする／電話＝未対応のまま */
async function seed(env) {
  const P = PEOPLE;
  const mk = async (date, slotId, p, o = {}) => (await env.register({ date, slotId, person: p, ...o })).reservationId;
  const s = {
    mail0905: await mk('2026-09-05', 'S1', P[0], { email: 'p0@example.net' }),
    called0909: await mk('2026-09-09', 'S4', P[1]),
    called0910: await mk('2026-09-10', 'S2', P[2]),
    uncalled0908: await mk('2026-09-08', 'S3', P[3]),
    cancelled0906: await mk('2026-09-06', 'S1', P[4], { email: 'p4@example.net' }),
    future: await mk('2026-11-20', 'S1', P[5], { email: 'p5@example.net' }),
  };
  await env.admin('api_admin_markCalled', { reservationId: s.called0909 });
  await env.admin('api_admin_markCalled', { reservationId: s.called0910 });
  await env.admin('api_admin_cancel', { reservationId: s.cancelled0906, reason: '本人から電話', requestId: 'c-' + s.cancelled0906 });
  await env.runTrigger('job_processNotifications');
  env.host.setClock(ARCH_AT);
  return s;
}

test('[S-140] 60日より前の予約と割当て・通知が保管のシートへ移る。60日前の日は残る', async (t) => {
  await withSpec(t, { now: START }, async (env) => {
    const s = await seed(env);
    const r = await env.runTrigger('job_archiveLedger');
    assert.ok(r.ok, JSON.stringify(r.error));
    const main = ids(env.reservations());
    const arch = ids(env.sheet('予約（保管）'));
    for (const k of ['mail0905', 'called0909', 'cancelled0906']) {
      assert.ok(arch.includes(s[k]), `${k} が保管されない`);
      assert.ok(!main.includes(s[k]), `${k} が元のシートに残った`);
    }
    for (const k of ['called0910', 'future']) assert.ok(main.includes(s[k]) && !arch.includes(s[k]), `${k} が保管された`);
    const aarch = ids(env.sheet('割当て（保管）'));
    assert.ok(aarch.includes(s.mail0905));
    assert.ok(!ids(env.allocations()).includes(s.mail0905));
    assert.ok(ids(env.sheet('通知（保管）')).includes(s.mail0905));
    assert.ok(!ids(env.sheet('通知')).includes(s.mail0905));
  });
});

test('[S-141] 電話連絡が済んでいない確定の予約は移さない', async (t) => {
  await withSpec(t, { now: START }, async (env) => {
    const s = await seed(env);
    await env.runTrigger('job_archiveLedger');
    assert.ok(ids(env.reservations()).includes(s.uncalled0908));
    const calls = await env.admin('api_admin_callList');
    assert.ok(JSON.stringify(calls).includes(s.uncalled0908), '電話連絡の一覧から消えた');
  });
});

function strip(list) { return (list || []).map((x) => { const y = { ...x }; delete y.archived; return y; }).sort((a, b) => String(a.reservationId).localeCompare(String(b.reservationId))); }

test('[S-142] 保管の前後で、名前・予約番号・部屋で探した結果が変わらない', async (t) => {
  await withSpec(t, { now: START }, async (env) => {
    const s = await seed(env);
    const qs = [PEOPLE[0].name, PEOPLE[1].name.split(' ')[0], s.mail0905, s.called0909, PEOPLE[4].room];
    const before = [];
    for (const q of qs) before.push(strip((await env.admin('api_admin_list', { text: q })).reservations));
    await env.runTrigger('job_archiveLedger');
    for (let i = 0; i < qs.length; i++) {
      const after = strip((await env.admin('api_admin_list', { text: qs[i] })).reservations);
      assert.ok(before[i].length > 0, `保管前に ${qs[i]} で見つからない（試験の前提）`);
      assert.deepEqual(after, before[i], `「${qs[i]}」で探した結果が変わった`);
    }
  });
});

test('[S-143] 保管の前後で、古い月の予約表の中身が変わらない', async (t) => {
  await withSpec(t, { now: START }, async (env) => {
    await seed(env);
    const before = await env.admin('api_admin_monthTable', { month: '2026-09' });
    await env.runTrigger('job_archiveLedger');
    const after = await env.admin('api_admin_monthTable', { month: '2026-09' });
    assert.equal(before.status, 'OK');
    assert.deepEqual(after, before);
    assert.ok(JSON.stringify(after).includes(PEOPLE[0].name));
    // 書き出したシートにも出る
    const ex = await env.admin('api_admin_exportMonth', { month: '2026-09' });
    assert.equal(ex.status, 'OK', JSON.stringify(ex));
    assert.ok(JSON.stringify(env.grid('予約表 2026年9月')).includes(PEOPLE[0].name), '書き出した予約表に保管した予約が出ない');
  });
});

test('[S-144] 保管した後も予約番号が重ならない', async (t) => {
  await withSpec(t, { now: START }, async (env) => {
    await seed(env);
    await env.runTrigger('job_archiveLedger');
    const arch = new Set(ids(env.sheet('予約（保管）')));
    for (let i = 0; i < 20; i++) {
      const r = await env.register({ date: `2026-11-${String(10 + (i % 20)).padStart(2, '0')}`, slotId: ['S1', 'S2', 'S3', 'S4'][i % 4] });
      assert.equal(r.status, 'CONFIRMED');
      assert.ok(!arch.has(String(r.reservationId)), `保管の番号 ${r.reservationId} と重なった`);
    }
  });
});

test('[S-145] 保管を2回動かしても、二重に書かない', async (t) => {
  await withSpec(t, { now: START }, async (env) => {
    await seed(env);
    await env.runTrigger('job_archiveLedger');
    const n1 = [env.sheet('予約（保管）').length, env.sheet('割当て（保管）').length, env.sheet('通知（保管）').length];
    await env.runTrigger('job_archiveLedger');
    const n2 = [env.sheet('予約（保管）').length, env.sheet('割当て（保管）').length, env.sheet('通知（保管）').length];
    assert.deepEqual(n2, n1);
    // 次の日：新しく60日を超えた分だけが足され、前に移した分は二重にならない
    env.host.advanceClock(86400000);
    await env.runTrigger('job_archiveLedger');
    for (const n of ['予約（保管）', '割当て（保管）', '通知（保管）']) {
      const k = ids(env.sheet(n));
      assert.equal(new Set(k).size, k.length, `${n} に同じ予約番号が二重`);
    }
  });
});

test('[S-146] 保管の途中で止まっても予約が消えない。次の保管で二重にならない', async (t) => {
  for (let at = 1; at <= 6; at++) {
    await withSpec(t, { now: START }, async (env) => {
      const s = await seed(env);
      const all = Object.values(s).map(String);
      env.host.setFaults({ terminateAfterWrite: { fn: 'job_archiveLedger', at } });
      await env.runTrigger('job_archiveLedger');
      env.host.clearFaults();
      let u = [...ids(env.reservations()), ...ids(env.sheet('予約（保管）'))];
      for (const id of all) assert.ok(u.includes(id), `at=${at}: 予約 ${id} が消えた`);
      await env.runTrigger('job_archiveLedger');
      u = [...ids(env.reservations()), ...ids(env.sheet('予約（保管）'))];
      for (const id of all) assert.equal(u.filter((x) => x === id).length, 1, `at=${at}: 予約 ${id} が ${u.filter((x) => x === id).length} 件`);
      const ua = [...env.allocations(), ...(env.sheet('割当て（保管）') || [])].map((a) => `${a['予約番号']}|${ymdOf(a['利用日'])}|${a['コマID']}|${a['駐車場']}`);
      assert.equal(new Set(ua).size, ua.length, `at=${at}: 割当てが二重`);
      const un = [...ids(env.sheet('通知')), ...ids(env.sheet('通知（保管）'))];
      assert.equal(new Set(un).size, un.length, `at=${at}: 通知が二重`);
    });
  }
});

test('[S-147] 保管の前後で、住民・管理者の空き状況が変わらない', async (t) => {
  await withSpec(t, { now: START }, async (env) => {
    await seed(env);
    const r1 = await env.avail('2026-11-14', '2027-01-09');
    const a1 = await env.adminAvail('2026-09-10', '2026-11-09');
    const a2 = await env.adminAvail('2026-11-09', '2027-01-09');
    await env.runTrigger('job_archiveLedger');
    assert.deepEqual(await env.avail('2026-11-14', '2027-01-09'), r1);
    assert.deepEqual(await env.adminAvail('2026-09-10', '2026-11-09'), a1);
    assert.deepEqual(await env.adminAvail('2026-11-09', '2027-01-09'), a2);
  });
});

test('[S-148] 保管が操作履歴に残る', async (t) => {
  await withSpec(t, { now: START }, async (env) => {
    await seed(env);
    await env.runTrigger('job_archiveLedger');
    assert.ok(env.audit().some((x) => String(x['操作']).includes('保管')));
  });
});

test('[S-149] 保管の前後で、保管した日付の週の一覧が変わらない', async (t) => {
  await withSpec(t, { now: START }, async (env) => {
    await seed(env);
    const q = { from: '2026-09-03', to: '2026-09-09' };
    const before = strip((await env.admin('api_admin_list', q)).reservations);
    const ab = await env.admin('api_admin_blockList', q);
    await env.runTrigger('job_archiveLedger');
    const after = strip((await env.admin('api_admin_list', q)).reservations);
    assert.ok(before.length >= 3);
    assert.deepEqual(after, before);
    assert.deepEqual(await env.admin('api_admin_blockList', q), ab);
  });
});

test('[S-150] 保管した予約も、受付要求IDで結果を確かめられる', async (t) => {
  await withSpec(t, { now: START }, async (env) => {
    const req = env.regReq({ date: '2026-09-04', email: 'q@example.net' });
    const r = await env.register(req);
    await env.runTrigger('job_processNotifications');
    env.host.setClock(ARCH_AT);
    await env.runTrigger('job_archiveLedger');
    assert.ok(!env.resById(r.reservationId), '保管されていない（試験の前提）');
    const st = await env.pub('api_getRequestStatus', { requestId: req.requestId });
    assert.equal(st.status, 'CONFIRMED', `保管した予約の受付要求IDで結果が分からない: ${JSON.stringify(st)}`);
    // 同じ要求の送り直しで、二重にならない
    await env.raw('api_admin_register', [env.auth(require('./spec-env').ADMIN), req]);
    assert.equal(env.reservations().filter((x) => x['受付要求ID'] === req.requestId).length, 0, '保管した予約が、送り直しで元のシートに二重に入った');
  });
});
