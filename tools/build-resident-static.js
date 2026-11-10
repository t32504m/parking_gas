#!/usr/bin/env node
'use strict';
/**
 * 住民の画面を、GAS の外（Cloudflare Pages など）に置くための1枚の HTML を作る（D-034）。
 *   node tools/build-resident-static.js --gas https://script.google.com/macros/s/XXXX/exec [--out dist/resident-static] [--fallback "理事会事務局（電話 0X-XXXX-XXXX）"]
 *
 * ・中身は src/Index.html（＋Styles・Common）と同じ。GAS の画面と見た目・動きは変わらない。
 * ・サーバーの呼び出し（App.call）だけを、GAS の doPost への fetch に置き換える。
 *   fetch は Google のログイン情報（クッキー）を送らない（credentials: 'omit'）ので、
 *   複数の Google アカウントにログインしている端末でも、「ファイルを開くことができません」にならない。
 * ・画面の設定（今日の日付・相談先・受付時間・利用約款）は、開いたときに GAS から受け取る。
 *   相談先などを変えても、この HTML を作り直す必要は無い（GAS のスクリプト プロパティを変えるだけ）。
 * ・GAS の URL（/exec）が変わったときだけ、作り直して置き直す。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** 置き換えの対象が、ちょうど1つあることを確かめてから置き換える（src が変わって合わなくなったら止める） */
function replaceOnce(s, a, b, what) {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`${what} が ${n} か所あります（1か所のはず）。src/Index.html が変わった可能性があります`);
  return s.split(a).join(b);
}

function build({ gasUrl, fallback }) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(gasUrl) && !/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(gasUrl)) {
    throw new Error('--gas には、デプロイの画面の「ウェブアプリ」の URL（https://script.google.com/macros/s/…/exec）を入れてください: ' + gasUrl);
  }
  const read = (n) => fs.readFileSync(path.join(SRC, n), 'utf8');
  let html = read('Index.html');
  html = replaceOnce(html, "<?!= include_('Styles') ?>", read('Styles.html'), 'Styles の読込み');
  html = replaceOnce(html, "<?!= include_('Common') ?>", read('Common.html'), 'Common の読込み');
  // GAS が付けていたもの（題名・画面の幅）を、自分で付ける
  html = replaceOnce(html, '<meta charset="utf-8">',
    '<meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>駐車場の空き状況</title>', '文字コードの行');
  // テンプレートの値は、開いたときに GAS から受け取る設定（window.__CFG）から読む
  for (const k of ['contact', 'hours', 'terms', 'today', 'viewFrom']) {
    html = replaceOnce(html, `<?= ${k} ?>`, `window.__CFG.${k}`, `テンプレートの値 ${k}`);
  }
  html = replaceOnce(html, '<?= layout ?>', "((function () { var l = new URLSearchParams(location.search).get('layout'); return l === 'calendar' || l === 'list' ? l : ''; })())", 'テンプレートの値 layout');
  if (/<\?/.test(html)) throw new Error('置き換えていないテンプレートの式が残っています: ' + html.match(/<\?[^>]*\?>/)[0]);
  // 画面のスクリプトは、設定を受け取ってから順に動かす
  const nScripts = html.split('<script>').length - 1;
  if (nScripts !== 2) throw new Error(`画面のスクリプトが ${nScripts} 個あります（Common と Index の2つのはず）`);
  html = html.split('<script>').join('<script type="text/x-deferred">');
  const loader = `
  <script>
  // 外に置いた住民の画面の読込み（tools/build-resident-static.js が作った。D-034）
  (function () {
    'use strict';
    var GAS_URL = ${JSON.stringify(gasUrl)};
    var FALLBACK = ${JSON.stringify(fallback || '')};
    function post(fn, arg) {
      return fetch(GAS_URL, {
        method: 'POST', credentials: 'omit', redirect: 'follow', cache: 'no-store',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ fn: fn, arg: arg === undefined ? null : arg })
      }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
    }
    function runDeferred() {
      var list = document.querySelectorAll('script[type="text/x-deferred"]');
      Array.prototype.forEach.call(list, function (old) {
        var s = document.createElement('script');
        s.textContent = old.textContent;
        old.parentNode.replaceChild(s, old);
        // Common を動かした直後に、サーバーの呼び出しを fetch に替える（画面の最初の読込みより前に）
        if (window.App && !window.App.__static) {
          window.App.call = function (fn, arg) { return post(fn, arg); };
          window.App.__static = true;
        }
      });
    }
    function showError() {
      var m = document.querySelector('main');
      if (!m) return;
      m.innerHTML = '<section class="panel" style="margin:16px"><h2>空き状況を読み込めませんでした</h2>'
        + '<p>通信が混み合っているか、つながっていません。少し待ってから、もう一度お試しください。</p>'
        + '<p><button type="button" class="btn main wide" onclick="location.reload()">もう一度読み込む</button></p>'
        + (FALLBACK ? '<p class="sub"></p>' : '') + '</section>';
      if (FALLBACK) m.querySelector('.sub').textContent = FALLBACK;
    }
    function start(tries) {
      post('config').then(function (c) {
        if (!c || c.status !== 'OK') throw new Error('config');
        window.__CFG = c;
        runDeferred();
      }).catch(function () {
        if (tries > 0) setTimeout(function () { start(tries - 1); }, 1500); else showError();
      });
    }
    start(2);
  })();
  </script>
`;
  html = replaceOnce(html, '</body>', loader + '</body>', 'body の終わり');
  return html;
}

module.exports = { build };

if (require.main === module) {
  const gasUrl = arg('gas');
  if (!gasUrl) {
    console.error('使い方: node tools/build-resident-static.js --gas https://script.google.com/macros/s/XXXX/exec [--fallback "理事会事務局（電話 0X-XXXX-XXXX）"]');
    process.exit(1);
  }
  const out = path.resolve(ROOT, arg('out', 'dist/resident-static'));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'index.html'), build({ gasUrl, fallback: arg('fallback', '') }));
  console.log(`作りました: ${path.join(out, 'index.html')}`);
  console.log('このフォルダを、Cloudflare Pages などにそのまま置いてください（docs/RESIDENT_STATIC.md）。');
}
