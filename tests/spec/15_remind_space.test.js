'use strict';
// 依頼者の決定（2026-11-10）から足した項目
//  1. メールは受付のときではなく、利用日の前日に、1日1回のトリガーで送る（送る時刻は RULES.remindHour）
//  2. 連続の予約を同じ区画に寄せる
const test = require('node:test');
const assert = require('node:assert/strict');
const { withSpec, rid, PEOPLE, ADMIN, CONTRACT } = require('./spec-env');

// ---------------- 1. 前日の案内メール ----------------

const HOUR = 18;
const RM = { rules: { remindHour: HOUR } };
const JOBS = Object.entries(CONTRACT.surface.functions).filter(([, k]) => k === 'job').map(([f]) => f);
/** トリガーを動かす（どの関数が案内を送るかは実装が決めるので、全てのトリガーを動かす） */
async function jobs(env) { for (const j of JOBS) await env.runTrigger(j); }
const at = (env, iso) => env.host.setClock(iso);
const mailsTo = (env, addr) => env.host.outbox.filter((m) => String(m.to).split(',').map((s) => s.trim()).includes(addr));
const mentions = (m, ymd) => {
  const [, mo, d] = ymd.split('-').map(Number);
  const s = JSON.stringify(m);
  return s.includes(`${mo}月${d}日`) || s.includes(`${mo}/${d}`) || s.includes(ymd);
};

test('[S-185] 受付のとき（管理者の登録・住民の申込み）には、メールを送らない', async (t) => {
  await withSpec(t, { rules: { remindHour: HOUR, residentBooking: true, residentLeadDays: 0 } }, async (env) => {
    const a = await env.register({ date: '2026-11-20', email: 'reg@example.net' });
    assert.equal(a.status, 'CONFIRMED');
    const b = await env.pub('api_submitReservation', env.regReq({ date: '2026-11-21', slotId: 'S2', email: 'web@example.net', channel: undefined }));
    assert.equal(b.status, 'CONFIRMED', JSON.stringify(b));
    await jobs(env);
    env.host.advanceClock(30 * 60 * 1000);
    await jobs(env);
    assert.deepEqual(env.host.outbox.map((m) => m.to), [], '受付のときにメールが送られた');
  });
});

test('[S-186] メールのある確定の予約に、利用日の前日の送る時刻（remindHour）に、案内を1通送る', async (t) => {
  for (const hour of [HOUR, 9]) {
    await withSpec(t, { rules: { remindHour: hour } }, async (env) => {
      await env.register({ date: '2026-11-20', slotId: 'S1', email: 'a@example.net' });
      await env.register({ date: '2026-11-20', slotId: 'S4', email: 'night@example.net' });
      // 前日の、送る時刻より前に入った予約にも送る
      at(env, '2026-11-19T08:00:00+09:00');
      await env.register({ date: '2026-11-20', slotId: 'S2', email: 'late@example.net' });
      // 送る時刻の前には送らない
      const hh = String(hour - 1).padStart(2, '0');
      at(env, `2026-11-19T${hh}:59:00+09:00`);
      await jobs(env);
      assert.equal(env.host.outbox.length, 0, `${hour}時より前に送った`);
      at(env, `2026-11-19T${String(hour).padStart(2, '0')}:00:00+09:00`);
      await jobs(env);
      for (const addr of ['a@example.net', 'night@example.net', 'late@example.net']) {
        const ms = mailsTo(env, addr);
        assert.equal(ms.length, 1, `${hour}時: ${addr} へ ${ms.length} 通`);
        assert.ok(mentions(ms[0], '2026-11-20'), `${addr} の案内に利用日が無い: ${JSON.stringify(ms[0])}`);
      }
    });
  }
});

test('[S-187] メールの無い予約・当日の予約・前々日より先の予約には、その日に送らない', async (t) => {
  await withSpec(t, RM, async (env) => {
    await env.register({ date: '2026-11-20', slotId: 'S1', email: '' });
    await env.register({ date: '2026-11-19', slotId: 'S4', email: 'today@example.net' });
    await env.register({ date: '2026-11-21', slotId: 'S1', email: 'later@example.net' });
    at(env, '2026-11-19T18:00:00+09:00');
    await jobs(env);
    assert.equal(mailsTo(env, 'today@example.net').length, 0, '当日の予約に送った');
    assert.equal(mailsTo(env, 'later@example.net').length, 0, '2日後の予約に前々日に送った');
    assert.equal(env.host.outbox.length, 0);
    // 2日後の予約は、その前日に送る
    at(env, '2026-11-20T18:00:00+09:00');
    await jobs(env);
    assert.equal(mailsTo(env, 'later@example.net').length, 1);
    assert.equal(mailsTo(env, 'today@example.net').length, 0, '過ぎた予約に後から送った');
  });
});

test('[S-188] 送る時刻より後に入った翌日の予約、当日に入った当日の予約には送らない', async (t) => {
  await withSpec(t, RM, async (env) => {
    at(env, '2026-11-19T18:00:00+09:00');
    await jobs(env);
    at(env, '2026-11-19T19:00:00+09:00');
    await env.register({ date: '2026-11-20', slotId: 'S1', email: 'after@example.net' });
    await env.register({ date: '2026-11-19', slotId: 'S4', email: 'sameday@example.net' });
    for (const iso of ['2026-11-19T19:05:00+09:00', '2026-11-19T23:00:00+09:00', '2026-11-20T07:00:00+09:00', '2026-11-20T18:00:00+09:00']) {
      at(env, iso);
      await jobs(env);
    }
    assert.equal(mailsTo(env, 'after@example.net').length, 0, '送る時刻より後に入った翌日の予約に送った');
    assert.equal(mailsTo(env, 'sameday@example.net').length, 0, '当日の予約に送った');
  });
});

test('[S-189] 取り消した予約には送らない', async (t) => {
  await withSpec(t, RM, async (env) => {
    const r = await env.register({ date: '2026-11-20', email: 'cx@example.net' });
    await env.admin('api_admin_cancel', { reservationId: r.reservationId, reason: '本人から電話', requestId: rid() });
    at(env, '2026-11-19T18:00:00+09:00');
    await jobs(env);
    assert.equal(mailsTo(env, 'cx@example.net').length, 0);
  });
});

test('[S-190] 管理者が変更した予約には、変更後の利用日の前日に、変更後の日で送る', async (t) => {
  await withSpec(t, RM, async (env) => {
    const p = PEOPLE[2];
    const chg = (id, date, email) => env.admin('api_admin_change', { reservationId: id, date, slotId: 'S1', name: p.name, building: p.building, room: p.room, phone: p.phone, email });
    const a = await env.register({ date: '2026-11-20', person: p, email: 'later@example.net' });
    const b = await env.register({ date: '2026-11-25', slotId: 'S2', person: p, email: 'sooner@example.net' });
    assert.equal((await chg(a.reservationId, '2026-11-25', 'later@example.net')).status, 'CHANGED');
    assert.equal((await chg(b.reservationId, '2026-11-20', 'sooner@example.net')).status, 'CHANGED');
    at(env, '2026-11-19T18:00:00+09:00');
    await jobs(env);
    assert.equal(mailsTo(env, 'later@example.net').length, 0, '変更前の利用日で送った');
    assert.equal(mailsTo(env, 'sooner@example.net').length, 1, '前に変えた予約に送らない');
    assert.ok(mentions(mailsTo(env, 'sooner@example.net')[0], '2026-11-20'));
    at(env, '2026-11-24T18:00:00+09:00');
    await jobs(env);
    assert.equal(mailsTo(env, 'later@example.net').length, 1, '変更後の利用日の前日に送らない');
    assert.ok(mentions(mailsTo(env, 'later@example.net')[0], '2026-11-25'), '変更後の利用日が無い');
    assert.equal(mailsTo(env, 'sooner@example.net').length, 1);
  });
});

test('[S-191] トリガーが2回以上動いても（同時でも）、同じ予約に2通は送らない', async (t) => {
  await withSpec(t, { ...RM, latency: { min: 1, max: 6 }, seed: 77 }, async (env) => {
    await env.register({ date: '2026-11-20', email: 'twice@example.net' });
    at(env, '2026-11-19T18:00:00+09:00');
    await jobs(env);
    await jobs(env);
    await env.host.runConcurrently(JOBS.flatMap((j) => [j, j]).map((fn) => ({ fn, args: [{ triggerUid: 'spec', authMode: 'FULL' }], kind: 'trigger', user: null })));
    at(env, '2026-11-19T18:30:00+09:00');
    await jobs(env);
    at(env, '2026-11-20T18:00:00+09:00');
    await jobs(env);
    assert.equal(mailsTo(env, 'twice@example.net').length, 1);
  });
});

test('[S-192] 1日に送る数は、その日の確定の予約（メールあり）の数を超えない', async (t) => {
  await withSpec(t, RM, async (env) => {
    const D = '2026-11-20';
    await env.register({ date: D, slotId: 'S1', email: 'm1@example.net' });
    await env.register({ date: D, slotId: 'S1', email: 'm2@example.net' });
    await env.register({ date: D, slotId: 'S3', email: 'm3@example.net' });
    await env.register({ date: D, slotId: 'S2', email: '' });
    const c = await env.register({ date: D, slotId: 'S4', email: 'm5@example.net' });
    await env.admin('api_admin_cancel', { reservationId: c.reservationId, reason: '本人から電話', requestId: rid() });
    await env.register({ date: '2026-11-21', slotId: 'S1', email: 'next@example.net' });
    // 不成立（満車）
    await env.register({ date: D, slotId: 'S1', email: 'full@example.net' });
    for (const iso of ['2026-11-19T18:00:00+09:00', '2026-11-19T18:05:00+09:00', '2026-11-19T21:00:00+09:00']) { at(env, iso); await jobs(env); }
    const sent = env.host.outbox.length;
    assert.ok(sent <= env.reservations().filter((r) => r['状態'] === '確定').length, `確定の予約の数より多く送った: ${sent}`);
    assert.deepEqual(env.host.outbox.map((m) => m.to).sort(), ['m1@example.net', 'm2@example.net', 'm3@example.net']);
  });
});

// ---------------- 2. 連続の予約を同じ区画に寄せる ----------------

const SP = ['91', '92', '93'];
const spaceOf = (env, id) => env.allocations().filter((a) => String(a['予約番号']) === String(id) && a['状態'] === '有効').map((a) => String(a['駐車場']));
const X = { name: '寄席 次郎', building: 'B棟', room: '512', phone: '090-7777-0512' };
const Y = { name: '別室 花子', building: 'B棟', room: '513', phone: '090-7777-0513' };
async function reg(env, person, date, slotId, preferSpace, extra = {}) {
  const r = await env.register({ date, slotId, person, ...(preferSpace ? { preferSpace } : {}), ...extra });
  assert.equal(r.status, 'CONFIRMED', `${date} ${slotId} の登録: ${JSON.stringify(r)}`);
  return r;
}
/** 何も無いときに自動で選ばれる区画（別の日で確かめ、取り消す）。寄せる区画はこれと違うものにする */
async function defaultSpace(env, date, slotId) {
  const r = await reg(env, PEOPLE[20], date, slotId);
  const sp = spaceOf(env, r.reservationId)[0];
  await env.admin('api_admin_cancel', { reservationId: r.reservationId, reason: '本人から電話', requestId: rid() });
  return sp;
}
const otherThan = (sp) => SP.filter((s) => s !== sp);

test('[S-210] 同じ部屋の確定の予約がすぐ前・すぐ後のコマにあれば、その区画を選ぶ', async (t) => {
  await withSpec(t, async (env) => {
    const d0 = await defaultSpace(env, '2026-11-27', 'S2');
    const [n1, n2] = otherThan(d0);
    // すぐ前（S1）にある
    await reg(env, X, '2026-11-20', 'S1', n1);
    const a = await reg(env, X, '2026-11-20', 'S2');
    assert.deepEqual(spaceOf(env, a.reservationId), [n1], 'すぐ前のコマの区画に寄らない');
    // すぐ後（S3）にある
    await reg(env, X, '2026-11-22', 'S3', n2);
    const b = await reg(env, X, '2026-11-22', 'S2');
    assert.deepEqual(spaceOf(env, b.reservationId), [n2], 'すぐ後のコマの区画に寄らない');
  });
});

test('[S-211] S4 の次は翌日の S1、S1 の前は前日の S4（日をまたいで寄せる）', async (t) => {
  await withSpec(t, async (env) => {
    const d1 = await defaultSpace(env, '2026-11-27', 'S1');
    const d4 = await defaultSpace(env, '2026-11-27', 'S4');
    const n1 = otherThan(d1)[0];
    const n4 = otherThan(d4)[1];
    await reg(env, X, '2026-11-20', 'S4', n1);
    const a = await reg(env, X, '2026-11-21', 'S1');
    assert.deepEqual(spaceOf(env, a.reservationId), [n1], '前日の S4 の区画に寄らない');
    await reg(env, X, '2026-11-24', 'S1', n4);
    const b = await reg(env, X, '2026-11-23', 'S4');
    assert.deepEqual(spaceOf(env, b.reservationId), [n4], '翌日の S1 の区画に寄らない');
  });
});

test('[S-212] 前と後で区画が違えば、前に合わせる', async (t) => {
  await withSpec(t, async (env) => {
    const d0 = await defaultSpace(env, '2026-11-27', 'S2');
    for (const [before, after] of [otherThan(d0), [...otherThan(d0)].reverse(), [d0, otherThan(d0)[0]], [otherThan(d0)[0], d0]]) {
      const date = `2026-11-${String(10 + SP.indexOf(before) * 3 + SP.indexOf(after)).padStart(2, '0')}`;
      await reg(env, X, date, 'S1', before);
      await reg(env, X, date, 'S3', after);
      const r = await reg(env, X, date, 'S2');
      assert.deepEqual(spaceOf(env, r.reservationId), [before], `前 ${before}・後 ${after} で前に合わない`);
    }
  });
});

test('[S-213] 棟・部屋番号の揺れ（全角と半角・空白・「号室」「棟」の有無）をそろえて、同じ部屋とみなす', async (t) => {
  const variants = [
    { building: 'Ｂ棟', room: '５１２' },
    { building: 'B', room: '512号室' },
    { building: ' B 棟 ', room: ' 512 ' },
    { building: 'b棟', room: '５１２号室' },
  ];
  for (const v of variants) {
    await withSpec(t, async (env) => {
      const d0 = await defaultSpace(env, '2026-11-27', 'S2');
      const n = otherThan(d0)[1];
      await reg(env, X, '2026-11-20', 'S1', n);
      const r = await reg(env, { ...X, ...v }, '2026-11-20', 'S2');
      assert.deepEqual(spaceOf(env, r.reservationId), [n], `${JSON.stringify(v)} を同じ部屋とみなさない`);
    });
  }
});

test('[S-214] 寄せたい区画が空いていなければ、ほかの空いている区画にする（断らない）', async (t) => {
  await withSpec(t, async (env) => {
    const d0 = await defaultSpace(env, '2026-11-27', 'S2');
    const n = otherThan(d0)[0];
    await reg(env, X, '2026-11-20', 'S1', n);
    await reg(env, Y, '2026-11-20', 'S2', n);
    const r = await reg(env, X, '2026-11-20', 'S2');
    const sp = spaceOf(env, r.reservationId);
    assert.equal(sp.length, 1);
    assert.notEqual(sp[0], n);
    // 寄せたい区画が使用禁止のときも、ほかへ
    await reg(env, X, '2026-11-21', 'S1', n);
    await env.admin('api_admin_addBlock', { requestId: rid(), from: '2026-11-21', to: '2026-11-21', slots: ['S2'], spaces: [n], reason: '管理者が使う', memo: '', confirm: true });
    const b = await reg(env, X, '2026-11-21', 'S2');
    assert.notDeepEqual(spaceOf(env, b.reservationId), [n]);
  });
});

test('[S-215] 管理者が区画を指定したときは、指定のとおりにする', async (t) => {
  await withSpec(t, async (env) => {
    await reg(env, X, '2026-11-20', 'S1', '93');
    const r = await reg(env, X, '2026-11-20', 'S2', '91');
    assert.deepEqual(spaceOf(env, r.reservationId), ['91']);
  });
});

test('[S-216] 取り消した予約・別の部屋の予約・離れたコマには寄せない', async (t) => {
  await withSpec(t, async (env) => {
    const d0 = await defaultSpace(env, '2026-11-27', 'S2');
    const n = otherThan(d0)[0];
    // 取り消した予約
    const c = await reg(env, X, '2026-11-20', 'S1', n);
    await env.admin('api_admin_cancel', { reservationId: c.reservationId, reason: '本人から電話', requestId: rid() });
    const a = await reg(env, X, '2026-11-20', 'S2');
    assert.notDeepEqual(spaceOf(env, a.reservationId), [n], '取り消した予約に寄せた');
    // 別の部屋（同じ棟の隣の部屋）
    await reg(env, Y, '2026-11-21', 'S1', n);
    const b = await reg(env, X, '2026-11-21', 'S2');
    assert.notDeepEqual(spaceOf(env, b.reservationId), [n], '別の部屋の予約に寄せた');
    // 離れたコマ（S1 と S3、前日の S3 と S1）
    await reg(env, X, '2026-11-22', 'S1', n);
    const e = await reg(env, X, '2026-11-22', 'S3');
    assert.notDeepEqual(spaceOf(env, e.reservationId), [n], '1つ空けたコマに寄せた');
  });
});

test('[S-217] 変更・住民の申込みでも、区画を自動で選ぶときは寄せる', async (t) => {
  await withSpec(t, { rules: { residentBooking: true, residentLeadDays: 0 } }, async (env) => {
    const d0 = await defaultSpace(env, '2026-11-27', 'S2');
    const n = otherThan(d0)[0];
    await reg(env, X, '2026-11-20', 'S1', n);
    const o = await reg(env, X, '2026-11-25', 'S3');
    const c = await env.admin('api_admin_change', { reservationId: o.reservationId, date: '2026-11-20', slotId: 'S2', name: X.name, building: X.building, room: X.room, phone: X.phone, email: '' });
    assert.equal(c.status, 'CHANGED', JSON.stringify(c));
    assert.deepEqual(spaceOf(env, o.reservationId), [n], '変更で寄らない');
    await reg(env, X, '2026-11-21', 'S1', n);
    const w = await env.pub('api_submitReservation', { requestId: rid(), date: '2026-11-21', slotId: 'S2', quantity: 1, name: X.name, building: X.building, room: X.room, phone: X.phone, email: '' });
    assert.equal(w.status, 'CONFIRMED', JSON.stringify(w));
    assert.deepEqual(spaceOf(env, w.reservationId), [n], '住民の申込みで寄らない');
  });
});
