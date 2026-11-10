#!/usr/bin/env node
'use strict';
// 画面を手で確認するための起動（本番と同じ設定：1コマ2台・住民の受付は閉じる・1回1台・3か月先まで）。
//   npm run serve
// harness/web/serve.js（保護）は受入試験の前提（1コマ3台・住民が申し込める）のまま動くため、
// ここで同じ一式を立ち上げてから、設定 RULES を本番の既定（src/Config.gs の DEFAULT_RULES）に戻す。
// 受入試験の前提のままの画面を見るときは npm run serve:harness。
const fs = require('fs');
const path = require('path');
const helpers = require('../tests/helpers');
const { startApp } = require('../harness/web/app');

(async () => {
  const scenario = JSON.parse(fs.readFileSync(path.join(__dirname, 'preview-scenario.json'), 'utf8'));
  const port = Number(process.env.PORT || 8787);
  const pass = process.env.LOCAL_ADMIN_PASSCODE || 'kanri-test-1234';
  if (pass.length < 8) throw new Error('LOCAL_ADMIN_PASSCODE は8文字以上にしてください');
  helpers.ACTORS.admin.secret = pass;
  helpers.ACTORS.admin2.secret = pass;
  const app = await startApp({ scenario, now: scenario.now, port, autoAdmin: true });
  // 設定を本番の既定に戻す（試験用の上書きを外す）。管理者の登録はそのまま残る
  const r = await app.host.run('setup_init', [{ ...helpers.RULES, maxQuantityPerRequest: 1, capacityPerSlot: 2, residentBooking: false, viewMonths: 3 }, []], { kind: 'editor' });
  if (!r.ok || !r.value || r.value.status !== 'OK') throw new Error('設定の切り替えに失敗: ' + JSON.stringify(r.error || r.value));
  // 手元で見せるための版：管理者の確認は、何を入れても通す（src/ の本番の確認は変えない）。
  // 画面から来た確認の呼び出しだけを、見本の管理者のメールアドレスとパスコードに差し替える。
  // 本番と同じ確認で動かすときは、環境変数 LOCAL_STRICT_LOGIN=1 を付けて起動する。
  const strict = process.env.LOCAL_STRICT_LOGIN === '1';
  if (!strict) {
    const run = app.host.run.bind(app.host);
    app.host.run = (fn, args, opts) => (fn === 'api_admin_login' && opts && opts.kind === 'client'
      ? run(fn, [{ email: app.actors.admin.email, secret: pass }], opts)
      : run(fn, args, opts));
  }
  // 手元で見せるための見本の利用約款（本番では、スクリプト プロパティ TERMS に本文を入れる）
  if (!app.host.getScriptProperty('TERMS')) {
    app.host.setScriptProperties({ TERMS: '（見本）利用約款の本文は、スクリプト プロパティ TERMS に入れます。\n\n第1条（目的）\nこの約款は、駐車場の一時利用について定めます。\n\n第2条（予約）\n予約は、電話で理事会事務局が受け付けます。' });
  }
  const bad = app.seeded.filter((b) => b.status !== 'CONFIRMED');
  if (bad.length) console.warn('初期予約のうち確定しなかったもの:', bad);
  const line = '─'.repeat(50);
  console.log(line);
  console.log('駐車場予約（手元確認用・本番と同じ設定）を起動しました');
  console.log(line);
  console.log(`■ 住民の画面（一覧・カレンダーは画面の右上で切り替える）\n  ${app.userUrl}`);
  console.log(`■ 管理者画面（確認なしですぐ入れる・手元確認用）\n  ${app.web.url}/__harness/admin-auto`);
  if (strict) {
    console.log(`■ 管理者画面（本番と同じく、確認してから入る）\n  ${app.adminUrl}`);
    console.log(`  メールアドレス：${app.actors.admin.email}`);
    console.log(`  管理者パスコード：${pass}`);
  } else {
    console.log(`■ 管理者画面（メールアドレスとパスコードは、何を入れても入れる）\n  ${app.adminUrl}`);
  }
  console.log(`■ 台帳の中身（スプレッドシート相当）・送ったメール\n  ${app.web.url}/__harness/ledger`);
  console.log(line);
  console.log(`画面の「今日」は ${scenario.now.slice(0, 10)}（仮想の時刻）。データはメモリ上にあり、止めると消えます。`);
  console.log('終了：Ctrl+C');
  process.on('SIGINT', async () => { await app.close(); process.exit(0); });
  // 起動用のファイル（start.bat など）から起動したときは、住民の画面と管理者画面をブラウザで開く
  if (process.env.LOCAL_OPEN === '1') {
    const { exec } = require('child_process');
    const open = (u) => exec(process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`);
    open(app.userUrl);
    setTimeout(() => open(app.adminUrl), 800);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
