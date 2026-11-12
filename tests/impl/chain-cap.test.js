'use strict';
// 連続コマ上限と、ロック前の即断（docs/DECISIONS.md D-042・G1・G2）。
// G1 は依頼者の決定（2026-11-12）: 部屋は連続した4コマまで（夜をまたぐ B,C,D,A の4つ繋がりは可）。他の個数制限は設けない。
// G2: 過去日・締切後・期間外・連続超過は、ロックを取らず台帳にも行を書かない（ロック飢餓の燃料を減らす）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { withEnv, ACTORS } = require('../helpers');

const OPEN = { rules: { residentBooking: true, residentLeadDays: 0 } };
const R = ACTORS.residents;
const DAY = '2026-10-26';
const NEXT = '2026-10-27';

const book = (env, who, o) => env.adapter.submit(env.host, env.req(who, o), who);
const resRows = (env) => env.host.dumpSheet(env.spreadsheetId, '予約').rows;

test('同じ部屋は連続4コマまで（夜跨ぎ B,C,D,A は可）。5つ目は断り、台帳に行が残らない', async (t) => withEnv(t, OPEN, async (env) => {
  const who = R[0];
  for (const pair of [[DAY, 'S2'], [DAY, 'S3'], [DAY, 'S4'], [NEXT, 'S1']]) {
    const r = await book(env, who, { date: pair[0], slotId: pair[1] });
    assert.equal(r.status, 'CONFIRMED', `${pair[0]} ${pair[1]} は確定するはず`);
  }
  const over = await book(env, who, { date: NEXT, slotId: 'S2' }); // 5つ目の繋がりは断る
  assert.equal(over.status, 'REJECTED');
  assert.equal(over.reason, 'TOO_MANY');
  // 間を空ければ別個の繋がりで通る（S2 が空いているので S3 は S1 と繋がらない）
  const gap = await book(env, who, { date: NEXT, slotId: 'S3' });
  assert.equal(gap.status, 'CONFIRMED');
  // 同じ繋がりの部屋違いは関係ない
  const other = await book(env, R[1], { date: NEXT, slotId: 'S2' });
  assert.equal(other.status, 'CONFIRMED');
  // 名前が違っても同じ部屋（ゆらぎ込み）なら同じ部屋として捕まる
  const sneak = { ...R[2], building: who.building, room: who.room + '号室' };
  const sneaked = await book(env, sneak, { date: DAY, slotId: 'S1' });
  assert.equal(sneaked.status, 'REJECTED');
  assert.equal(sneaked.reason, 'TOO_MANY');
  // 断った分は台帳に残らない（確定5件＋別部屋1件だけ）
  const mine = resRows(env).filter((r) => String(r['棟']) === who.building && String(r['部屋番号']).startsWith(who.room));
  assert.equal(mine.length, 5);
}));

test('管理者の電話・窓口は連続上限の影響を受けない（記録の是正まで受け付ける）', async (t) => withEnv(t, OPEN, async (env) => {
  const who = R[3];
  for (const pair of [[DAY, 'S1'], [DAY, 'S2'], [DAY, 'S3'], [DAY, 'S4'], [NEXT, 'S1'], [NEXT, 'S2']]) {
    const r = await env.adapter.adminRegister(env.host, { ...env.req(who, { date: pair[0], slotId: pair[1] }), channel: 'PHONE', email: undefined }, ACTORS.admin);
    assert.equal(r.status, 'CONFIRMED', `管理者の受付は ${pair[0]} ${pair[1]} も通る`);
  }
}));

test('ロック前の即断（過去日・期間外・締切後）は応答だけ返し、台帳に行を書かない', async (t) => withEnv(t, OPEN, async (env) => {
  const p = await book(env, R[0], { date: '2026-10-15' }); // 今日（10-19）より前
  assert.equal(p.reason, 'PAST');
  const w = await book(env, R[1], { date: '2027-12-01' });
  assert.equal(w.reason, 'WINDOW');
  const c = await book(env, R[2], { date: '2026-10-19', slotId: 'S1' }); // 仮想時計 09:00、S1 は 08:00 開始済み
  assert.equal(c.reason, 'CUTOFF');
  assert.equal(resRows(env).length, 0, '断った申込は台帳に1行も書いてはいけない');
  // 結果確認には載らない（UNKNOWN）。満車と違い、再確認は守るべき約束ではない（D-042）
  const st = await env.host.run('api_getRequestStatus', [{ requestId: w.requestId }], { kind: 'client', user: null });
  assert.equal(st.value.status, 'UNKNOWN');
}));
