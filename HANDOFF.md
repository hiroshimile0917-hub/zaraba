# 引き継ぎメモ

## ステータス: 全面稼働開始(2026-07-13)

**残タスク: 明朝の朝刊確認のみ**

日経を読まない個人投資家向けの一次情報配信システム「ザラバ」、本番稼働を開始した。

## 稼働中の構成(すべて確認済み)

- **バックエンド(GAS)**: `setupTriggers()` 実行済み・`smokeTest()` 全項目クリア・Webアプリデプロイ済み
  - 朝刊(8時台)/ TDnet巡回(5分)/ EDINET巡回(15分)/ 週次決算予定更新(日曜夜)
- **フロント**: `index.html` を GitHub リポジトリ `hiroshimile0917-hub/zaraba` に push 済み
  - `API_URL` は本番GAS WebアプリURLに設定済み
  - GitHub Pages 公開URL(有効化後): https://hiroshimile0917-hub.github.io/zaraba/
- **J-Quants**: V2 API(`x-api-key` 方式)へ移行済み。時価総額は `fins/summary` の
  AvgSh(平均株式数)→ Eq(自己資本)÷BPS(1株純資産)の順で株式数を推定
- **Discord通知**: 疎通OK(HTTP 204)。旧 `postDiscord` のエラー握り潰しは修正済み
  (非204/200を `Logger.log` 記録+boolean返却。配信は止めないフェイルオープン維持)
- **祝日判定**: `TradingCalendar.gs`(J-Quants `/markets/calendar` 連携・取得不可時は土日のみに縮退)
- **Gemini**: `gemini-flash-latest`(旧 `gemini-2.5-flash` は廃止)

## 残タスク(唯一)

- **明朝の朝刊配信の確認**
  - 平日朝(8時台)に朝刊ダイジェスト(注目開示+本日の予定+昨日の答え合わせ)が
    **Discord と ザラバ(Web)の両方**に出ることを確認する
  - 出ない場合: GASの実行ログ(`morningDigest` の失敗痕跡)→ `diagnoseDiscord()` / `smokeTest()` で切り分け

## 参考: 継続確認の観点(随時)

- 場中に修正率付きの即時アラートが重複なく流れる(時価総額フィルタ動作)
- 大量保有報告(5%ルール)の検知・配信
- 銘柄ページがスマホで快適に読める / **フッター免責文言が全画面で表示**(絶対条件)
- 月間ランニングコスト 0円 の維持

## ローカル / リポジトリ

- ローカルテスト: `node tests/logic.test.js` = **39件 全通過**
- GitHubは `index.html` のみ公開中。`gas/` はローカルでバージョン管理(公開可否は保留)
- 詳細な変更履歴は `PATCH_NOTES.md` を参照
