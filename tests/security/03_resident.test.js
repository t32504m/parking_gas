'use strict';
// 侵入試験 面C：住民の側（docs/PENTEST.md 2.3）。住民が予約できる設定（residentBooking・residentLookup を開ける）でも試す
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, R, v, adminAuth, snapshot, allPii } = require('./sec-helpers');

const OPEN = { residentBooking: true, residentLookup: true };
const days = (from, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
const fake = (i, o = {}) => ({ requestId: `rq-atk-${String(i).padStart(6, '0')}-${Date.now()}`, quantity: 1, name: `偽名 ${i}`, building: 'Z棟', room: String(900 + i), phone: `090-0000-${String(i).padStart(4, '0')}`, ...o });

test('[PT-C1] 受付を閉じているとき（本番の既定）は、画面を通さずに呼んでも、申込み・予約の確認ができない', async (t) => H.withEnv(t, { rules: { residentBooking: false, residentLookup: false } }, async (env) => {
  const reg = await v(env, 'api_admin_register', [adminAuth(), env.req(R[0], { channel: 'PHONE' })]);
  assert.equal(reg.status, 'CONFIRMED');
  const before = snapshot(env.host);
  for (const o of [{}, { residentBooking: true }, { channel: 'PHONE' }, { channel: 'COUNTER', operator: 'x' }]) {
    const r = await v(env, 'api_submitReservation', [env.req(R[1], o)]);
    assert.equal(r.status, 'REJECTED', `閉じているのに ${r.status}`);
  }
  const l = await v(env, 'api_lookupReservation', [{ reservationId: reg.reservationId, phoneTail: R[0].phone.slice(-4) }]);
  assert.notEqual(l.status, 'OK', '閉じているのに予約の確認が答えた');
  assert.equal(snapshot(env.host), before, '閉じているのに台帳が変わった');
}));

test('[PT-C2] 受付の範囲（過ぎた日・始まったコマ・直前・遠い日）を、画面を通さずに破れない', async (t) => H.withEnv(t, { rules: { ...OPEN, residentLeadDays: 5, residentViewMonths: 2 } }, async (env) => {
  // 今は 2026-10-19 9:00。住民に見せるのは 10/24〜12/19
  const cases = [['2026-10-18', 'S4'], ['2026-10-19', 'S1'], ['2026-10-19', 'S4'], ['2026-10-23', 'S2'], ['2026-12-20', 'S1'], ['2027-10-19', 'S1'], ['2025-10-19', 'S1']];
  for (const [date, slotId] of cases) {
    const r = await v(env, 'api_submitReservation', [env.req(R[0], { date, slotId })]);
    assert.equal(r.status, 'REJECTED', `${date} ${slotId} の申込みが ${r.status}`);
  }
  assert.equal(env.table('reservations').rows.filter((x) => x.state === '確定').length, 0);
}));

test('[PT-C3] 1回の台数・1コマの台数・使用禁止を、画面を通さずに破れない', async (t) => H.withEnv(t, { rules: { ...OPEN, capacityPerSlot: 2, maxQuantityPerRequest: 1 } }, async (env) => {
  assert.equal((await v(env, 'api_submitReservation', [env.req(R[0], { quantity: 2 })])).status, 'REJECTED', '2台の申込みが通った');
  for (let i = 0; i < 4; i++) await v(env, 'api_submitReservation', [env.req(R[i], { slotId: 'S2', preferSpace: '93' })]);
  const s2 = env.table('allocations').rows.filter((a) => a.slot_id === 'S2' && a.state === '有効');
  assert.ok(s2.length <= 2, `1コマ2台なのに ${s2.length} 台`);
  const blk = await v(env, 'api_admin_addBlock', [adminAuth(), { requestId: 'rq-block-0001', from: H.DAY, to: H.DAY, slots: ['S3'], reason: '工事・点検', memo: '', confirm: true }]);
  assert.equal(blk.status, 'OK');
  for (const preferSpace of ['', '91', '92', '93']) {
    const r = await v(env, 'api_submitReservation', [env.req(R[5], { slotId: 'S3', preferSpace })]);
    assert.equal(r.status, 'REJECTED', `使用禁止のコマ（区画 ${preferSpace || '指定なし'}）の申込みが ${r.status}`);
  }
}));

test('[PT-C4] 同じ名前・部屋・電話で、続けて9コマを取れない（依頼者の「連続は4〜8コマくらい」）', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const got = [];
  for (const date of days('2026-10-26', 3)) {
    for (const slotId of ['S1', 'S2', 'S3', 'S4']) {
      if (got.length >= 9) break;
      const r = await v(env, 'api_submitReservation', [env.req(R[0], { date, slotId })]);
      got.push(r.status);
    }
  }
  const ok = got.filter((s) => s === 'CONFIRMED').length;
  assert.ok(ok < 9, `1人が続けて ${ok} コマを確定できた`);
}));

test('[PT-C5] 名前を変えながら画面を通さずに大量に申し込んでも、受付の範囲の枠を1人で埋められない', async (t) => H.withEnv(t, { rules: { ...OPEN, capacityPerSlot: 2 } }, async (env) => {
  let ok = 0, tries = 0;
  for (const date of days('2026-10-26', 5)) {
    for (const slotId of ['S1', 'S2', 'S3', 'S4']) {
      for (let k = 0; k < 2; k++) {
        const r = await v(env, 'api_submitReservation', [fake(tries++, { date, slotId })]);
        if (r.status === 'CONFIRMED') ok++;
      }
    }
  }
  const av = await v(env, 'api_getAvailability', [{ from: '2026-10-26', to: '2026-10-30' }]);
  const open = av.days.flatMap((d) => d.slots).filter((s) => s.bookable).length;
  assert.ok(ok < tries, `1つの呼び手が、${tries} 件の申込みを全て確定させた（5日分の空きの残り ${open} コマ）`);
}));

test('[PT-C6] 他人のメールで大量に申し込んでも、本物の住民の通知のメールが、その日に届かなくならない', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  let n = 0;
  for (const date of days('2026-10-20', 10)) {
    for (const slotId of ['S1', 'S2', 'S3', 'S4']) {
      for (let k = 0; k < 3 && n < 100; k++) {
        const r = await v(env, 'api_submitReservation', [fake(n, { date, slotId, email: `victim${n}@example.com`, name: '至急 example.net/x へ' })]);
        if (r.status === 'CONFIRMED') n++;
      }
    }
  }
  const mine = await v(env, 'api_submitReservation', [env.req(R[0], { date: '2026-11-10', slotId: 'S1', email: R[0].email })]);
  assert.equal(mine.status, 'CONFIRMED');
  await env.host.run('job_processNotifications', [], { kind: 'trigger' });
  const toVictims = env.host.outbox.filter((m) => /^victim/.test(m.to)).length;
  const toMe = env.host.outbox.filter((m) => m.to === R[0].email).length;
  assert.equal(toMe, 1, `攻撃者の ${n} 件の申込みで、確かめていない宛先へ ${toVictims} 通が送られ、本物の住民の通知が送られなかった（1日の上限 100 通）`);
}));

test('[PT-C7] 予約の確認（予約番号＋電話の下4けた）を総当たりできない', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const b = await v(env, 'api_submitReservation', [env.req(R[0], { slotId: 'S2' })]);
  const tail = R[0].phone.slice(-4);
  for (let i = 0; i < 30; i++) {
    const g = String(i).padStart(4, '0');
    if (g !== tail) await v(env, 'api_lookupReservation', [{ reservationId: b.reservationId, phoneTail: g }]);
  }
  const r = await v(env, 'api_lookupReservation', [{ reservationId: b.reservationId, phoneTail: tail }]);
  assert.notEqual(r.status, 'OK', `30回外した後も、当たりの下4けたで予約（${r.summary && r.summary.date} ${r.summary && r.summary.slotLabel}）が見えた`);
}));

test('[PT-C8] 予約の確認・結果の確かめ・空き状況の応答から、他人の個人情報を集められない', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push(await v(env, 'api_submitReservation', [env.req(R[i], { slotId: ['S1', 'S2', 'S3', 'S4'][i], email: R[i].email })]));
  await v(env, 'api_admin_register', [adminAuth(), env.req(R[5], { slotId: 'S1', channel: 'PHONE' })]);
  const out = [];
  for (let i = 0; i < 4; i++) {
    out.push(await v(env, 'api_lookupReservation', [{ reservationId: ids[i].reservationId, phoneTail: R[i].phone.slice(-4) }]));
    out.push(await v(env, 'api_getRequestStatus', [{ requestId: env.table('reservations').rows[i].request_id }]));
  }
  out.push(await v(env, 'api_getAvailability', [{ from: H.DAY, to: H.DAY }]));
  out.push(await v(env, 'api_getRequestStatus', [{ requestId: '' }]), await v(env, 'api_lookupReservation', [{ reservationId: '', phoneTail: '' }]));
  assert.deepEqual(H.findLeaks(out, allPii()), [], '公開の応答に個人情報');
  const s = JSON.stringify(out);
  for (const k of ['登録者', 'operator', 'channel', '電話番号', 'phone', 'email', 'メール', 'room', 'building']) assert.ok(!s.includes(`"${k}"`), `公開の応答に ${k} の欄`);
}));

test('[PT-C9] 他人の受付要求ID を使い回しても、他人の予約を書き換えられず、個人情報も見えない', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const victim = env.req(R[0], { slotId: 'S3', email: R[0].email });
  assert.equal((await v(env, 'api_submitReservation', [victim])).status, 'CONFIRMED');
  const before = env.table('reservations').rows.map((x) => JSON.stringify(x)).join('\n');
  const r = await v(env, 'api_submitReservation', [{ ...env.req(R[9], { slotId: 'S4', date: '2026-10-27' }), requestId: victim.requestId }]);
  assert.equal(env.table('reservations').rows.map((x) => JSON.stringify(x)).join('\n'), before, '使い回しで台帳が変わった');
  assert.deepEqual(H.findLeaks(r, allPii()), [], '使い回しの応答に個人情報');
  // 画面が作る受付要求ID は、推測できない長さ・作り方（crypto の乱数 96 ビット）
  const common = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'src', 'Common.html'), 'utf8');
  assert.match(common, /crypto\.getRandomValues\(a\)/);
  assert.match(common, /new Uint8Array\((1[2-9]|[2-9]\d)\)/);
}));

test('[PT-C10] 住民の入口から、他人の予約を取り消す・書き換えることはできない', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const victim = await v(env, 'api_submitReservation', [env.req(R[0], { slotId: 'S3' })]);
  const before = snapshot(env.host);
  const tail = R[0].phone.slice(-4);
  const evil = { reservationId: victim.reservationId, phoneTail: tail, state: '取消済み', status: 'CANCELLED', cancel: true, action: 'cancel', date: '2026-10-27', slotId: 'S1' };
  await v(env, 'api_lookupReservation', [evil]);
  await v(env, 'api_getRequestStatus', [evil]);
  await v(env, 'api_getAvailability', [evil]);
  const sub = await v(env, 'api_submitReservation', [{ ...env.req(R[1]), ...evil, requestId: 'rq-evil-cancel-1' }]);
  const after = snapshot(env.host);
  const victimRow = env.table('reservations').rows.find((x) => String(x.reservation_id) === victim.reservationId);
  assert.equal(victimRow.state, '確定', `他人の予約の状態が ${victimRow.state}`);
  if (sub.status === 'CONFIRMED') assert.notEqual(sub.reservationId, victim.reservationId);
  assert.ok(after.includes(victim.reservationId) && before.includes(victim.reservationId));
  const pub = Object.entries(H.CONTRACT.surface.functions).filter(([, k]) => k === 'public').map(([f]) => f).sort();
  assert.deepEqual(pub, ['api_getAvailability', 'api_getRequestStatus', 'api_lookupReservation', 'api_submitReservation', 'doGet', 'doPost'], '住民の入口が増えた（取消し・変更の入口を足すなら、ここで試す。doPost は D-034 で増えた＝08_dopost で確認）');
}));
