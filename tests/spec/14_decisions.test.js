'use strict';
// 依頼者の決定（2026-11-09）から足した項目
//  Q-3：住民向けの応答に台数の数を入れない（管理者向けは数を返してよい）
//  C-3：予約の変更が途中で止まっても、片付けた後は変更前か変更後のどちらかにそろう
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, rid, ymdOf, PEOPLE, pii, leaks, slotOpen, ADMIN, CONTRACT } = require('./spec-env');

const D = '2026-11-20';

/** 応答の中の、台数の数に当たる欄（数値）を探す。maxQuantity（1回に申し込める台数の決まり）は空きの数ではないので除く */
const COUNT_KEYS = ['remaining', 'capacity', 'used', 'booked', 'count', 'free', 'left', 'vacancy', 'vacancies', 'total', 'occupied', 'reserved'];
function countFields(v, at = '$', out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => countFields(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (COUNT_KEYS.includes(k) && typeof x === 'number') out.push(`${at}.${k}=${x}`);
      countFields(x, `${at}.${k}`, out);
    }
  } else if (typeof v === 'string' && /残り\s*[0-9０-９]|あと\s*[0-9０-９]\s*台|空き\s*[0-9０-９]\s*台/.test(v)) out.push(`${at}="${v}"`);
  return out;
}

/** 外に置いた住民の画面と同じ経路（doPost に {fn, arg} の JSON）で呼び、応答の JSON を返す（D-034） */
async function viaPost(env, fn, arg) {
  const r = await env.host.run('doPost', [{ postData: { contents: JSON.stringify({ fn, arg }), type: 'text/plain' }, parameter: {} }], { kind: 'client', user: null });
  if (!r.ok) return { status: 'ERROR', error: r.error };
  return JSON.parse(String(r.value && r.value.content));
}
const PUBLIC = Object.entries(CONTRACT.surface.functions).filter(([, k]) => k === 'public').map(([f]) => f);

// Q-3 は依頼者が決めた（2026-11-09 夜）：住民の各コマは available（真偽）を持ち、remaining・capacity を持たない
test('[S-072] 住民向けの全ての公開関数の応答に、台数の数・他人の名前・部屋番号・電話番号が出ない', async (t) => {
  for (const rules of [{}, { residentBooking: true, residentLeadDays: 0, residentLookup: true }]) {
    await withSpec(t, { rules }, async (env) => {
      // 部屋番号は、予約番号（6けたの数字）・受付要求ID・時刻に偶然には出ない形にする。
      // 前は '201' などの3けたで、予約番号に偶然 '201' が入ると落ちた（2026-11-12、60回中3回）
      const ps = PEOPLE.slice(0, 4).map((p, i) => ({ ...p, room: `R${9 - i}x${7 - i}` }));
      // 1台入ったコマ（前の△）と、2台で満車のコマ
      const a = await env.register({ date: D, slotId: 'S1', person: ps[0], email: 'p0@example.net' });
      await env.register({ date: D, slotId: 'S2', person: ps[1] });
      await env.register({ date: D, slotId: 'S2', person: ps[2] });
      const regA = env.resById(a.reservationId);
      const needles = pii(ps).concat(['p0@example.net', ps[0].room, ps[1].room, ps[2].room]);
      const seen = [];

      const av = await env.avail('2026-11-14', '2027-01-09');
      assert.equal(av.status, 'OK');
      seen.push(['api_getAvailability', av]);
      assert.deepEqual(countFields(av).slice(0, 5), [], 'api_getAvailability の応答に台数の数がある');
      const day = av.days.find((d) => d.date === D);
      for (const d of av.days) for (const s of d.slots) assert.equal(typeof s.available, 'boolean', `${d.date} ${s.slotId} に available（真偽）が無い`);
      const s1 = day.slots.find((s) => s.slotId === 'S1');
      const s2 = day.slots.find((s) => s.slotId === 'S2');
      assert.equal(s1.available, true, '1台入ったコマ（残り1台）が available: true でない');
      assert.equal(s2.available, false, '満車のコマが available: false でない');
      // 1台入ったコマと、空のコマが同じに見える（数が分からない）
      const strip = (s) => { const o = { ...s }; delete o.slotId; delete o.mark; delete o.label; delete o.timeText; delete o.start; delete o.end; delete o.price; return JSON.stringify(o); };
      assert.equal(strip(s1), strip(day.slots.find((s) => s.slotId === 'S3')), '1台入ったコマと空のコマが見分けられる');

      seen.push(['api_submitReservation', await env.pub('api_submitReservation', env.regReq({ date: D, slotId: 'S2', person: PEOPLE[9] }))]);
      seen.push(['api_submitReservation(空き)', await env.pub('api_submitReservation', env.regReq({ date: '2026-11-21', slotId: 'S3', person: PEOPLE[9] }))]);
      seen.push(['api_getRequestStatus', await env.pub('api_getRequestStatus', { requestId: regA['受付要求ID'] })]);
      seen.push(['api_getRequestStatus(無い)', await env.pub('api_getRequestStatus', { requestId: 'nonexistent' })]);
      const tail = ps[1].phone.replace(/\D/g, '').slice(-4);
      seen.push(['api_lookupReservation(違う電話)', await env.pub('api_lookupReservation', { reservationId: a.reservationId, phoneTail: tail })]);
      const g = await env.host.run('doGet', [{ parameter: {}, parameters: {}, queryString: '' }], { kind: 'client', user: null });
      assert.ok(g.ok, JSON.stringify(g.error));

      // 同じ呼び出しを doPost（外に置いた住民の画面の経路）でも行う
      const viaArgs = [
        ['api_getAvailability', { from: '2026-11-14', to: '2027-01-09' }],
        ['api_submitReservation', env.regReq({ date: D, slotId: 'S2', person: PEOPLE[10] })],
        ['api_getRequestStatus', { requestId: regA['受付要求ID'] }],
        ['api_lookupReservation', { reservationId: a.reservationId, phoneTail: tail }],
        ['config', null],
      ];
      for (const [fn, arg] of viaArgs) seen.push([`doPost(${fn})`, await viaPost(env, fn, arg)]);
      const pav = seen.find(([n]) => n === 'doPost(api_getAvailability)')[1];
      assert.equal(pav.days.find((d) => d.date === D).slots.find((s) => s.slotId === 'S2').available, false, 'doPost の空き状況で満車が分からない');

      for (const [fn, r] of seen) {
        assert.deepEqual(countFields(r), [], `${fn} の応答に台数の数がある`);
        assert.deepEqual(leaks(r, needles), [], `${fn} の応答に個人情報がある`);
      }
      const html = String((g.value && g.value.content) || '');
      assert.deepEqual(needles.filter((n) => html.includes(n)), [], 'doGet の画面に個人情報がある');
      // 本人の照会（電話の下4けたが合う）でも、他人の情報と台数の数は出ない
      const own = await env.pub('api_lookupReservation', { reservationId: a.reservationId, phoneTail: ps[0].phone.replace(/\D/g, '').slice(-4) });
      assert.deepEqual(countFields(own), [], 'api_lookupReservation（本人）の応答に台数の数がある');
      assert.deepEqual(leaks(own, pii(ps.slice(1))), [], 'api_lookupReservation（本人）の応答に他人の情報がある');
      assert.ok(PUBLIC.every((f) => ['doGet', 'doPost', 'api_getAvailability', 'api_submitReservation', 'api_getRequestStatus', 'api_lookupReservation'].includes(f)), `試験していない公開関数: ${PUBLIC}`);
    });
  }
});

test('[S-073] 管理者向けの空き状況は、台数の数を返す（全ての区画の3台から数える。D-040）', async (t) => {
  await withSpec(t, async (env) => {
    await env.register({ date: D, slotId: 'S1' });
    const s = (await env.adminAvail(D, D)).days[0].slots.find((x) => x.slotId === 'S1');
    assert.equal(s.remaining, 2);
    await env.register({ date: D, slotId: 'S1' });
    assert.equal((await env.adminAvail(D, D)).days[0].slots.find((x) => x.slotId === 'S1').remaining, 1, '住民には×の2台で、管理者の残りが1でない');
    await env.register({ date: D, slotId: 'S1' });
    assert.equal((await env.adminAvail(D, D)).days[0].slots.find((x) => x.slotId === 'S1').remaining, 0);
  });
});

// ---- C-3：変更の途中で止まった後 ----

const JOBS = Object.entries(CONTRACT.surface.functions).filter(([, k]) => k === 'job').map(([f]) => f);
/** 片付け：時間がたち、ほかの操作と全てのトリガーが動く */
async function afterCleanup(env) {
  env.host.advanceClock(3600 * 1000);
  await env.admin('api_admin_list', { from: D, to: '2026-11-30' });
  await env.register({ date: '2026-11-28', slotId: 'S4' });
  for (const j of JOBS) await env.runTrigger(j);
}
const mine = (env, id) => env.allocations().filter((a) => String(a['予約番号']) === String(id) && a['状態'] === '有効');
/** 予約は変更前か変更後のどちらか一方にそろっている。'before' / 'after' を返す */
function settled(env, id, before, after, label) {
  const r = env.resById(id);
  assert.ok(r, `${label}: 予約が消えた`);
  assert.equal(r['状態'], '確定', `${label}: 予約が確定でなくなった`);
  const m = mine(env, id);
  assert.equal(m.length, 1, `${label}: 有効な割当てが ${m.length} 件（1件のはず）: ${m.map((a) => `${ymdOf(a['利用日'])} ${a['コマID']}`)}`);
  const at = { date: ymdOf(m[0]['利用日']), slotId: m[0]['コマID'] };
  const res = { date: ymdOf(r['利用日']), slotId: r['コマID'] };
  assert.deepEqual(res, at, `${label}: 予約の行と割当てが食い違う`);
  if (at.date === before.date && at.slotId === before.slotId) return 'before';
  if (at.date === after.date && at.slotId === after.slotId) return 'after';
  assert.fail(`${label}: 変更前でも変更後でもない ${JSON.stringify(at)}`);
}

async function runChangeWithFault(env, fault, label) {
  const p = PEOPLE[3];
  const req = env.regReq({ date: D, slotId: 'S1', person: p });
  const x = await env.register(req);
  assert.equal(x.status, 'CONFIRMED');
  const before = { date: D, slotId: 'S1' };
  const after = { date: '2026-11-25', slotId: 'S3' };
  env.host.setFaults(fault);
  const r = env.val(await env.raw('api_admin_change', [env.auth(ADMIN), { reservationId: x.reservationId, ...after, name: p.name, building: p.building, room: p.room, phone: p.phone, email: '' }]));
  env.host.clearFaults();
  await afterCleanup(env);
  const where = settled(env, x.reservationId, before, after, label);
  if (r.status === 'CHANGED') assert.equal(where, 'after', `${label}: 変更したと答えたのに変更前に戻った`);
  // 片付けた後、放した側の枠は空いている（2台入れられる）
  const other = where === 'before' ? after : before;
  assert.equal(env.activeAllocs(other.date, other.slotId).length, 0, `${label}: 放したはずの枠に割当てが残る`);
  // 管理者の一覧で、1件として見える
  const list = await env.admin('api_admin_list', { from: D, to: '2026-11-30' });
  assert.equal(list.reservations.filter((y) => y.reservationId === x.reservationId).length, 1, `${label}: 管理者の一覧で1件に見えない`);
  return where;
}

test('[S-124] 変更の実行がどこで止まっても、片付けた後は変更前か変更後のどちらかにそろう', async (t) => {
  for (let at = 1; at <= 8; at++) {
    await withSpec(t, async (env) => { await runChangeWithFault(env, { terminateAfterWrite: { fn: 'api_admin_change', at } }, `止めた場所 ${at}`); });
  }
});

test('[S-125] 変更の書込みがどこで失敗しても、片付けた後は変更前か変更後のどちらかにそろう。「変更した」と答えたら変更後', async (t) => {
  for (let k = 1; k <= 8; k++) {
    await withSpec(t, async (env) => { await runChangeWithFault(env, { sheetWrite: { fn: 'api_admin_change', failAt: k } }, `失敗させた書込み ${k}`); });
  }
});

test('[S-126] 変更先が取れないときは、途中で止まっても何も変えない（元の枠を放さない）', async (t) => {
  for (let at = 1; at <= 4; at++) {
    await withSpec(t, async (env) => {
      const p = PEOPLE[4];
      const x = await env.register({ date: D, slotId: 'S1', person: p });
      await env.register({ date: '2026-11-25', slotId: 'S3' });
      await env.register({ date: '2026-11-25', slotId: 'S3' });
      await env.register({ date: '2026-11-25', slotId: 'S3' }); // 管理者の上限（3台）で満車
      env.host.setFaults({ terminateAfterWrite: { fn: 'api_admin_change', at } });
      await env.raw('api_admin_change', [env.auth(ADMIN), { reservationId: x.reservationId, date: '2026-11-25', slotId: 'S3', name: p.name, building: p.building, room: p.room, phone: p.phone, email: '' }]);
      env.host.clearFaults();
      await afterCleanup(env);
      assert.equal(settled(env, x.reservationId, { date: D, slotId: 'S1' }, { date: '2026-11-25', slotId: 'S3' }, `止めた場所 ${at}`), 'before');
      assert.equal(env.activeAllocs('2026-11-25', 'S3').length, 3);
    });
  }
});

test('[S-127] 変更が途中で止まった後も、変更先・変更元の枠は上限（管理者の3台）を超えて入らない', async (t) => {
  for (let at = 1; at <= 6; at++) {
    await withSpec(t, async (env) => {
      const p = PEOPLE[5];
      const x = await env.register({ date: D, slotId: 'S1', person: p });
      await env.register({ date: D, slotId: 'S1' });
      env.host.setFaults({ terminateAfterWrite: { fn: 'api_admin_change', at } });
      await env.raw('api_admin_change', [env.auth(ADMIN), { reservationId: x.reservationId, date: '2026-11-25', slotId: 'S3', name: p.name, building: p.building, room: p.room, phone: p.phone, email: '' }]);
      env.host.clearFaults();
      // 片付けの前に、両方の枠へ登録を重ねる（上限は withSpec の後の確かめと、ここで見る）
      for (let i = 0; i < 4; i++) { await env.register({ date: D, slotId: 'S1' }); await env.register({ date: '2026-11-25', slotId: 'S3' }); }
      assert.ok(env.activeAllocs(D, 'S1').length <= 3);
      assert.ok(env.activeAllocs('2026-11-25', 'S3').length <= 3);
      await afterCleanup(env);
      const r = env.resById(x.reservationId);
      assert.equal(r['状態'], '確定', `止めた場所 ${at}: 予約が確定でなくなった`);
      assert.equal(mine(env, x.reservationId).length, 1, `止めた場所 ${at}: 有効な割当てが1件でない`);
    });
  }
});

test('[S-128] 片付けは、変更を正しく終えた予約・ほかの予約を動かさない', async (t) => {
  await withSpec(t, async (env) => {
    const p = PEOPLE[6];
    const x = await env.register({ date: D, slotId: 'S1', person: p });
    const y = await env.register({ date: D, slotId: 'S2', person: PEOPLE[7] });
    const c = await env.admin('api_admin_change', { reservationId: x.reservationId, date: '2026-11-25', slotId: 'S3', name: p.name, building: p.building, room: p.room, phone: p.phone, email: '' });
    assert.equal(c.status, 'CHANGED');
    const snap = JSON.stringify([env.reservations(), env.allocations()].map((rows) => rows.filter((r) => [x.reservationId, y.reservationId].map(String).includes(String(r['予約番号'])))));
    await afterCleanup(env);
    const now = JSON.stringify([env.reservations(), env.allocations()].map((rows) => rows.filter((r) => [x.reservationId, y.reservationId].map(String).includes(String(r['予約番号'])))));
    assert.equal(now, snap);
  });
});
