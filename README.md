# ザラバ — 日本株ニュース配信システム セットアップと運用

月間ランニングコスト **0円** 構成。GAS(バックエンド)+ GitHub Pages(フロント)。

## ファイル構成

```
gas/
  Code.gs            メイン(設定・朝刊・巡回・配信・トリガー)
  Analyze.gs         修正率のPDF抽出・定量インパクト判定・カテゴリ分類
  Store.gs           スプレッドシート永続化(articles/digests/caps/earnings)
  Api.gs             doGet() JSON API(Web用・cron用)
  Market.gs          時価総額・株価取得・昨日の答え合わせ
  JQuants.gs         J-Quants API(認証・株価・時価総額・決算予定・信用残・空売り残高)
  Edinet.gs          大量保有報告(5%ルール)巡回・アクティビスト判定
  CalendarEvents.gs  イベントカレンダー(日銀・FOMC・CPI・SQ・決算予定)
index.html           Webアプリ「ザラバ」(GitHub Pagesに置く)
.env.example         シークレット設定テンプレート(.envにコピーして使用)
tools/env-to-setup.js  .env → SetupLocal.gs 生成ツール
tests/logic.test.js  ロジックのローカルテスト(node tests/logic.test.js)
```

## セットアップ手順

### 1. GAS
1. script.google.com で既存プロジェクトを開き、`gas/` の7ファイルをそれぞれ「ファイル追加」で貼り付け(既存Code.gsは置き換え)。
2. シークレットの設定 — **方法A(.env経由・推奨)**:
   ```
   cp .env.example .env      # 値を記入(EDINETキー等)
   node tools/env-to-setup.js  # gas/SetupLocal.gs が生成される
   ```
   生成された `SetupLocal.gs` をGASエディタに貼り付け → `applySecrets()` を1回実行 →
   **GAS上のSetupLocal.gsを削除**(反映確認は `checkSecrets()`)。
   `.env` と `SetupLocal.gs` は .gitignore 済みでコミットされません。
   GASは実行時に.envを読めないため、実体はスクリプトプロパティに保存されます。

   **方法B(手動)** — スクリプトプロパティ(プロジェクトの設定 → スクリプト プロパティ)に直接入力:
   - `DISCORD_WEBHOOK_URL`(必須)
   - `GEMINI_API_KEY`(必須)
   - `JQUANTS_MAIL` / `JQUANTS_PASSWORD`(推奨) — J-Quantsの登録メール/パスワード。トークンは自動取得・自動更新。
   - `EDINET_API_KEY`(必須・大量保有機能用) — [EDINET](https://disclosure2.edinet-fsa.go.jp/) のAPI利用登録(無料)で取得。未設定なら大量保有巡回は自動スキップ。
   - `CRON_TOKEN`(任意) — cron-job.org を使う場合の合言葉(ランダム文字列)。
   - `SHEET_ID` は初回実行時に「ザラバDB」スプレッドシートが自動作成されて設定されます。
3. (任意)J-Quants未設定時に決算発表予定を使う場合のみ: エディタ左「サービス +」→ **Drive API** を追加(v2)。J-Quants設定済みなら不要。
4. `setupTriggers()` を1回手動実行(権限承認)。
5. 動作確認: `testPatrol()` → Discordに速報が来る / `testMorning()` → 朝刊が来る / `testEdinet()`(キー設定時)。

### 2. Web API公開
1. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
   - 実行ユーザー: 自分 / アクセス: **全員**
2. 発行されたURL(`https://script.google.com/macros/s/…/exec`)をコピー。

### 3. フロント(GitHub Pages)
1. `index.html` の `const API_URL = ""` にWebアプリURLを設定。
2. GitHubリポジトリに `index.html` だけ置いて Pages を有効化。
   - **注意**: API_URL以外のシークレット(Webhook/APIキー)は絶対にコミットしない。API_URLは公開されても閲覧専用(書き込み系は `CRON_TOKEN` で保護)。

### 4. 8:30の時刻精度が必要になったら(任意)
GASの時間トリガーは「8時台のどこか」で±1時間ズレます。固定したい場合:
1. `morningDigest` の時間トリガーを削除し、代わりに [cron-job.org](https://cron-job.org)(無料)で毎平日 8:30 JST に
   `https://…/exec?action=morning&token=(CRON_TOKEN)` をGET。

## データソースと費用

| データ | 第一ソース | フォールバック | 追加費用 |
|---|---|---|---|
| 適時開示 | TDnet(Yanoshin API) | — | 0円 |
| 開示PDF本文 | TDnet PDF + Gemini無料枠 | — | 0円 |
| 大量保有報告 | EDINET API v2(要無料キー) | — | 0円 |
| 時価総額 | **J-Quants**(株価×発行済株式数) | Yahoo(非公式) | 0円(加入済) |
| 日足株価(答え合わせ) | **J-Quants** daily_quotes | stooq → Yahoo chart | 0円(加入済) |
| 決算発表予定 | **J-Quants** fins/announcement | JPX Excel(Drive API) | 0円(加入済) |
| 信用残(週末残高) | **J-Quants** weekly_margin_interest | なし(非表示) | 0円(加入済) |
| 空売り残高報告 | **J-Quants** short_selling_positions | なし(非表示) | 0円(加入済) |
| 日銀/FOMC/CPI/SQ | 公表済み年間日程(静的)+SQは計算 | — | 0円 |
| AI解説 | Gemini 2.5 Flash 無料枠 | — | 0円 |
| 配信/ホスティング | Discord Webhook / GitHub Pages | — | 0円 |

※J-Quantsスタンダードは既加入のため追加コスト0円。本システム自体のランニングは引き続き月0円。

## 機能まとめ

- **朝刊(平日8時台)**: AIダイジェスト+📅本日の予定(日銀・FOMC・米CPI・SQ・決算発表)+🔎昨日の答え合わせ(前営業日のインパクト大銘柄の騰落率)
- **場中速報(5分間隔・8〜19時)**: 業績修正はPDFから修正前後の数値を抽出し「営業益 会社予想比+12.4%(450→506億円)」を付けて配信。インパクト判定は定量基準(営業益±10%=大/±5〜10%=中、赤字転落・黒字転換=大)、抽出不能時はキーワードにフォールバック。時価総額300億円未満はアラート抑制(`CONFIG.MARKET_CAP_FILTER`でOFF可、保存はされる)
- **大量保有速報(15分間隔)**: 提出者・保有割合の増減を表示。アクティビストウォッチリスト該当は🚨インパクト大
- **Web「ザラバ」**: 朝刊カード+タイムライン(フィルタ: インパクト大/業績修正/TOB・提携/還元・分割/大量保有)。銘柄コードタップ→銘柄ページ(過去開示タイムライン+「3回連続の上方修正」等の文脈行)。全画面に免責フッター

## 既知の制約(重要)

1. **時価総額は概算**。J-Quantsの「発行済株式数(自己株込み・期末時点)」×前営業日終値で計算するため、自己株控除後の厳密値とは数%ズレる。300億円フィルタの用途には十分。取得失敗時はYahoo(非公式)→古いキャッシュ→フェイルオープン(全件配信)の順で縮退。
2. **J-Quantsの日足は前営業日分まで**(夕方〜夜に更新)。朝刊8:30時点で前営業日終値は取得可能だが、万一未反映なら「(株価データ未反映)」と表示。
3. **祝日判定は未実装**(土日のみ考慮)。祝日明けの「答え合わせ」は対象日がずれる場合あり。J-Quantsの取引カレンダーAPI(/markets/trading_calendar)で対応可能——必要なら追加します。
4. **決算発表予定(fins/announcement)は3月期・9月期決算会社の翌営業日分が中心**。網羅性が必要な場合はJPX Excelフォールバックを併用。
5. **日銀/FOMC/CPIの日程は2026年分を静的保持**。毎年1回、公表され次第更新が必要(日銀は例年7月末に翌年分公表)。
6. **空売り残高報告(short_selling_positions)のプラン提供範囲は要確認**。スタンダードで403が返る場合、銘柄ページの該当ブロックは自動非表示(他機能に影響なし)。
7. GAS 5分トリガーのため、開示から配信まで最大約5分+処理時間の遅延。
8. 銘柄ページの過去開示は**システム稼働開始以降の蓄積分**のみ(遡及取得はしない)。

## 法令・コンテンツ規律(実装済み)

- 入力は一次情報のみ(TDnet開示PDF・EDINET・公的日程)。記事メディアの転載なし
- プロンプトで売買推奨を禁止、推測は「〜とみられる」を強制
- Webは全画面共通フッターで免責を常時表示
