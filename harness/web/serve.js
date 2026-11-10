#!/usr/bin/env node
'use strict';
// 画面を手で確認するための起動。初期予約（personas/scenario.json）入りで立ち上がる。
//   npm run serve
// 管理者のパスコードは、手元確認では毎回同じ値にする（環境変数 LOCAL_ADMIN_PASSCODE で変更可。8文字以上）。
const fs = require('fs');
const path = require('path');
const helpers = require('../../tests/helpers');
const { startApp } = require('./app');

(async () => {
  const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'personas', 'scenario.json'), 'utf8'));
  const port = Number(process.env.PORT || 8787);
  const pass = process.env.LOCAL_ADMIN_PASSCODE || 'kanri-test-1234';
  if (pass.length < 8) throw new Error('LOCAL_ADMIN_PASSCODE は8文字以上にしてください');
  helpers.ACTORS.admin.secret = pass;
  helpers.ACTORS.admin2.secret = pass;
  const app = await startApp({ scenario, now: scenario.now, port, autoAdmin: true });
  const line = '─'.repeat(50);
  console.log(line);
  console.log('駐車場予約（手元確認用）を起動しました');
  console.log(line);
  console.log(`■ 利用者画面\n  ${app.userUrl}`);
  console.log(`■ 管理者画面（確認なしですぐ入れる・手元確認用）\n  ${app.web.url}/__harness/admin-auto`);
  console.log(`■ 管理者画面（本番と同じく、確認してから入る）\n  ${app.adminUrl}`);
  console.log(`  メールアドレス：${app.actors.admin.email}`);
  console.log(`  管理者パスコード：${pass}`);
  console.log(`  （2人目の管理者：${app.actors.admin2.email} ／ 同じパスコード）`);
  console.log(`■ 台帳の中身（スプレッドシート相当）・送ったメール\n  ${app.web.url}/__harness/ledger`);
  console.log(line);
  console.log(`画面の「今日」は ${scenario.now.slice(0, 10)}（仮想の時刻）。データはメモリ上にあり、止めると消えます。`);
  console.log('パスコードを5回続けて間違えると15分止まります。そのときは Ctrl+C で止めて、起動し直してください。');
  console.log('終了：Ctrl+C');
  process.on('SIGINT', async () => { await app.close(); process.exit(0); });
})().catch((e) => { console.error(e.message); process.exit(1); });
