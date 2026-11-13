# アクセス計測案（2026-11-13、提案のみ・未導入）

計測コード・外部送信・アカウント作成は承認後。現在の改修では追加しない。

| 方法 | 月額 | 訪問・朝刊・操作の確認 | 個人情報・識別 |
|---|---|---|---|
| GoatCounter hosted | 合理的な公開利用の範囲で0円 | PV/訪問、朝刊表示、フィルタ変更、登録操作をイベントで集計できる | Cookieや永続IDを使わず、重複判定にサイト名+IP+User-Agentを最大8時間メモリ保持。社名/コード/検索語/登録リストは送らない |
| Google Analytics 4 標準版 | 0円（有料360・有料連携は使わない） | PV/訪問とカスタムイベント。朝刊表示やウォッチ操作を集計できる | 通常Cookieによるクライアント識別。IPは収集時の地域推定後に破棄。広告機能・Google signals・User-IDは使わず、必要な説明と同意方針を決める |
| Cloudflare Web Analytics | 0円 | PV/訪問・速度の概況向け。カスタムイベント非対応なので朝刊閲覧・ウォッチ操作の詳細には不足 | CookieやlocalStorageによる利用者追跡をしない。保有銘柄を送らない |

推奨はGoatCounter。目的に必要なイベントを取れ、ブラウザ識別の永続Cookieを避けられる。無料利用の条件・データ保持・運営主体を確認してから採用する。

## 最小のイベント設計（未実装）
- page_view: ページ表示。ハッシュの銘柄コード・URLの検索語は送らない。
- morning_view: 朝刊領域が一定割合画面内に入ったとき、1表示につき1回。本文を読んだ保証とは区別する。
- filter_change: all/high/earnings/deal/return/holdingだけを送る。
- watch_add / watch_remove / watch_only: 操作の種類だけ送る。銘柄や件数・保有情報は送らない。
- search_use: 検索利用の有無だけを集計し、検索文字列は送らない。

Cookie不使用でも受信側には通信上のIP等が届く。匿名を過大に保証しない。利用者向け説明に計測先・目的・送信項目・保存方針を明記する。広告ブロック等による過少計測もあるため、PVを実利用者の厳密な人数と扱わない。

## 公式資料
- GoatCounterの料金: https://www.goatcounter.com/
- イベント: https://www.goatcounter.com/help/events
- プライバシー: https://www.goatcounter.com/help/privacy
- GA標準版: https://marketingplatform.google.com/about/analytics/
- GA4地域データ: https://support.google.com/analytics/answer/11598602
- GA4 Cookie: https://developers.google.com/analytics/devguides/collection/ga4/cookie-usage
- Cloudflare: https://developers.cloudflare.com/web-analytics/about/
- Cloudflare制限: https://developers.cloudflare.com/web-analytics/faq/
