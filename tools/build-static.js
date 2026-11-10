#!/usr/bin/env node
'use strict';
/**
 * 住民の画面と管理者の画面を、GAS の外（Cloudflare Pages など）に置くための HTML にする（D-034・D-035）。
 *   node tools/build-static.js --gas https://script.google.com/macros/s/XXXX/exec [--out dist/static] [--fallback "理事会事務局（電話 0X-XXXX-XXXX）"]
 * できるもの：
 *   <out>/index.html        住民の画面（src/Index.html）
 *   <out>/admin/index.html  管理者の画面（src/Admin.html）
 *
 * ・中身は src の画面と同じ。サーバーの呼び出し（App.call）だけを、GAS の doPost への fetch に置き換える。
 *   fetch は Google のログイン情報（クッキー）を送らない（credentials: 'omit'）。
 *   複数の Google アカウントにログインしている端末でも、「ファイルを開くことができません」にならない。
 * ・画面の設定（今日の日付・相談先・受付時間・利用約款）は、開いたときに GAS から受け取る。
 * ・作り直しが要るのは、GAS の URL が変わったときと、src の画面（.html）を変えたときだけ。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const PAGES = {
  resident: {
    file: 'Index.html', out: 'index.html', title: '駐車場の空き状況', robots: false,
    values: ['contact', 'hours', 'terms', 'today', 'viewFrom'], layout: true,
    errorTitle: '空き状況を読み込めませんでした',
  },
  admin: {
    file: 'Admin.html', out: path.join('admin', 'index.html'), title: '駐車場予約 管理者用', robots: true,
    values: ['today'], layout: false,
    errorTitle: '管理者の画面を読み込めませんでした',
  },
};

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

/** 置き換えの対象が、ちょうど1つあることを確かめてから置き換える（src が変わって合わなくなったら止める） */
function replaceOnce(s, a, b, what) {
  const n = s.split(a).length - 1;
  if (n !== 1) throw new Error(`${what} が ${n} か所あります（1か所のはず）。src の画面が変わった可能性があります`);
  return s.split(a).join(b);
}

function checkGasUrl(gasUrl) {
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(gasUrl) && !/^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(gasUrl)) {
    throw new Error('--gas には、デプロイの画面の「ウェブアプリ」の URL（https://script.google.com/macros/s/…/exec）を入れてください: ' + gasUrl);
  }
}

function loader(gasUrl, fallback, page) {
  return `
  <script>
  // 外に置いた画面の読込み（tools/build-static.js が作った。D-034・D-035）
  (function () {
    'use strict';
    var GAS_URL = ${JSON.stringify(gasUrl)};
    var FALLBACK = ${JSON.stringify(fallback || '')};
    var ERROR_TITLE = ${JSON.stringify(page.errorTitle)};
    function post(fn, args) {
      return fetch(GAS_URL, {
        method: 'POST', credentials: 'omit', redirect: 'follow', cache: 'no-store',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ fn: fn, args: args || [] })
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
          window.App.call = function (fn) { return post(fn, Array.prototype.slice.call(arguments, 1)); };
          window.App.__static = true;
        }
      });
    }
    function showError() {
      var m = document.querySelector('main');
      if (!m) return;
      m.innerHTML = '<section class="panel" style="margin:16px"><h2></h2>'
        + '<p>通信が混み合っているか、つながっていません。少し待ってから、もう一度お試しください。</p>'
        + '<p><button type="button" class="btn main wide" onclick="location.reload()">もう一度読み込む</button></p>'
        + (FALLBACK ? '<p class="sub"></p>' : '') + '</section>';
      m.querySelector('h2').textContent = ERROR_TITLE;
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
}

/** 1枚の画面を作る。kind は 'resident' か 'admin' */
function buildPage(kind, { gasUrl, fallback }) {
  const page = PAGES[kind];
  if (!page) throw new Error('画面の種類が違います: ' + kind);
  checkGasUrl(gasUrl);
  const read = (n) => fs.readFileSync(path.join(SRC, n), 'utf8');
  let html = read(page.file);
  html = replaceOnce(html, "<?!= include_('Styles') ?>", read('Styles.html'), 'Styles の読込み');
  html = replaceOnce(html, "<?!= include_('Common') ?>", read('Common.html'), 'Common の読込み');
  // GAS が付けていたもの（題名・画面の幅）を、自分で付ける。管理者の画面は検索に載せない
  html = replaceOnce(html, '<meta charset="utf-8">',
    '<meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + (page.robots ? '  <meta name="robots" content="noindex, nofollow">\n' : '')
    + `  <title>${page.title}</title>`, '文字コードの行');
  for (const k of page.values) html = replaceOnce(html, `<?= ${k} ?>`, `window.__CFG.${k}`, `テンプレートの値 ${k}`);
  if (page.layout) {
    html = replaceOnce(html, '<?= layout ?>', "((function () { var l = new URLSearchParams(location.search).get('layout'); return l === 'calendar' || l === 'list' ? l : ''; })())", 'テンプレートの値 layout');
  }
  if (/<\?/.test(html)) throw new Error('置き換えていないテンプレートの式が残っています: ' + html.match(/<\?[^>]*\?>/)[0]);
  // 属性の付いた <script …> も数える（遅らせずに先に動くと、サーバーの呼び出しを置き換える前に動いてしまう）
  const nScripts = (html.match(/<script\b/gi) || []).length;
  if (nScripts !== 2 || html.split('<script>').length - 1 !== 2) throw new Error(`${page.file} の画面のスクリプトが ${nScripts} 個あります（属性の無い <script> が、Common と画面の2つのはず）`);
  // サーバーの呼び出しは App.call の1か所だけのはず（ほかで google.script を使うと、外に置いた画面では動かない）
  const nGas = html.split('google.script').length - 1;
  if (nGas !== 1) throw new Error(`google.script が ${nGas} か所あります（Common の App.call の1か所のはず）。サーバーは App.call で呼んでください`);
  html = html.split('<script>').join('<script type="text/x-deferred">');
  return replaceOnce(html, '</body>', loader(gasUrl, fallback, page) + '</body>', 'body の終わり');
}

/** 両方の画面を作る。{ 'index.html': …, 'admin/index.html': … } */
function buildAll(o) {
  const out = {};
  for (const kind of Object.keys(PAGES)) out[PAGES[kind].out.split(path.sep).join('/')] = buildPage(kind, o);
  return out;
}

module.exports = { buildPage, buildAll, PAGES };

if (require.main === module) {
  const gasUrl = arg('gas');
  if (!gasUrl) {
    console.error('使い方: node tools/build-static.js --gas https://script.google.com/macros/s/XXXX/exec [--fallback "理事会事務局（電話 0X-XXXX-XXXX）"]');
    process.exit(1);
  }
  const out = path.resolve(ROOT, arg('out', 'dist/static'));
  const files = buildAll({ gasUrl, fallback: arg('fallback', '') });
  for (const [rel, html] of Object.entries(files)) {
    const p = path.join(out, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, html);
    console.log(`作りました: ${p}`);
  }
  console.log('このフォルダを、Cloudflare Pages などにそのまま置いてください（docs/STATIC_PAGES.md）。');
}
