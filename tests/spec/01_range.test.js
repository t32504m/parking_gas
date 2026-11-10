'use strict';
// A. 日付の範囲・境目（D-014, D-020, D-021, D-023, REQ 5）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, addDays, TODAY } = require('./spec-env');

const days = (r) => (r.days || []).map((d) => d.date);
// 1回に頼める期間には上限がある（63日）。長い期間は分けて頼み、返った日をつなぐ。
async function allDays(env, from, to, admin = false) {
  const out = [];
  for (let f = from; f <= to; f = addDays(f, 50)) {
    const t2 = addDays(f, 49) < to ? addDays(f, 49) : to;
    const r = admin ? await env.adminAvail(f, t2) : await env.avail(f, t2);
    assert.equal(r.status, 'OK', `${f}〜${t2}: ${JSON.stringify(r)}`);
    // 管理者向けは範囲の外の日も「受付外」として返るので、受け付けるコマのある日だけを数える
    out.push(...(admin ? (r.days || []).filter((d) => d.slots.some((x) => x.bookable)).map((d) => d.date) : days(r)));
  }
  return out;
}

test('[S-001] 住民向けの空き状況は今日+5日〜今日+2か月だけ（11/9 なら 11/14〜1/9）', async (t) => {
  await withSpec(t, async (env) => {
    const d = await allDays(env, '2026-11-01', '2027-03-31');
    assert.equal(d[0], '2026-11-14');
    assert.equal(d[d.length - 1], '2027-01-09');
    assert.equal(d.length, 57);
  });
});

test('[S-002] 範囲の外だけを頼んでも、住民向けには返さない', async (t) => {
  await withSpec(t, async (env) => {
    for (const [f, to] of [['2026-11-09', '2026-11-13'], ['2027-01-10', '2027-02-28'], ['2026-10-01', '2026-11-08']]) {
      assert.deepEqual(await allDays(env, f, to), [], `${f}〜${to} で日が返った`);
    }
    // 頼む範囲を省いても、範囲の外は返さない
    const r2 = await env.pub('api_getAvailability', {});
    for (const d of days(r2)) assert.ok(d >= '2026-11-14' && d <= '2027-01-09', `範囲の外 ${d}`);
    const r3 = await env.pub('api_getAvailability');
    for (const d of days(r3)) assert.ok(d >= '2026-11-14' && d <= '2027-01-09', `範囲の外 ${d}`);
  });
});

test('[S-003] 日付の切替えは日本時間（0:30 JST は UTC では前の日）', async (t) => {
  await withSpec(t, { now: '2026-11-09T00:30:00+09:00' }, async (env) => {
    const d = await allDays(env, '2026-11-01', '2027-03-31');
    assert.equal(d[0], '2026-11-14');
    assert.equal(d[d.length - 1], '2027-01-09');
  });
  await withSpec(t, { now: '2026-11-08T23:59:00+09:00' }, async (env) => {
    const d = await allDays(env, '2026-11-01', '2027-03-31');
    assert.equal(d[0], '2026-11-13');
  });
});

test('[S-004] 月末からの2か月・3か月が月の外へあふれない', async (t) => {
  await withSpec(t, { now: '2026-11-30T09:00:00+09:00' }, async (env) => {
    const d = await allDays(env, '2026-11-01', '2027-03-31');
    assert.equal(d[0], '2026-12-05');
    assert.equal(d[d.length - 1], '2027-01-30');
  });
  await withSpec(t, { now: '2026-12-31T09:00:00+09:00' }, async (env) => {
    const d = await allDays(env, '2026-12-01', '2027-04-30');
    assert.equal(d[d.length - 1], '2027-02-28', '12/31 の2か月先が3月にあふれた');
    const ad = await allDays(env, '2026-12-31', '2027-05-31', true);
    assert.equal(ad[ad.length - 1], '2027-03-31');
  });
  await withSpec(t, { now: '2026-11-30T09:00:00+09:00' }, async (env) => {
    const a = await allDays(env, '2026-11-30', '2027-05-31', true);
    assert.equal(a[a.length - 1], '2027-02-28', '11/30 の3か月先が3月にあふれた');
    assert.equal((await env.register({ date: '2027-02-28' })).status, 'CONFIRMED');
    assert.notEqual((await env.register({ date: '2027-03-01' })).status, 'CONFIRMED');
  });
});

test('[S-005] 管理者の登録は今日〜3か月先。3か月+1日は断り、台帳に割当てを残さない', async (t) => {
  await withSpec(t, async (env) => {
    assert.equal((await env.register({ date: '2027-02-09', slotId: 'S4' })).status, 'CONFIRMED');
    const r = await env.register({ date: '2027-02-10', slotId: 'S1' });
    assert.notEqual(r.status, 'CONFIRMED');
    assert.equal(env.activeAllocs('2027-02-10').length, 0);
    const a = await allDays(env, '2026-11-09', '2027-06-01', true);
    assert.equal(a[0], '2026-11-09');
    assert.equal(a[a.length - 1], '2027-02-09');
  });
});

test('[S-006] 管理者は過ぎた日・始まったコマも登録できる（60日以内）', async (t) => {
  await withSpec(t, async (env) => {
    for (const [date, slotId] of [[addDays(TODAY, -1), 'S1'], [TODAY, 'S1'], [addDays(TODAY, -60), 'S4']]) {
      const r = await env.register({ date, slotId });
      assert.equal(r.status, 'CONFIRMED', `${date} ${slotId}: ${JSON.stringify(r)}`);
    }
  });
});

test('[S-007] 保管の境目：61日前は管理者も登録できない。60日前はできる', async (t) => {
  await withSpec(t, async (env) => {
    const r61 = await env.register({ date: '2026-09-09', slotId: 'S2' });
    assert.notEqual(r61.status, 'CONFIRMED');
    assert.equal(env.activeAllocs('2026-09-09').length, 0);
    assert.equal((await env.register({ date: '2026-09-10', slotId: 'S2' })).status, 'CONFIRMED');
  });
});

test('[S-008] 夜コマ（D）は翌朝8:00終了・600円。月末をまたいでも翌月1日になる', async (t) => {
  await withSpec(t, async (env) => {
    const r = await env.register({ date: '2026-11-30', slotId: 'S4' });
    assert.equal(r.status, 'CONFIRMED');
    const x = env.resById(r.reservationId);
    assert.equal(String(x['開始日時']).slice(0, 16), '2026-11-30T17:00');
    assert.equal(String(x['終了日時']).slice(0, 16), '2026-12-01T08:00');
    assert.equal(Number(x['料金合計']), 600);
    const r2 = await env.register({ date: '2026-12-31', slotId: 'S4' });
    const y = env.resById(r2.reservationId);
    assert.equal(String(y['終了日時']).slice(0, 16), '2027-01-01T08:00');
    const r3 = await env.register({ date: '2026-11-30', slotId: 'S1' });
    assert.equal(Number(env.resById(r3.reservationId)['料金合計']), 300);
  });
});

test('[S-009] 管理者の空き状況：夜コマは17:00で「始まった」になる', async (t) => {
  const slot = async (env, date, id) => (await env.adminAvail(date, date)).days[0].slots.find((s) => s.slotId === id);
  await withSpec(t, { now: '2026-11-09T16:59:00+09:00' }, async (env) => {
    assert.equal((await slot(env, TODAY, 'S4')).past, false);
    assert.equal((await slot(env, TODAY, 'S3')).past, true);
    env.host.setClock('2026-11-09T17:00:00+09:00');
    assert.equal((await slot(env, TODAY, 'S4')).past, true);
    // 翌朝 7:59：前の日の夜コマはまだ使用中だが、始まっている
    env.host.setClock('2026-11-10T07:59:00+09:00');
    const s = await env.adminAvail(TODAY, '2026-11-10');
    const d9 = s.days.find((d) => d.date === TODAY);
    if (d9) assert.equal(d9.slots.find((x) => x.slotId === 'S4').past, true);
    assert.equal(s.days.find((d) => d.date === '2026-11-10').slots.find((x) => x.slotId === 'S1').past, false);
  });
});

test('[S-010] 住民の予約（開いたとき）は今日+5日〜2か月先だけ', async (t) => {
  await withSpec(t, { rules: { residentBooking: true } }, async (env) => {
    const sub = (date) => env.pub('api_submitReservation', { ...env.regReq({ date }), channel: undefined });
    const r4 = await sub('2026-11-13');
    assert.notEqual(r4.status, 'CONFIRMED');
    assert.equal((await sub('2026-11-14')).status, 'CONFIRMED');
    assert.equal((await sub('2027-01-09')).status, 'CONFIRMED');
    const r = await sub('2027-01-10');
    assert.notEqual(r.status, 'CONFIRMED');
    assert.equal(env.activeAllocs('2026-11-13').length + env.activeAllocs('2027-01-10').length, 0);
  });
});

test('[S-011] 住民の予約（開いたとき）は、始まったコマを断る', async (t) => {
  await withSpec(t, { rules: { residentBooking: true, residentLeadDays: 0 } }, async (env) => {
    const sub = (o) => env.pub('api_submitReservation', env.regReq(o));
    assert.notEqual((await sub({ date: TODAY, slotId: 'S1' })).status, 'CONFIRMED');
    assert.notEqual((await sub({ date: addDays(TODAY, -1), slotId: 'S4' })).status, 'CONFIRMED');
    assert.equal((await sub({ date: TODAY, slotId: 'S2' })).status, 'CONFIRMED');
  });
});
