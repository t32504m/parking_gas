'use strict';
// 電話番号の書き方をそろえる・管理者のメールの形（D-039）
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startStatic } = require('../../tools/serve-static');

const post = (s, body) => fetch(s.url + 'gas', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).then((r) => r.json());

const CASES = [
  ['09012345678', '090-1234-5678'],
  ['090-1234-5678', '090-1234-5678'],
  ['０９０－１２３４－５６７８', '090-1234-5678'],
  ['090 1234 5678', '090-1234-5678'],
  ['090ー1234ー5678', '090-1234-5678'],
  ['080−1234−5678', '080-1234-5678'],
  ['070‐1234‐5678', '070-1234-5678'],
  ['０３（１２３４）５６７８', '03-1234-5678'],
  ['0312345678', '03-1234-5678'],
  ['06-1234-5678', '06-1234-5678'],
  ['045-123-4567', '045-123-4567'],
  ['0451234567', '0451234567'],
  ['0466-12-3456', '0466-12-3456'],
  ['0120 123 456', '0120-123-456'],
  ['08001234567', '0800-123-4567'],
  ['+81 90 1234 5678', '+819012345678'],
  ['＋８１－９０－１２３４－５６７８', '+81-90-1234-5678'],
];

test('どう入れても、保存のときに同じ形にそろう。先頭の0は消えず、文字列のまま', async () => {
  const s = await startStatic({});
  try {
    const login = await post(s, { fn: 'api_admin_login', args: [{ email: s.admin.email, secret: s.admin.secret }] });
    assert.equal(login.status, 'OK');
    const auth = { token: login.token };
    for (let i = 0; i < CASES.length; i++) {
      const [input, want] = CASES[i];
      const date = `2026-11-${String(10 + Math.floor(i / 4)).padStart(2, '0')}`;
      const slotId = ['S1', 'S2', 'S3', 'S4'][i % 4];
      const r = await post(s, { fn: 'api_admin_register', args: [auth, { requestId: 'rq-phone-' + i, date, slotId, quantity: 1, channel: 'PHONE', name: '電話 ' + i, building: '', room: String(100 + i), phone: input }] });
      assert.equal(r.status, 'CONFIRMED', `${input}: ${JSON.stringify(r)}`);
      const row = s.app.host.dumpSheet(s.app.spreadsheetId, '予約').rows.find((x) => x['氏名'] === '電話 ' + i);
      assert.equal(typeof row['電話番号'], 'string');
      assert.equal(row['電話番号'], want, `${input} が ${want} にならない`);
    }
  } finally { await s.close(); }
});

test('電話番号でない文字（英字・記号）は、今までどおり断る', async () => {
  const s = await startStatic({});
  try {
    const login = await post(s, { fn: 'api_admin_login', args: [{ email: s.admin.email, secret: s.admin.secret }] });
    for (const bad of ['090-abcd-5678', '090_1234_5678', '12345', '<script>']) {
      const r = await post(s, { fn: 'api_admin_register', args: [{ token: login.token }, { requestId: 'rq-bad-' + bad, date: '2026-11-20', slotId: 'S1', quantity: 1, channel: 'PHONE', name: '断る', building: '', room: '101', phone: bad }] });
      assert.notEqual(r.status, 'CONFIRMED', `${bad} を受け付けた`);
    }
  } finally { await s.close(); }
});

test('電話番号の欄には、薄く例が出る（住民と管理者の両方）', () => {
  const common = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'Common.html'), 'utf8');
  assert.match(common, /App\.TEL_EXAMPLE = '例：090-1234-5678'/);
  for (const f of ['Index.html', 'Admin.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8');
    assert.match(src, /type === 'tel' \? ' placeholder="' \+ esc\(ph \|\| App\.TEL_EXAMPLE\)/, `${f} の電話の欄に例が無い`);
  }
});

test('setup：管理者のメールに、かっこ・空白・全角などが入っていたら止める', async () => {
  const s = await startStatic({});
  try {
    const rules = {};
    for (const bad of ['(admin@example.com', 'a b@example.com', 'ａ@example.com', 'admin@example', 'admin@@example.com']) {
      const r = await s.app.host.run('setup_init', [rules, [{ email: bad, name: '試験', secret: 'long-enough-pass' }]], { kind: 'editor' });
      assert.ok(!r.ok || r.value.status !== 'OK', `${bad} を受け付けた`);
    }
    const ok = await s.app.host.run('setup_init', [rules, [{ email: ' New.Admin+1@Example.com ', name: '試験', secret: 'long-enough-pass' }]], { kind: 'editor' });
    assert.ok(ok.ok && ok.value.status === 'OK', JSON.stringify(ok.error || ok.value));
  } finally { await s.close(); }
});
