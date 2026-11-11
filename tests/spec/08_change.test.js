'use strict';
// H. 管理者の予約の変更（D-024, D-021, D-023, D-017）
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, rid, ymdOf, addDays, TODAY, ADMIN } = require('./spec-env');

const D = '2026-11-20';
const mine = (env, id) => env.allocations().filter((a) => String(a['予約番号']) === String(id) && a['状態'] === '有効');
async function make(env, o = {}) {
  const req = env.regReq({ date: D, ...o });
  const r = await env.register(req);
  assert.equal(r.status, 'CONFIRMED', JSON.stringify(r));
  return { id: r.reservationId, req };
}
const change = (env, x, o = {}) => env.admin('api_admin_change', {
  reservationId: x.id, date: x.req.date, slotId: x.req.slotId, name: x.req.name, building: x.req.building, room: x.req.room, phone: x.req.phone, email: x.req.email, ...o,
});

test('[S-110] 日・時間帯を変えると、新しい枠が取れ、古い枠が空く', async (t) => {
  await withSpec(t, async (env) => {
    const x = await make(env);
    const r = await change(env, x, { date: '2026-11-25', slotId: 'S3' });
    assert.equal(r.status, 'CHANGED', JSON.stringify(r));
    assert.equal(env.activeAllocs(D, 'S1').length, 0);
    const m = mine(env, x.id);
    assert.equal(m.length, 1);
    assert.equal(ymdOf(m[0]['利用日']), '2026-11-25');
    assert.equal(m[0]['コマID'], 'S3');
  });
});

test('[S-111] 変更後の料金・時間帯・開始／終了日時が合い、予約番号・経路・台数は変わらない', async (t) => {
  await withSpec(t, async (env) => {
    const x = await make(env, { channel: 'COUNTER' });
    const before = env.resById(x.id);
    assert.equal((await change(env, x, { date: '2026-11-30', slotId: 'S4' })).status, 'CHANGED');
    const a = env.resById(x.id);
    assert.equal(Number(a['料金合計']), 600);
    assert.equal(a['コマID'], 'S4');
    assert.ok(String(a['時間帯']).includes('D'), `時間帯 ${a['時間帯']}`);
    assert.equal(String(a['開始日時']).slice(0, 16), '2026-11-30T17:00');
    assert.equal(String(a['終了日時']).slice(0, 16), '2026-12-01T08:00');
    assert.equal(a['受付経路'], before['受付経路']);
    assert.equal(Number(a['台数']), 1);
    assert.equal(env.reservations().length, 1, '変更で予約の行が増えた');
  });
});

test('[S-112] 変更先が満車（管理者の上限の3台）なら、何も変えずに理由を返す。住民の上限（2台）なら移れる', async (t) => {
  await withSpec(t, async (env) => {
    const x = await make(env);
    await env.register({ date: '2026-11-21' }); await env.register({ date: '2026-11-21' }); await env.register({ date: '2026-11-21' });
    const before = JSON.stringify(env.grid('予約')) + JSON.stringify(env.grid('割当て'));
    const r = await change(env, x, { date: '2026-11-21', name: '別の 名前' });
    assert.notEqual(r.status, 'CHANGED');
    assert.ok(r.reason || r.reasonText, '理由が無い');
    assert.equal(JSON.stringify(env.grid('予約')) + JSON.stringify(env.grid('割当て')), before, '断ったのに台帳が変わった');
    // 2台入ったコマ（住民には×）へは、管理者の変更で移れる（D-040）
    await env.register({ date: '2026-11-22' }); await env.register({ date: '2026-11-22' });
    const ok = await change(env, x, { date: '2026-11-22' });
    assert.equal(ok.status, 'CHANGED', JSON.stringify(ok));
    assert.equal(env.activeAllocs('2026-11-22', 'S1').length, 3);
  });
});

test('[S-113] 変更先が使用禁止・3か月より先・保管した日付なら、何も変えない', async (t) => {
  await withSpec(t, async (env) => {
    const x = await make(env);
    await env.admin('api_admin_addBlock', { requestId: rid(), from: '2026-11-22', to: '2026-11-22', slots: ['S1'], spaces: ['91', '92', '93'], reason: '行事', memo: '', confirm: true });
    for (const o of [{ date: '2026-11-22' }, { date: '2027-02-10' }, { date: '2026-09-09' }, { date: '2026-11-21', slotId: 'S7' }, { date: '2026-13-01' }]) {
      const r = await change(env, x, o);
      assert.notEqual(r.status, 'CHANGED', `${JSON.stringify(o)} へ変更できた`);
      const m = mine(env, x.id);
      assert.equal(m.length, 1);
      assert.equal(ymdOf(m[0]['利用日']), D);
    }
  });
});

test('[S-114] 2台入ったコマでも、区画だけを空いている区画へ移せる', async (t) => {
  await withSpec(t, async (env) => {
    const x = await make(env, { preferSpace: '91' });
    await env.register({ date: D, preferSpace: '92' });
    const r = await change(env, x, { preferSpace: '93' });
    assert.equal(r.status, 'CHANGED', JSON.stringify(r));
    assert.deepEqual(mine(env, x.id).map((a) => String(a['駐車場'])), ['93']);
    // 埋まっている区画へは移れない
    const r2 = await change(env, x, { preferSpace: '92' });
    assert.notDeepEqual(mine(env, x.id).map((a) => String(a['駐車場'])), ['92'], `92へ重ねて移った: ${JSON.stringify(r2)}`);
  });
});

test('[S-115] 取り消した予約は変更できない', async (t) => {
  await withSpec(t, async (env) => {
    const x = await make(env);
    await env.admin('api_admin_cancel', { reservationId: x.id, reason: '本人から電話', requestId: rid() });
    const r = await change(env, x, { date: '2026-11-21' });
    assert.notEqual(r.status, 'CHANGED');
    assert.equal(env.resById(x.id)['状態'], '取消済み');
    assert.equal(mine(env, x.id).length, 0);
  });
});

test('[S-116] 保管した予約は変更できない', async (t) => {
  await withSpec(t, { now: '2026-09-01T09:00:00+09:00' }, async (env) => {
    const x = await make(env, { date: '2026-09-03', email: 'a@example.net' });
    await env.runTrigger('job_processNotifications');
    env.host.setClock('2026-11-09T03:00:00+09:00');
    await env.runTrigger('job_archiveLedger');
    assert.ok(!env.resById(x.id), '保管されていない（試験の前提）');
    const r = await change(env, x, { date: '2026-11-21' });
    assert.notEqual(r.status, 'CHANGED');
    assert.equal(env.activeAllocs('2026-11-21').length, 0);
    assert.equal(env.reservations().length, 0, '保管した予約が元のシートに戻った');
  });
});

test('[S-117] 氏名・電話番号などの変更が台帳に入り、操作履歴に何をどう変えたかが残る', async (t) => {
  await withSpec(t, async (env) => {
    const x = await make(env);
    const r = await change(env, x, { name: '新しい 名前', phone: '0311112222', room: '0505', date: '2026-11-21', slotId: 'S2' });
    assert.equal(r.status, 'CHANGED');
    const a = env.resById(x.id);
    assert.equal(a['氏名'], '新しい 名前');
    assert.equal(a['電話番号'], '03-1111-2222', '変更でも電話番号の書き方をそろえる（D-039）');
    assert.equal(a['部屋番号'], '0505');
    const au = env.audit().filter((y) => String(y['予約番号']) === String(x.id) && String(y['操作']).includes('変更'));
    assert.equal(au.length, 1);
    const txt = JSON.stringify(au[0]);
    assert.ok(txt.includes('2026-11-20') && txt.includes('2026-11-21'), `日付の変更が記録されない: ${txt}`);
    assert.ok(txt.includes('新しい 名前'), `氏名の変更が記録されない: ${txt}`);
    assert.ok(String(au[0]['操作者']).includes(ADMIN.email));
  });
});

const cellsWith = (env, sheet, text) => (env.grid(sheet) || []).flat().filter((v) => String(v).includes(text)).length;

test('[S-118] 月をまたぐ変更で、古い月と新しい月の予約表が両方とも正しくなる', async (t) => {
  await withSpec(t, async (env) => {
    const x = await make(env, { date: '2026-11-30', name: '月末 移動' });
    assert.equal(cellsWith(env, '予約表 2026年11月', '月末 移動'), 1);
    assert.equal((await change(env, x, { date: '2026-12-01', name: '月末 移動' })).status, 'CHANGED');
    assert.equal(cellsWith(env, '予約表 2026年11月', '月末 移動'), 0, '11月の予約表に古い予約が残った');
    assert.equal(cellsWith(env, '予約表 2026年12月', '月末 移動'), 1, '12月の予約表に出ない');
    const nov = await env.admin('api_admin_monthTable', { month: '2026-11' });
    assert.ok(!JSON.stringify(nov).includes('月末 移動'));
    const dec = await env.admin('api_admin_monthTable', { month: '2026-12' });
    assert.ok(JSON.stringify(dec).includes('月末 移動'));
  });
});

test('[S-119] 過ぎたコマ（60日以内）への変更と、過ぎた予約の変更はできる', async (t) => {
  await withSpec(t, async (env) => {
    const x = await make(env);
    assert.equal((await change(env, x, { date: addDays(TODAY, -1), slotId: 'S3' })).status, 'CHANGED');
    x.req.date = addDays(TODAY, -1); x.req.slotId = 'S3';
    assert.equal((await change(env, x, { name: '直した 名前' })).status, 'CHANGED');
    assert.equal(env.resById(x.id)['氏名'], '直した 名前');
  });
});

test('[S-120] 不成立の予約は変更できない', async (t) => {
  await withSpec(t, { rules: { residentBooking: true } }, async (env) => {
    await env.register({ date: D }); await env.register({ date: D });
    const req = env.regReq({ date: D });
    const s = await env.pub('api_submitReservation', req);
    assert.notEqual(s.status, 'CONFIRMED');
    const row = env.reservations().find((r) => r['受付要求ID'] === req.requestId);
    if (!row) return t.skip('不成立の行が台帳に残らない（D-006 と違う。S-121 で別に確かめる）');
    const r = await env.admin('api_admin_change', { reservationId: row['予約番号'], date: '2026-11-25', slotId: 'S1', name: req.name, building: req.building, room: req.room, phone: req.phone, email: '' });
    assert.notEqual(r.status, 'CHANGED');
    assert.equal(env.resById(row['予約番号'])['状態'], '不成立');
    assert.equal(mine(env, row['予約番号']).length, 0);
  });
});

test('[S-121] 住民の申込みが満車で不成立になったとき、不成立として台帳に残り、受付要求IDで確かめられる', async (t) => {
  await withSpec(t, { rules: { residentBooking: true } }, async (env) => {
    await env.register({ date: D }); await env.register({ date: D });
    const req = env.regReq({ date: D });
    const s = await env.pub('api_submitReservation', req);
    assert.equal(s.status, 'REJECTED');
    const row = env.reservations().find((r) => r['受付要求ID'] === req.requestId);
    assert.ok(row, '不成立の行が無い（D-006）');
    assert.equal(row['状態'], '不成立');
    assert.equal((await env.pub('api_getRequestStatus', { requestId: req.requestId })).status, 'REJECTED');
  });
});
