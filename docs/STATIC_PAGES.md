# 画面を GAS の外に置く手順（D-034・D-035）

## なぜ外に置くか

GAS のウェブアプリは、**1つのブラウザで複数の Google アカウントにログインしている端末**では、
「現在、ファイルを開くことができません」になることがある（2026-11-10、依頼者の実機で、QR から開いたときに起きた）。
住民の端末は選べず、管理者も複数ログインのことがあるので、住民の画面と管理者の画面を GAS の外（Cloudflare Pages など、無料の静的ホスティング）に置く（D-035、案 A+）。

- 外に置くのは、HTML 2枚（住民の `index.html` と、管理者の `admin/index.html`）だけ。中身は `src/Index.html`・`src/Admin.html` と同じで、見た目と動きは変わらない。
- 空き状況などのデータは、今までどおり GAS（スプレッドシート）にある。画面は GAS の `doPost` を `fetch` で呼ぶ。
- `fetch` は Google のログイン情報（クッキー）を送らない（`credentials: 'omit'`）。だから、Google にいくつログインしていても関係ない。
- 管理者の確認は、今までどおりメールとパスコード（Google のログインは使っていない）。
- GAS の画面（`/exec` と `?page=admin`）も残る。外のページが使えないときの予備。
- Firestore などへの全面の移行は、しなかった（台帳・管理者の画面・メール・試験の全部を作り直すことになり、間に合わない）。

## 手順（本番）

### 1. GAS をいつもどおり公開する

`docs/SETUP.md` の 4章のとおり（次のユーザーとして実行：自分、アクセスできるユーザー：全員）。
デプロイの画面に出る「ウェブアプリ」の URL（`https://script.google.com/macros/s/…/exec`）を控える。
**`/dev` の URL、`/u/0/` の入った URL、アドレス欄の URL は使わない。**

> すでに公開してあるときは、「デプロイを管理 → 既存のデプロイを編集 → 新しいバージョン」で、今回の `src/Web.gs`（`doPost` が入った）を反映する。URL は変わらない。

### 2. 外に置く HTML を作る（この PC で）

```bash
cd G:/test/parking-gas-complete/parking-gas
node tools/build-static.js --gas "https://script.google.com/macros/s/XXXX/exec" --fallback "理事会事務局（電話 0X-XXXX-XXXX）"
```

`dist/static/index.html`（住民）と `dist/static/admin/index.html`（管理者）ができる。

- `--fallback` は、GAS につながらないときに画面に出す連絡先。電話番号を入れておく。
- 相談先・受付時間・利用約款・今日の日付は、開いたときに GAS から受け取る。スクリプト プロパティを変えれば、作り直さなくても変わる。
- 作り直しが要るのは、**GAS の URL が変わったとき**と、**`src/Index.html`・`Styles.html`・`Common.html` を変えたとき**だけ。

### 3. Cloudflare Pages に置く（ブラウザだけでできる。無料）

1. https://dash.cloudflare.com/ にログインする（アカウントが無ければ作る。管理組合のメールで作るのがよい）。
2. 「Workers & Pages」→「作成」（Create）→「Pages」→「アセットをアップロード」（Upload assets / Direct upload）。
   - 画面の言葉は時期によって違う。「Pages」と「アップロード」（ドラッグ アンド ドロップ）を選ぶ。Git の連携は選ばない。
3. プロジェクトの名前を決める（例 `xxxx-parking`）。これが URL になる：`https://xxxx-parking.pages.dev/`。**後から変えられないので、よく考えて決める。**
4. `dist/static` のフォルダを、そのままドラッグして「デプロイ」。住民は `https://xxxx-parking.pages.dev/`、管理者は `https://xxxx-parking.pages.dev/admin/`。
5. 出た URL をスマホで開き、下の「4. 確かめること」を見る。

作り直したときは、同じプロジェクトを開き「新しいデプロイを作成」で、フォルダを置き直す。**URL は変わらない。**

> Cloudflare が使えないときの代わり：Netlify（https://app.netlify.com/drop にフォルダを落とす）、GitHub Pages、Firebase Hosting。どれでも、HTML 1枚を置くだけで動く。

### 4. 確かめること（QR を配る前に、必ず）

| 確かめること | 期待 |
|---|---|
| **複数の Google アカウントにログインしているスマホ**で、Pages の URL を開く | 空き状況（○×）が出る。「ファイルを開くことができません」が出ない |
| Google にログインしていないスマホ（シークレット）で開く | 同じく出る |
| 「次の月」「前の月」を押す | 表が変わる |
| 「電話で予約する」を押す | 電話がかかる画面になる |
| 一覧とカレンダーの切替（`?layout=calendar`） | どちらも出る |
| 複数ログインのパソコンで `/admin/` を開き、管理者のメールとパスコードで入る | 台帳が出る。代行登録・取消し・変更・使用禁止ができ、スプレッドシートに反映される |
| スプレッドシートの「使用禁止」や予約を変えて、開き直す | ○×が変わる |

### 5. QR コード

**Pages の URL（`https://xxxx-parking.pages.dev/`）で作る。** GAS の URL は入れない。
GAS の URL が後で変わっても、手順2・3で作り直して置き直せば、QR は刷り直さずに済む。
チラシには、念のため電話の受付（理事会事務局の番号と受付時間）も書いておく。

## しくみ（作業するAI向け）

- `src/Web.gs`
  - `residentConfig_()`：画面の設定（`doGet` と共通）。
  - `doPost(e)`：本文の JSON `{fn, args}` を `webApi_` に渡し、`ContentService` の JSON で返す。
  - `webApi_(body)`：一覧に書いた関数だけを呼ぶ（住民の4つ・`config`・管理者の `api_admin_*`）。管理者の関数は、中で管理者の印を確かめる。ほかは `DENIED`。
- 呼び出しは `Content-Type: text/plain` の POST なので、CORS の事前確認（preflight）は起きない。GAS は 302 で `script.googleusercontent.com` に転送し、そこが `Access-Control-Allow-Origin: *` を付けて返す（GAS の一般的な使い方。**本物の GAS では、まだ確かめていない**。スマホの Chrome で止まるという報告もある）。
- `tools/build-static.js`：`src` の画面に Styles・Common を埋め込み、テンプレートの式を `window.__CFG` に替え、`App.call` を `fetch` に替える。`src` の形が変わって置き換えが合わなくなったら、止まって知らせる。
- `tools/serve-static.js`：手元で確かめる（住民 `http://localhost:8790/`、管理者 `/admin/`。GAS の代わりにエミュレータの `doPost` を呼ぶ）。
- 試験：`tests/impl/static-resident.test.js`・`tests/impl/static-admin.test.js`。
