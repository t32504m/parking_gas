# エミュレータが置いている「実GASの挙動」の仮定

この開発環境では Google のサービスを使えないため、GAS とスプレッドシートの挙動を Node 上で再現している。
再現の土台になっている仮定を、ここに全て書く。**ローカルで合格しても、ここが外れていれば本番では動かない。**

- 状態：`確認済み`（実環境プローブで一致）／`未確認`（一般的な知識に基づく）／`最悪想定`（不明なので危ない側に倒している）
- 確認方法：`harness/real-gas/FaithfulnessProbe.gs` を実環境で実行し、`compare.js` で突き合わせる。
- 各仮定はエミュレータの単体試験（`harness/selftest/emulator.test.js`）に同じ番号で固定してある。

| ID | 仮定 | 状態 | プローブ項目 |
|---|---|---|---|
| A-01 | 文字列 `2026-10-20` を書くと日付（その日 0:00、スプレッドシートのタイムゾーン）に変換される | 未確認 | autoConvert |
| A-02 | 数字だけの文字列（`09012345678`）は数値になり、先頭の 0 が消える | 未確認 | autoConvert |
| A-03 | `T` を含む ISO 形式の日時文字列は変換されず文字列のまま | 未確認 | autoConvert |
| A-04 | 年のない `10/20` は今年の日付に変換される | 未確認 | autoConvert |
| A-05 | 書式なしテキスト（`@`）のセルに `'0123` を書くと、アポストロフィも文字として残る | 最悪想定 | plainTextApostrophe |
| A-06 | 書式を付けた行より下に `appendRow` した行には書式が引き継がれない | 最悪想定 | appendBelowFormatted |
| A-07 | `getRange(行, 列, 0, n)` はエラー | 未確認 | zeroRows |
| A-08 | シートの最大行を超える `getRange` はエラー、`appendRow` は行を増やす | 未確認 | beyondMaxRows |
| A-10 | 「自分として実行」のWebアプリでは、所有者以外（一般の Google アカウント）の `Session.getActiveUser().getEmail()` は空文字 | 未確認 | web-a-other |
| A-11 | 「アクセスしたユーザーとして実行」では本人のメールが取れる。未ログインでは開けない | 未確認 | web-b-other |
| A-12 | 時間主導トリガー内の `getActiveUser()` は所有者のメール | 未確認 | trigger |
| A-20 | `google.script.run` の戻り値に Date が含まれると、成功ハンドラには `null` が渡る | 未確認 | returnDate |
| A-21 | 名前が `_` で終わる関数は `google.script.run` から呼べない。トリガーからは呼べる | 未確認 | privateVisible, trigger |
| A-22 | `after()` の時間主導トリガーは実行後に一覧から消える | 未確認 | trigger |
| A-30 | `waitLock` のタイムアウトは例外 `Lock timeout: another process was holding the lock for too long.` | 未確認 | （同時実行が必要なため手動） |
| A-31 | 実行ごとにグローバル変数は初期化される | 確実（GAS の仕様） | － |
| A-32 | サーバー側に `setTimeout` / `require` / `process` / `Buffer` / `fetch` / `structuredClone` は無い | 未確認 | globals |
| A-33 | `Utilities.formatDate` は Java の SimpleDateFormat 形式。曜日は英語 | 未確認 | formatDate |
| A-40 | 無料アカウントのメール送信上限は 1日100通。上限超過・宛先なし・不正な宛先は例外 | 未確認 | mailQuota |
| A-50 | `<?= ?>` は HTML エスケープ、`<?!= ?>` はそのまま | 未確認 | templateEscape |
| A-51 | `<script>` 内の `<?= ?>` は JavaScript の値（JSON 形式）として出力される | 未確認 | templateEscape |
| A-52 | HTML 内の `<meta name="viewport">` は外側のページに効かず、`addMetaTag` が必要 | 未確認 | web（innerWidth） |
| A-60 | 同名の最上位関数が複数あると、後に読み込まれたファイルの定義が黙って使われる | 未確認 | － |
| A-70 | 1操作あたりの所要時間（`cost-model.json`）。**現在は仮の値** | 未校正 | timings |
| A-71 | `google.script.run` 1往復の固定的な待ち時間 700ms。**仮の値** | 未校正 | roundTripMedianMs |
| A-80 | シートへの1回の操作は不可分。複数の操作の間には他の実行の操作が割り込む | 最悪想定 | － |
| A-81 | ロックの待ち行列は先着順 | 未確認（保証されない可能性） | － |
| A-82 | シートへの書込みは、同じ実行の読取り・`SpreadsheetApp.flush()`・実行終了まで他の実行から見えないことがある。**ロックの解放では反映されない**。実行終了後の反映も少し遅れうる | 最悪想定 | － |
| A-90 | Webアプリは `script.googleusercontent.com` の iframe 内に表示され、リンクには `target="_top"` 等が必要 | 未確認 | － |

## エミュレートしていないもの（呼ぶと明示的に失敗する）

DriveApp・UrlFetchApp・CalendarApp・FormApp・DocumentApp・GmailApp.search など。使う場合はエミュレータに追加し、ここに仮定を書くこと。

## エミュレータで再現していない制約

- 同時実行数の上限（1ユーザーあたり30程度）、1日の実行時間合計の上限
- スプレッドシートの1000万セル上限、1シートあたりの処理速度の劣化
- Google 側の一時的な障害（`Service Spreadsheets timed out` などは障害注入で一部のみ再現）
- 実機のブラウザ・回線の遅さ（UI 監査とペルソナ評価は Chromium の端末エミュレーション）
