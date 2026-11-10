# 自治会駐車場予約システム — 開発・検証ハーネス

GAS（Google Apps Script）＋スプレッドシートで作る予約システムを、**Google に接続できない環境で**実装AIが「試験 → 検証 → 改善」を繰り返せるようにするための土台です。
実装（`src/`）はまだ空です。実装AIは `CLAUDE.md` の手順で作り始めます。

## 何が検証できるか

| 層 | 仕組み | 見ているもの |
|---|---|---|
| GAS の再現 | `harness/emulator/` | SpreadsheetApp・LockService・Session・MailApp・HtmlService などを Node 上で再現。**各実行を別スレッドで本当に並行して動かす**ので、ロックの付け忘れ・flush 忘れによる二重予約が実際に起きる |
| 実GASの落とし穴 | 同上 | 文字列の自動変換（電話番号の先頭0が消える等）、Date を返すと null、`_` 付き関数は呼べない、公開設定で利用者のメールが取れない、書込みの遅延反映 |
| 受入試験 | `tests/acceptance/` 35件 | 要件11の正常・競合・境界・障害（同時申込み、再送、通信断、処理途中の停止、ロック失敗、通知失敗、メール上限、権限、個人情報、監査） |
| 台帳の不変条件 | `harness/invariants.js` | 実装のコードを通さずシートを直接読み、二重予約0・一部確定0・取消し後の枠残り0 などを毎試験後に検査 |
| 静的検査 | `harness/lint/` | GAS で動かない書き方、未宣言の公開関数（誰でも呼べる関数）、同名関数、viewport の付け忘れ |
| 画面 | `tests/ui/`・`harness/persona/ui-audit.js` | スマホ幅での表示・横スクロール・文字の大きさ・押しやすさ・コントラスト。画面試験は実装AIが書く（必須ID一覧あり） |
| ペルソナ評価 | `harness/persona/` | 5人の利用者像（78歳の住民、通勤中の親、電波の弱い住民、色覚の特性がある住民、電話を受けながら入力する管理者）を、**実装と別のAI**が実際に画面操作して評価。客観指標と主観評価の両方が基準を満たすまで改善 |
| ハーネス自体の検証 | `harness/selftest/` | 最小実装で全試験が合格可能か、わざと壊した実装14種を全て不合格にできるか |
| 実環境との差 | `harness/real-gas/` | エミュレータの仮定を本物の GAS で確かめるプローブと照合ツール |

## よく使うコマンド

```bash
npm run verify:quick   # 作業中の確認（数分）
npm run verify         # 完全版 → reports/latest.md
npm run verify:strict  # 完了判定（ペルソナ評価の合格も必須）
npm run selftest       # ハーネス自体の検証（ハーネスを直したとき）
npm run serve          # 画面を手で開いて確かめる
npm run harness:seal   # 人が内容を確認したうえで、保護ファイルを封印し直す
```

Node.js 20 以上と、Playwright（Chromium）が必要です。

## 人がやること

1. 最初に一度、`docs/REAL_ENV_CHECKLIST.md` の 1章（実環境プローブ）を行い、エミュレータの仮定を確かめる。
2. `contract/provisional-rules.json` の未決定ルールを自治会で決める。
3. `personas/` の人物像と合格基準を、実際の住民・管理者に合わせて見直す。
4. 実装AIの報告（`docs/DECISIONS.md`）に答える。
5. 区切りごとに `docs/REAL_ENV_CHECKLIST.md` の 2・3章を行う。

ハーネスで合格しても、本物の Google と本物の利用者での確認は省略できません。ハーネスは「本番で問題を見つける前に、手元で見つけられる問題を全て見つける」ためのものです。
