# PATCH_NOTES — 2026-07-13

元の `PATCH_NOTES.md` / `TradingCalendar.gs` がPC上・ZIP内のどこにも見つからなかったため、
CLAUDE.md記載の方針(J-Quants `/markets/trading_calendar`)に沿って新規実装した記録。

## 1. Discord通知の切り分けツール(最優先タスク)

### 新規 `gas/Verify.gs`
- `checkSecrets()` — 必要なスクリプトプロパティの反映有無を確認(**値は非表示**・長さのみ)
- `diagnoseDiscord()` — メッセージを送らず4モードを判定
  - ①プロパティ未反映 ②URL形式(空白混入/形式不一致) ③Webhook無効(GETで401/403/404)
    ④別チャンネル(GETで `name`/`channel_id`/`guild_id` を表示し宛先を確認)
- `smokeTestDiscord()` — テスト1通を送りHTTP 204/200で送信可否を判定

### 修正 `gas/Code.gs` `postDiscord()`
- 従来はURL未設定でも非2xx応答でも**無言**だった → 失敗時のみ `Logger.log` に痕跡を残す
  (配信は止めないフェイルオープンを維持)。

## 2. 祝日対応(土日のみ → 土日+祝日)

### 新規 `gas/TradingCalendar.gs`
- 純粋関数(テスト対象): `isWeekend` / `isBusinessDivision` / `isBusinessDayJPCore` /
  `prevBusinessDayJPCore`(いずれも `holidaySet` を引数で受け取る)
- 本番ラッパー: `isBusinessDayJP` / `prevBusinessDayJP`
- `getJpHolidaySet()` — J-Quants `/markets/trading_calendar` から非営業日を取得し
  スクリプトプロパティに**30日キャッシュ**。取得不可なら古いキャッシュ→無ければ `null` を返し、
  **土日のみ判定に自動縮退(フェイルオープン=配信を止めない)**。
- HolidayDivision: `'1'`=営業日 / `'2'`=半日立会(営業日扱い) / それ以外=非営業日。

### 修正 `gas/Code.gs`
- `morningDigest` / `patrol` / `edinetPatrolJob` の土日チェック(`day===0||day===6`)
  → `isBusinessDayJP(now)` に置換(祝日もスキップ)。
- 朝刊の「月曜は金曜分から」分岐 → `prevBusinessDayJP(now)` ベースに変更
  (祝日連休明けも正しく前営業日15:30から集計)。

### 修正 `gas/Market.gs`
- 旧 `prevBusinessDay`(土日のみ)を削除し、`answerCheck` を `prevBusinessDayJP` に置換。

### テスト `tests/logic.test.js`
- 既存2件を新関数名 `prevBusinessDayJP` に更新。
- 新規3件を追加(祝日=海の日 / 連休明けの前営業日 / 祝日データ無し時の土日縮退)。
- **34件 → 37件、全通過**(`node tests/logic.test.js`)。

## GASに貼り直すファイル
- 新規: `gas/Verify.gs`, `gas/TradingCalendar.gs`
- 更新: `gas/Code.gs`, `gas/Market.gs`
- (`tests/` はローカル専用。GASには不要)
