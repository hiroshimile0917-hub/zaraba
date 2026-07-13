/**
 * ザラバ — 日本株ニュース配信システム(月0円構成)
 * - 8:30頃: 朝刊ダイジェスト(注目開示+本日の予定+昨日の答え合わせ)
 * - 取引時間帯: 5分間隔でTDnet巡回 → 修正率付き即時アラート(時価総額フィルタ適用)
 * - 15分間隔: EDINET巡回 → 大量保有報告(5%ルール)速報
 * - 全配信記事をスプレッドシートに保存し、doGet() の JSON API でWebアプリ「ザラバ」に供給
 *
 * 構成: GAS + TDnet(Yanoshin API) + EDINET API + Gemini無料枠 + Discord Webhook + stooq/Yahoo(株価)
 * すべて無料。
 *
 * ■ セットアップ(README.md 参照)
 * スクリプトプロパティ:
 *   DISCORD_WEBHOOK_URL = Discord WebhookのURL(必須)
 *   GEMINI_API_KEY      = Google AI StudioのAPIキー(必須)
 *   EDINET_API_KEY      = EDINET APIキー(任意。未設定なら大量保有巡回はスキップ)
 *   CRON_TOKEN          = cron-job.org等から叩く場合の合言葉(任意)
 *   SHEET_ID            = 自動生成される(手動設定不要)
 * 初回: setupTriggers() を1回手動実行。テスト: testMorning() / testPatrol() / testEdinet()
 */

// ================= 設定 =================
const CONFIG = {
  GEMINI_MODEL: 'gemini-2.5-flash',
  PATROL_START_HOUR: 8,       // TDnet巡回開始(時)
  PATROL_END_HOUR: 19,        // TDnet巡回終了(時)。引け後の開示(〜18時台)も保存・配信する
  MAX_ALERTS_PER_RUN: 5,      // 1回の巡回で配信する最大件数

  // 定量インパクト基準(営業利益の会社予想比変化率)
  IMPACT_HIGH_PCT: 10,        // ±10%以上 = インパクト大
  IMPACT_MID_PCT: 5,          // ±5〜10%  = 注目

  // 時価総額フィルタ
  MARKET_CAP_FILTER: true,    // ONで小型株のアラートを抑制(保存はされる)
  MARKET_CAP_MIN_OKU: 300,    // 億円。これ未満はアラート対象外
  CAP_CACHE_DAYS: 7,          // 時価総額キャッシュの有効日数

  ALERT_MIN_IMPACT: 'mid',    // アラートする最低インパクト('mid'|'high')
};

// タイトルだけでインパクト大が確定するキーワード(定量抽出が無くても大)
const FORCE_HIGH_KEYWORDS = [
  '公開買付', 'TOB', 'MBO', '完全子会社化', '経営統合', '合併',
  '上場廃止', '監理銘柄', '民事再生', '会社更生', '債務超過', '希望退職',
  '株式分割', '株式併合',
];

// 注目(中)キーワード
const HIGH_IMPACT_KEYWORDS = [
  '上方修正', '下方修正', '業績予想の修正', '業績予想及び配当予想の修正',
  '公開買付', 'TOB', 'MBO', '完全子会社化',
  '自己株式取得', '自己株式の取得', '増配', '復配', '株式分割',
  '資本業務提携', '業務提携', '資本提携', '経営統合', '合併',
  '上場廃止', '監理銘柄', '特別損失', '特別利益',
  '希望退職', '民事再生', '会社更生', '債務超過',
  '新株予約権', '第三者割当', 'ストップ高', 'ストップ安',
  '大量保有', '無償割当', '株主優待',
];

// ノイズ除外キーワード
const EXCLUDE_KEYWORDS = [
  '訂正', 'コーポレート・ガバナンス', '定款', '招集', '議決権行使',
  '有価証券報告書', '四半期報告書', '(REIT)', '投資法人',
];

// ================= エントリーポイント =================

/** 朝刊ダイジェスト(時間トリガー: 8時台 / または cron-job.org → doGet?action=morning) */
function morningDigest() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return; // 土日スキップ

  const from = new Date(now);
  from.setDate(from.getDate() - (day === 1 ? 3 : 1)); // 月曜は金曜分から
  from.setHours(15, 30, 0, 0);

  const items = fetchTdnet(200).filter(it => it.pubdate >= from && !isExcluded(it.title));

  // --- マーケット概況(前夜の米市場・為替・前日の日本市場・投資部門別) ---
  let market = null;
  let marketLines = [];
  try {
    market = getMarketBrief();
    marketLines = buildMarketLines(market);
  } catch (e) { Logger.log('marketBrief: ' + e); }

  // --- 注目開示の解説 ---
  let digestBody = '';
  let top = [];
  if (items.length > 0) {
    const ranked = items.sort((a, b) => scoreTitle(b.title) - scoreTitle(a.title));
    top = ranked.filter(it => scoreTitle(it.title) > 0).slice(0, 5);
    if (top.length === 0) top = ranked.slice(0, 3);

    // 業績修正は修正率を抽出して解説に反映
    for (const it of top) {
      it.revision = isRevisionTitle(it.title) ? extractRevision(it.url) : null;
    }
    const list = top.map(it => {
      const rev = it.revision && it.revision.text ? `【${it.revision.text}】` : '';
      return `・${it.company}(${it.code}) ${it.title} ${rev}`;
    }).join('\n');

    const prompt = [
      'あなたは日本株担当の金融記者です。以下は昨日引け後から今朝までの適時開示の一覧と、前夜の市況データです。',
      '朝刊のマーケット面のような文体で、投資家向けダイジェストを日本語で書いてください。',
      '構成: (1)全体観を2行(市況データを踏まえ、本日の東京市場の地合いを導く) (2)注目開示を最大5本、各2〜3行で「何が起きたか/なぜ株価に効くか/背景」を解説。',
      '【】内の数値は開示PDFから抽出した修正率で、必ず解説に織り込むこと。',
      '事実は開示タイトル・抽出数値・市況データの範囲にとどめ、推測は「〜とみられる」と明示。売買推奨はしない。',
      '出力はDiscord向けプレーンテキスト。全体で600字以内。',
      '',
      marketLines.length ? '【前夜・前日の市況】\n' + marketLines.join('\n') : '',
      '',
      '【開示一覧】',
      list,
    ].filter(s => s !== '').join('\n');
    digestBody = callAi(prompt);
  } else {
    digestBody = '昨日引け後からの注目開示はありませんでした。';
  }

  // --- 本日の予定 ---
  const events = getTodayEvents(now);
  const eventsText = events.length
    ? events.map(ev => `・${ev.label}`).join('\n')
    : '・特になし';

  // --- 昨日の答え合わせ ---
  const answers = answerCheck(now);
  const answersText = answers.length
    ? answers.map(a => {
        const pct = (a.pct == null) ? '取得できず' : `${a.pct > 0 ? '+' : ''}${a.pct.toFixed(1)}%`;
        return `・${a.company}(${a.code}) ${pct}${a.note ? ' ' + a.note : ''}`;
      }).join('\n')
    : null;

  // --- Discord配信 ---
  const parts = [
    `📰 **朝刊ダイジェスト** ${fmtDate(now)}`,
    '',
    digestBody,
  ];
  if (marketLines.length) {
    parts.push('', `🌐 **マーケット概況**`, marketLines.map(l => `・${l}`).join('\n'));
  }
  parts.push('', `📅 **本日の予定**`, eventsText);
  if (answersText) {
    parts.push('', `🔎 **昨日の答え合わせ**(インパクト大銘柄の騰落率)`, answersText);
  }
  parts.push('', `(対象開示 ${items.length}件 / 出典: TDnet)`);
  postDiscord(parts.join('\n'));

  // --- 保存(Web用) ---
  saveDigest({
    date: fmtDate(now),
    title: makeDigestTitle(digestBody),
    body: digestBody,
    count: items.length,
    events: events,
    answers: answers,
    marketLines: marketLines,
  });

  // 朝刊対象の注目開示もタイムラインに保存(夜間分を拾う)
  for (const it of top) {
    saveArticleIfNew(buildArticle(it, decideImpact(it, it.revision), it.revision, 'tdnet'));
  }
}

/** 取引時間帯のTDnet巡回(時間トリガー: 5分間隔) */
function patrol() {
  const now = new Date();
  const h = now.getHours();
  const day = now.getDay();
  if (day === 0 || day === 6) return;
  if (h < CONFIG.PATROL_START_HOUR || h >= CONFIG.PATROL_END_HOUR) return;

  const props = PropertiesService.getScriptProperties();
  const seen = JSON.parse(props.getProperty('SEEN_IDS') || '[]');
  const seenSet = new Set(seen);

  const items = fetchTdnet(50);
  const fresh = items.filter(it =>
    !seenSet.has(it.id) && !isExcluded(it.title) && scoreTitle(it.title) > 0
  ).slice(0, CONFIG.MAX_ALERTS_PER_RUN);

  for (const it of fresh) {
    seenSet.add(it.id); // 先に既読化(途中エラーでも重複配信しない)
    try {
      processDisclosure(it);
    } catch (e) {
      Logger.log('processDisclosure error: ' + e);
    }
    Utilities.sleep(1500);
  }

  props.setProperty('SEEN_IDS', JSON.stringify([...seenSet].slice(-500)));
}

/** 1件の開示を処理: 定量抽出 → インパクト判定 → フィルタ → 解説 → 配信 → 保存 */
function processDisclosure(it) {
  const revision = isRevisionTitle(it.title) ? extractRevision(it.url) : null;
  const impact = decideImpact(it, revision);
  const article = buildArticle(it, impact, revision, 'tdnet');

  // 時価総額フィルタ(判定不能時はフェイルオープン=配信する)
  let filtered = false;
  if (CONFIG.MARKET_CAP_FILTER) {
    const cap = getMarketCapOku(it.code);
    article.capOku = cap;
    if (cap != null && cap < CONFIG.MARKET_CAP_MIN_OKU) filtered = true;
  }

  const rank = { low: 0, mid: 1, high: 2 };
  const shouldAlert = !filtered && rank[impact] >= rank[CONFIG.ALERT_MIN_IMPACT];

  if (shouldAlert) {
    const revLine = revision && revision.text ? `\n📊 ${revision.text}` : '';
    const prompt = [
      'あなたは日本株担当の金融記者です。次の適時開示を投資家向けに速報解説してください。',
      '構成: 1行目に見出し。続けて「①何が起きたか ②株価への含意 ③背景・文脈」を各1〜2行。',
      revision && revision.text ? `開示PDFから抽出した数値: ${revision.text} — この数値を必ず①に織り込むこと。` : '',
      '事実はタイトルと抽出数値の範囲にとどめ、推測は「〜とみられる」と明示。売買推奨はしない。全体200字以内。',
      '',
      `会社: ${it.company}(${it.code})`,
      `開示タイトル: ${it.title}`,
      `開示時刻: ${fmtTime(it.pubdate)}`,
    ].filter(Boolean).join('\n');

    const summary = callAi(prompt);
    article.summary = summary;
    const badge = impact === 'high' ? '🚨' : '🔔';
    postDiscord(`${badge} **${it.company}(${it.code})** ${fmtTime(it.pubdate)}\n${it.title}${revLine}\n\n${summary}\n${it.url || ''}`);
  }

  article.filtered = filtered;
  saveArticleIfNew(article);
}

/** EDINET巡回(時間トリガー: 15分間隔) — Edinet.gs の edinetPatrol を呼ぶ */
function edinetPatrolJob() {
  const now = new Date();
  const day = now.getDay();
  const h = now.getHours();
  if (day === 0 || day === 6) return;
  if (h < 9 || h >= 18) return; // EDINETの受付時間帯のみ
  edinetPatrol();
}

/** 週次ジョブ: 決算発表予定の更新(日曜夜) */
function weeklyJob() {
  try { updateEarningsSchedule(); } catch (e) { Logger.log('earnings schedule: ' + e); }
}

// ================= データ取得(TDnet) =================

function fetchTdnet(limit) {
  const url = `https://webapi.yanoshin.jp/webapi/tdnet/list/recent.json?limit=${limit}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return [];
  const json = JSON.parse(res.getContentText());
  return (json.items || []).map(row => {
    const t = row.Tdnet || row;
    return {
      id: t.id || (t.company_code + t.pubdate + t.title),
      code: String(t.company_code || '').slice(0, 4),
      company: t.company_name || '',
      title: t.title || '',
      pubdate: new Date(t.pubdate),
      url: t.document_url || '',
    };
  });
}

// ================= 判定 =================

function scoreTitle(title) {
  let s = 0;
  for (const kw of HIGH_IMPACT_KEYWORDS) if (title.includes(kw)) s += 10;
  return s;
}

function isExcluded(title) {
  return EXCLUDE_KEYWORDS.some(kw => title.includes(kw));
}

// ================= AI(Gemini無料枠) =================

function callAi(prompt) {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${key}`;
  const payload = { contents: [{ parts: [{ text: prompt }] }] };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return '(解説の生成に失敗しました)';
  try {
    return JSON.parse(res.getContentText()).candidates[0].content.parts[0].text.trim();
  } catch (e) {
    return '(解説の生成に失敗しました)';
  }
}

// ================= 配信 =================

function postDiscord(text) {
  const url = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
  if (!url) {
    Logger.log('postDiscord: DISCORD_WEBHOOK_URL が未設定のため送信スキップ');
    return false;
  }
  let allOk = true;
  const chunks = [];
  for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900));
  for (const c of chunks) {
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ content: c }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code !== 204 && code !== 200) { // Webhook成功は204
      Logger.log(`postDiscord: HTTP ${code} — ${res.getContentText().slice(0, 200)}`);
      allOk = false;
    }
    Utilities.sleep(500);
  }
  return allOk;
}

// ================= トリガー設定 =================

/** 初回に1度だけ手動実行 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('morningDigest').timeBased().atHour(8).everyDays(1).create();
  ScriptApp.newTrigger('patrol').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('edinetPatrolJob').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('weeklyJob').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(20).create();
}

// ================= テスト用 =================

function testMorning() { morningDigest(); }
function testPatrol() {
  PropertiesService.getScriptProperties().deleteProperty('SEEN_IDS');
  patrol();
}
function testEdinet() {
  PropertiesService.getScriptProperties().deleteProperty('SEEN_EDINET');
  edinetPatrol();
}

// ================= ユーティリティ =================

function fmtDate(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'M月d日(E)'); }
function fmtTime(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'HH:mm'); }
function fmtYmd(d)  { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd'); }

function makeDigestTitle(body) {
  // ダイジェスト本文の1行目を見出しに(50字まで)
  const first = String(body).split('\n').map(s => s.trim()).filter(Boolean)[0] || '本日の注目開示';
  return first.length > 50 ? first.slice(0, 50) + '…' : first;
}
