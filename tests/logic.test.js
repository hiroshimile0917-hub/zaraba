/* GASコードの純粋関数をNodeで検証するハーネス */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

// GASグローバルのスタブ
global.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null, setProperty: () => {}, deleteProperty: () => {} }) };
global.Logger = { log: () => {} };
global.Utilities = {
  formatDate: (d, tz, fmt) => {
    // テストで使う書式のみ簡易実装(JSTローカル前提)
    const p = n => String(n).padStart(2, '0');
    if (fmt === 'yyyy-MM-dd') return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
    if (fmt === 'yyyyMMdd') return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}`;
    if (fmt === 'HH:mm') return `${p(d.getHours())}:${p(d.getMinutes())}`;
    return String(d);
  },
  sleep: () => {}, base64Encode: () => '', unzip: () => [],
};
global.UrlFetchApp = { fetch: () => { throw new Error('network disabled in tests'); } };
global.SpreadsheetApp = {}; global.LockService = {}; global.ScriptApp = {}; global.ContentService = {};

// gasファイルを結合して評価
const gasDir = path.join(__dirname, '..', 'gas');
const src = ['Code.gs', 'Gemini.gs', 'Analyze.gs', 'Market.gs', 'Edinet.gs', 'CalendarEvents.gs', 'JQuants.gs', 'TradingCalendar.gs']
  .map(f => fs.readFileSync(path.join(gasDir, f), 'utf8')).join('\n');
eval(src + '\nglobal.ACTIVIST_WATCHLIST = ACTIVIST_WATCHLIST;');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  NG  ' + name + ' — ' + e.message); }
}

console.log('--- computeRevision / インパクト判定 ---');
t('上方修正+12.4% → high', () => {
  const rev = computeRevision({ is_revision: true, op_old: 45000, op_new: 50600 });
  assert(Math.abs(rev.pct - 12.444) < 0.01, 'pct=' + rev.pct);
  assert.strictEqual(rev.metric, '営業益');
  assert(rev.text.includes('+12.4%'), rev.text);
  assert(rev.text.includes('450→506億円'), rev.text);
  assert.strictEqual(decideImpact({ title: '業績予想の修正' }, rev), 'high');
});
t('下方修正-6.8% → mid', () => {
  const rev = computeRevision({ is_revision: true, op_old: 22000, op_new: 20500 });
  assert(Math.abs(rev.pct + 6.818) < 0.01, 'pct=' + rev.pct);
  assert.strictEqual(decideImpact({ title: '業績予想の修正' }, rev), 'mid');
});
t('小幅修正+2% → low(定量でノイズ落ち)', () => {
  const rev = computeRevision({ is_revision: true, op_old: 10000, op_new: 10200 });
  assert.strictEqual(decideImpact({ title: '業績予想の修正に関するお知らせ' }, rev), 'low');
});
t('赤字転落 → signFlip & high', () => {
  const rev = computeRevision({ is_revision: true, op_old: 5000, op_new: -3000 });
  assert.strictEqual(rev.signFlip, true);
  assert(rev.text.includes('赤字転落'), rev.text);
  assert.strictEqual(decideImpact({ title: '下方修正' }, rev), 'high');
});
t('黒字転換 → high', () => {
  const rev = computeRevision({ is_revision: true, op_old: -2000, op_new: 1500 });
  assert(rev.text.includes('黒字転換'), rev.text);
  assert.strictEqual(decideImpact({ title: '上方修正' }, rev), 'high');
});
t('営業益なし → 純利益で判定', () => {
  const rev = computeRevision({ is_revision: true, np_old: 30000, np_new: 36000 });
  assert.strictEqual(rev.metric, '純利益');
  assert(Math.abs(rev.pct - 20) < 0.01);
});
t('is_revision=false → null', () => {
  assert.strictEqual(computeRevision({ is_revision: false, op_old: 1, op_new: 2 }), null);
});
t('抽出失敗時はキーワードにフォールバック: TOB → high', () => {
  assert.strictEqual(decideImpact({ title: '〇〇株式会社株券に対する公開買付けの開始' }, null), 'high');
});
t('抽出失敗時: 自己株式取得 → mid', () => {
  assert.strictEqual(decideImpact({ title: '自己株式取得に係る事項の決定' }, null), 'mid');
});
t('キーワード非該当 → low', () => {
  assert.strictEqual(decideImpact({ title: '本社移転のお知らせ' }, null), 'low');
});

console.log('--- カテゴリ分類 ---');
t('上方修正 → earnings', () => assert.strictEqual(classifyCategory('通期業績予想の上方修正'), 'earnings'));
t('TOB → deal', () => assert.strictEqual(classifyCategory('公開買付けの開始に関するお知らせ'), 'deal'));
t('自己株式 → return', () => assert.strictEqual(classifyCategory('自己株式の取得に係る事項'), 'return'));
t('大量保有 → holding', () => assert.strictEqual(classifyCategory('変更報告書(大量保有)'), 'holding'));

console.log('--- stooq CSVパース ---');
t('正常CSV → 新しい順', () => {
  const csv = 'Date,Open,High,Low,Close,Volume\n2026-07-09,100,110,95,105,1000\n2026-07-10,105,115,100,112,1200';
  const rows = parseStooqCsv(csv);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].date, '2026-07-10');
  assert.strictEqual(rows[0].close, 112);
});
t('異常CSV → null', () => {
  assert.strictEqual(parseStooqCsv('<html>error</html>'), null);
});

console.log('--- EDINET CSVパース ---');
t('保有割合の抽出(今回/前回・比率表記)', () => {
  const tsv = [
    '"要素ID"\t"項目名"\t"値"',
    '"jplvh_cor:HoldingRatioOfShareCertificatesEtc"\t"株券等保有割合"\t"0.0634"',
    '"jplvh_cor:HoldingRatioOfShareCertificatesEtcPerLastReport"\t"直前の報告書に記載された株券等保有割合"\t"0.0512"',
    '"jplvh_cor:NameOfIssuer"\t"発行者の名称"\t"デモホールディングス株式会社"',
    '"jplvh_cor:SecurityCodeOfIssuer"\t"証券コード"\t"60980"',
  ].join('\n');
  const d = parseHoldingCsv(tsv);
  assert(Math.abs(d.ratio - 6.34) < 0.01, 'ratio=' + d.ratio);
  assert(Math.abs(d.prevRatio - 5.12) < 0.01, 'prev=' + d.prevRatio);
  assert.strictEqual(d.issuer, 'デモホールディングス株式会社');
  assert.strictEqual(normalizeSecCode(d.secCode), '6098');
});
t('%表記(6.34)でもそのまま%として扱う', () => {
  const tsv = '"jplvh_cor:HoldingRatioOfShareCertificatesEtc"\t"割合"\t"6.34"';
  const d = parseHoldingCsv(tsv);
  assert(Math.abs(d.ratio - 6.34) < 0.01, 'ratio=' + d.ratio);
});
t('アクティビスト判定', () => {
  assert(ACTIVIST_WATCHLIST.some(w => 'シティインデックスイレブンス'.toUpperCase().includes(w.toUpperCase())));
  assert(ACTIVIST_WATCHLIST.some(w => 'Oasis Management Company Ltd.'.toUpperCase().includes(w.toUpperCase())));
});

console.log('--- SQ日計算 ---');
t('2026年7月のSQ=7/10(第2金曜)', () => assert.strictEqual(sqDateOfMonth(2026, 7), '2026-07-10'));
t('2026年3月のメジャーSQ=3/13', () => assert.strictEqual(sqDateOfMonth(2026, 3), '2026-03-13'));
t('2026年1月=1/9', () => assert.strictEqual(sqDateOfMonth(2026, 1), '2026-01-09'));
t('2026年5月=5/8(1日が金曜)', () => assert.strictEqual(sqDateOfMonth(2026, 5), '2026-05-08'));

console.log('--- 営業日計算 ---');
t('月曜の前営業日=金曜', () => {
  const mon = new Date(2026, 6, 13); // 2026-07-13 Mon
  assert.strictEqual(fmtYmd(prevBusinessDayJP(mon)), '2026-07-10');
});
t('火曜の前営業日=月曜', () => {
  const tue = new Date(2026, 6, 14);
  assert.strictEqual(fmtYmd(prevBusinessDayJP(tue)), '2026-07-13');
});

console.log('--- 営業日判定(祝日対応) ---');
t('祝日(海の日 2026-07-20)は非営業日', () => {
  const hs = new Set(['2026-07-20']);
  assert.strictEqual(isBusinessDayJPCore(new Date(2026, 6, 20), hs), false); // 月・祝
  assert.strictEqual(isBusinessDayJPCore(new Date(2026, 6, 21), hs), true);  // 火・平日
});
t('連休明けの前営業日は祝日を飛ばす(7/21火→7/17金)', () => {
  const hs = new Set(['2026-07-20']); // 海の日(月)を挟む3連休
  assert.strictEqual(fmtYmd(prevBusinessDayJPCore(new Date(2026, 6, 21), hs)), '2026-07-17');
});
t('祝日データ無し(null)は土日のみ判定に縮退(フェイルオープン)', () => {
  assert.strictEqual(isBusinessDayJPCore(new Date(2026, 6, 17), null), true);  // 金・平日
  assert.strictEqual(isBusinessDayJPCore(new Date(2026, 6, 18), null), false); // 土
  assert.strictEqual(isBusinessDayJPCore(new Date(2026, 6, 20), null), true);  // 祝でもnullなら営業日扱い
  assert.strictEqual(fmtYmd(prevBusinessDayJPCore(new Date(2026, 6, 13), null)), '2026-07-10'); // 月→金
});

console.log('--- イベントカレンダー ---');
t('7/31は日銀結果発表日(展望レポート)', () => {
  global.__earningsStub = [];
  const orig = global.earningsByDate;
  global.earningsByDate = () => [];
  const evs = getTodayEvents(new Date(2026, 6, 31));
  assert(evs.some(e => e.type === 'boj' && e.label.includes('結果発表') && e.label.includes('展望')), JSON.stringify(evs));
  global.earningsByDate = orig;
});
t('7/10はSQ日(オプションSQ)', () => {
  const orig = global.earningsByDate;
  global.earningsByDate = () => [];
  const evs = getTodayEvents(new Date(2026, 6, 10));
  assert(evs.some(e => e.type === 'sq' && e.label.includes('オプションSQ')), JSON.stringify(evs));
  global.earningsByDate = orig;
});
t('7/14は米CPI発表日', () => {
  const orig = global.earningsByDate;
  global.earningsByDate = () => [];
  const evs = getTodayEvents(new Date(2026, 6, 14));
  assert(evs.some(e => e.type === 'cpi'), JSON.stringify(evs));
  global.earningsByDate = orig;
});

console.log('--- J-Quants パース ---');
t('daily_quotes → 新しい順・調整後終値優先', () => {
  const j = { daily_quotes: [
    { Date: '2026-07-09', Close: 5000, AdjustmentClose: 5000 },
    { Date: '2026-07-10', Close: 5150, AdjustmentClose: 5150 },
  ]};
  const rows = jqClosesFromResponse(j);
  assert.strictEqual(rows[0].date, '2026-07-10');
  assert.strictEqual(rows[0].close, 5150);
});
t('statements → 最新開示の発行済株式数を採用', () => {
  const st = { statements: [
    { DisclosedDate: '2025-05-10', NumberOfIssuedAndOutstandingSharesAtTheEndOfFiscalYearIncludingTreasuryStock: '100000000' },
    { DisclosedDate: '2026-05-10', NumberOfIssuedAndOutstandingSharesAtTheEndOfFiscalYearIncludingTreasuryStock: '98000000' },
    { DisclosedDate: '2026-06-10', NumberOfIssuedAndOutstandingSharesAtTheEndOfFiscalYearIncludingTreasuryStock: '' },
  ]};
  assert.strictEqual(jqPickShares(st), 98000000);
});
t('jqPickShares(V2) → AvgSh優先(Eq÷BPSより先)', () => {
  const st = { statements: [
    { DiscDate: '2026-05-10', AvgSh: 98000000, Eq: 500000000000, BPS: 5000 },
  ]};
  assert.strictEqual(jqPickShares(st), 98000000); // AvgSh採用(Eq÷BPS=1億株ではない)
});
t('jqPickShares(V2) → AvgSh無ければ Eq÷BPS で推定', () => {
  const st = { statements: [
    { DiscDate: '2026-05-10', Eq: 500000000000, BPS: 5000 }, // 自己資本5000億 ÷ BPS5000円 = 1億株
  ]};
  assert.strictEqual(jqPickShares(st), 100000000);
});
t('時価総額計算の整合(株価5150円×9800万株≒5047億円)', () => {
  const cap = Math.round(5150 * 98000000 / 1e8);
  assert.strictEqual(cap, 5047);
});
t('4桁→5桁コード変換', () => assert.strictEqual(jqCode('6501'), '65010'));

console.log('--- 表示整形 ---');
t('億円表記(大きい値は整数)', () => {
  assert.strictEqual(fmtOku(45000), '450');
  assert.strictEqual(fmtOku(1230), '12.3');
});
t('ダイジェスト見出し切り出し', () => {
  assert.strictEqual(makeDigestTitle('全体観の1行目\n本文'), '全体観の1行目');
});

// 実ネットワーク・Discord送信なしで失敗経路を検証する。
console.log('--- Gemini / 朝刊フォールバック ---');
const vm = require('vm');
function aiContext(sequence, key = 'test-secret') {
  const logs = [], sleeps = [], requests = [], cache = new Map();
  const props = new Map([['GEMINI_API_KEY', key]]);
  let timestamp = Date.parse('2026-11-13T08:30:00+09:00');
  const lock = { available: true, tryLock() { return this.available; }, releaseLock() {} };
  const context = vm.createContext({
    Date: class extends Date { constructor(...args) { super(...(args.length ? args : [timestamp])); } static now() { return timestamp; } },
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => props.get(name) || null, setProperty: (name, value) => props.set(name, value) }) },
    LockService: { getScriptLock: () => lock },
    CacheService: { getScriptCache: () => ({get: name => { const entry = cache.get(name); return entry && entry.until > timestamp ? entry.text : null; }, put: (name,text,ttl) => cache.set(name,{text,until:timestamp+ttl*1000})}) },
    Logger: { log: message => logs.push(message) },
    Utilities: {
      sleep: ms => { sleeps.push(ms); timestamp += ms; },
      formatDate: (date, tz) => {
        const parts = new Intl.DateTimeFormat('en-US', {timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
        const value = name => parts.find(part => part.type === name).value;
        return `${value('year')}-${value('month')}-${value('day')}`;
      },
      DigestAlgorithm: { SHA_256: 'sha256' }, Charset: {UTF_8:'utf8'},
      computeDigest: (algorithm, value) => [...require('crypto').createHash(algorithm).update(value).digest()],
      base64Encode: () => 'pdf',
    },
    UrlFetchApp: { fetch: (url, options) => {
      requests.push({ url, options });
      const next = sequence.shift();
      if (next instanceof Error) throw next;
      return { getResponseCode: () => next[0], getContentText: () => next[1], getAllHeaders:()=>next[2] || {} };
    } },
  });
  for (const file of ['Code.gs','Gemini.gs','Analyze.gs']) vm.runInContext(fs.readFileSync(path.join(gasDir, file), 'utf8'), context);
  // 従来のHTTP/パース単体テストでは間隔を省略。間隔そのものは別ケースで検証。
  vm.runInContext('CONFIG.GEMINI_MIN_INTERVAL_MS = 0', context);
  return { context, logs, sleeps, requests, props, cache, lock, setTime: value => { timestamp = Date.parse(value); } };
}
const aiOk = JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'internal' }, { text: '解説' }, { text: '続き' }] } }] });
t('503の後に回復、バックオフとモデル・キー送信を確認', () => {
  const c = aiContext([[503, 'unavailable'], [503, 'unavailable'], [200, aiOk]]);
  assert.strictEqual(c.context.callAi('入力', '一覧'), '解説\n続き');
  assert.deepStrictEqual(c.sleeps, [2000, 4000]);
  assert(c.logs.some(x => x.includes('HTTP 503') && x.includes('unavailable')));
  assert(c.requests[0].url.includes('gemini-flash-latest'));
  assert(!c.requests[0].url.includes('test-secret'));
  assert.strictEqual(c.requests[0].options.headers['x-goog-api-key'], 'test-secret');
});
t('401/403/404は再試行せずエラー本文を記録、キーは伏字', () => {
  for (const status of [401, 403, 404]) {
    const c = aiContext([[status, 'bad test-secret']]);
    assert.strictEqual(c.context.callAi('入力', '一覧'), '一覧');
    assert.strictEqual(c.requests.length, 1);
    assert(c.logs[0].includes(`HTTP ${status}`));
    assert(!c.logs[0].includes('test-secret'));
  }
});
t('不正JSON/空候補/ブロック/出力打切りで一覧に縮退', () => {
  for (const body of ['invalid', '{}', '{"promptFeedback":{"blockReason":"SAFETY"}}', JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '途中' }] } }] })]) {
    const c = aiContext([[200, body]]);
    assert.strictEqual(c.context.callAi('入力', '一覧'), '一覧');
    assert(c.logs[0].includes('HTTP 200'));
    assert(c.logs[0].includes(body));
  }
});
t('制限継続/通信例外でも3回で終了', () => {
  for (const sequence of [Array.from({ length: 3 }, () => [429, 'quota']), Array.from({ length: 3 }, () => new Error('network'))]) {
    const expected = sequence[0] instanceof Error ? 3 : 1;
    const c = aiContext(sequence);
    assert.strictEqual(c.context.callAi('入力', '一覧'), '一覧');
    assert.strictEqual(c.requests.length, expected);
  }
});
t('キー未設定はAPIを呼ばない', () => {
  const c = aiContext([], null);
  assert.strictEqual(c.context.callAi('入力', '一覧'), '一覧');
  assert.strictEqual(c.requests.length, 0);
});
t('開示一覧の見出し・本文に会社、コード、開示、抽出値を保持', () => {
  const body = buildDigestFallback([{ company: 'テスト', code: '1234', title: '上方修正', revision: { text: '営業益+12%' } }]);
  assert(makeDigestTitle(body).includes('今日の3本'));
  assert(body.includes('テスト(1234) 上方修正【営業益+12%】'));
  assert(body.includes('出典: TDnet'));
});

t('朝刊全体: 180件から最大3件、未来データ除外、AI障害でもWeb保存・Discord本文が残る', () => {
  const c = aiContext(Array.from({ length: 3 }, () => [429, 'quota']));
  const now = new Date('2026-11-13T08:30:00+09:00');
  c.context.Date = class extends Date { constructor(...args) { super(...(args.length ? args : [now.getTime()])); } };
  c.context.fetchTdnet = () => [
    ...Array.from({ length: 180 }, (_, n) => ({ id: String(n), company: '会社' + n, code: '1234', title: '自己株式取得', pubdate: new Date('2026-11-12T16:00:00+09:00'), url: '' })),
    { company: '未来会社', title: '公開買付', pubdate: new Date('2026-11-14T10:00:00+09:00') },
  ];
  c.context.isRevisionTitle = () => false;
  c.context.getMarketBrief = () => ({});
  c.context.buildMarketLines = () => ['市況'];
  c.context.getTodayEvents = () => [{ label: '予定' }];
  c.context.answerCheck = () => [];
  c.context.fmtDate = () => '11月13日';
  const articles = [], messages = [], digests = [];
  c.context.postDiscord = text => messages.push(text);
  c.context.saveDigest = digest => digests.push(digest);
  c.context.buildArticle = it => it;
  c.context.decideImpact = () => 'mid';
  c.context.saveArticleIfNew = article => articles.push(article);
  c.context.morningDigest();
  assert.equal(articles.length, 3);
  assert.equal(digests[0].count, 180);
  assert(digests[0].title.includes('今日の3本'));
  assert(messages[0].includes('会社0(1234)'));
  assert(messages[0].includes('市況') && messages[0].includes('予定'));
  assert(!messages[0].includes('未来会社'));
  const prompt = JSON.parse(c.requests[0].options.payload).contents[0].parts[0].text;
  assert.equal((prompt.match(/自己株式取得/g) || []).length, 3);
});

t('Discord既定OFF: 投稿・診断・疎通でネットワークを呼ばない', () => {
  const c = aiContext([]);
  vm.runInContext(fs.readFileSync(path.join(gasDir, 'Verify.gs'), 'utf8'), c.context);
  assert.strictEqual(c.context.postDiscord('test'), false);
  assert(c.context.diagnoseDiscord().includes('スキップ'));
  assert(c.context.smokeTestDiscord().includes('スキップ'));
  assert.strictEqual(c.requests.length, 0);
  assert(!c.context.checkSecrets().includes('DISCORD_WEBHOOK_URL(未設定・必須)'));
});
t('Discord有効化時は既存の送信経路を維持', () => {
  const c = aiContext([[204, '']]);
  vm.runInContext('CONFIG.DISCORD_ENABLED = true', c.context);
  c.context.PropertiesService.getScriptProperties = () => ({ getProperty: () => 'https://discord.com/api/webhooks/test' });
  assert.strictEqual(c.context.postDiscord('test'), true);
  assert.strictEqual(c.requests.length, 1);
});

t('決算予定: 社名補完・時価総額降順・重複除去・欠損除外', () => {
  const label = buildEarningsOverview([{ code: '1000' }, { code: '2000', company: '大型社' }, { code: '3000' }, { code: '2000', company: '大型社' }], { '1000': '小型社' }, { '1000': 100, '2000': 900, '3000': null });
  assert(label.indexOf('大型社(2000)') < label.indexOf('小型社(1000)'));
  assert(label.includes('ほか1社') && label.includes('未取得1社'));
});

t('大量保有: 微小増減・ゼロ差・欠損は通常、1ポイント以上と新規5%は注目', () => {
  for (const detail of [{ ratio: 18.75, prevRatio: 18.43 }, { ratio: 6, prevRatio: 6 }, { ratio: 6, prevRatio: null }, { ratio: null, prevRatio: 6 }]) assert.equal(holdingImpact(detail, false, false), 'low');
  for (const detail of [{ ratio: 6, prevRatio: 5 }, { ratio: 5, prevRatio: 6 }, { ratio: 5.1, prevRatio: 4.9 }]) assert.equal(holdingImpact(detail, false, false), 'mid');
  assert.equal(holdingImpact({ ratio: 5.1 }, false, true), 'mid');
  assert.equal(holdingImpact({}, true, false), 'high');
});
t('大量保有比較fixture: 注目6→3、インパクト大1→1', () => {
  const fixture = [
    [{ ratio: 18.75, prevRatio: 18.43 }, false, false],
    [{ ratio: 6, prevRatio: 6 }, false, false],
    [{ ratio: 6 }, false, false],
    [{ ratio: 6, prevRatio: 5 }, false, false],
    [{ ratio: 5, prevRatio: 7 }, false, false],
    [{ ratio: 5.1 }, false, true],
    [{ ratio: 6, prevRatio: 6 }, true, false],
  ];
  const values = fixture.map(args => holdingImpact(...args));
  assert.equal(values.filter(v => v === 'mid').length, 3);
  assert.equal(values.filter(v => v === 'high').length, 1);
});

t('検索とウォッチ: 全角コード・社名・カテゴリ併用・優先順・入力非破壊', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const source = html.split('/* WATCH_LOGIC_START: DOMから独立した検索・保存ロジック */')[1].split('/* WATCH_LOGIC_END */')[0];
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const items = [{code:'1000',company:'会社A',cat:'earnings'}, {code:'200A',company:'会社B',cat:'holding'}];
  assert.equal(context.filterStockItems(items, '２００Ａ', [], false, 'all')[0].code, '200A');
  assert.equal(context.filterStockItems(items, '会社A', [], false, 'all').length, 1);
  assert.equal(context.filterStockItems(items, '', [{code:'200A'}], false, 'all')[0].code, '200A');
  assert.equal(context.filterStockItems(items, '', [{code:'200A'}], true, 'earnings').length, 0);
  assert.equal(items[0].code, '1000');
  assert.equal(context.readWatchlist({getItem:()=>'{bad'}).length, 0);
  assert.equal(context.readWatchlist({getItem:()=>JSON.stringify([{code:'２００Ａ'}, {code:'200A'}, {code:'<bad>'}])}).length, 1);
  assert.equal(context.writeWatchlist({setItem:()=>{throw new Error('quota');}}, []), false);
});

t('Webスクリプトの構文、免責フッター、旧朝刊データの互換', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  assert(html.includes('<footer>') && html.includes('</footer>'));
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(gasDir, 'Store.gs'), 'utf8'), context);
  context.getSheet = () => ({getLastRow:()=>2, getRange:()=>({getValues:()=>[[0,'日付','見出し','本文',180,'[]','[]','[]']]})});
  assert.equal(context.getLatestDigest().more.length, 0);
});
t('APIはlowをmidへ変換しない', () => {
  const context = vm.createContext({fmtYmd:()=> '2026-11-13'});
  vm.runInContext(fs.readFileSync(path.join(gasDir, 'Api.gs'), 'utf8'), context);
  assert.equal(context.toApiItem({date:'2026-11-13',time:'10:00',impact:'low'}).impact, 'low');
});

console.log('--- Gemini無料枠の共通管理 ---');
const daily429 = JSON.stringify({error:{message:'quota exceeded',details:[{violations:[{quotaId:'GenerateRequestsPerDayPerProjectPerModel-FreeTier'}]},{retryDelay:'11551s'}]}});
t('日次429は1回で終了し、PDF/場中/朝刊/診断の後続もPTリセットまで無通信', () => {
  const c = aiContext([[429,daily429],[200,aiOk]]);
  assert.equal(c.context.callAi('入力','一覧','morning'), '一覧');
  for (const purpose of ['pdf','intraday','morning','diagnostic']) assert.equal(c.context.requestGemini({},purpose), null);
  assert.equal(c.context.extractRevision('https://example.com/file.pdf'), null);
  assert.equal(c.requests.length, 1);
  assert.equal(c.sleeps.length, 0);
  assert.equal(c.context.geminiUsageStatus().dailyBlocked, true);
  // JSTの深夜をまたいでも、PTの同じ日なら解除しない。
  c.setTime('2026-11-13T16:59:59+09:00');
  assert.equal(c.context.requestGemini({},'intraday'), null);
  c.setTime('2026-11-13T17:00:00+09:00');
  assert.equal(c.context.requestGemini({},'intraday'), '解説\n続き');
  assert.equal(c.context.geminiUsageStatus().used, 1);
});
t('PDFと場中が17回使っても、朝刊用3枠は残る。診断も予約枠を使えない', () => {
  const c = aiContext(Array.from({length:20},()=>[200,aiOk]));
  vm.runInContext('CONFIG.GEMINI_DIAGNOSTIC_GENERATE = true', c.context);
  for (let n=0;n<17;n++) assert(c.context.requestGemini({},n<4 ? 'pdf':'intraday'));
  assert.equal(c.context.requestGemini({},'diagnostic'), null);
  for (let n=0;n<3;n++) assert(c.context.requestGemini({},'morning'));
  assert.equal(c.context.requestGemini({},'morning'), null);
  assert.equal(c.requests.length,20);
  const state = c.context.geminiUsageStatus();
  assert.equal(state.optionalUsed,17); assert.equal(state.used,20);
});
t('PTリセット後の夜間手動朝刊でも、翌朝用の予約枠を奪わない', () => {
  const c = aiContext(Array.from({length:20},()=>[200,aiOk]));
  c.setTime('2026-11-13T20:00:00+09:00');
  for(let n=0;n<17;n++) assert(c.context.requestGemini({},'morning'));
  assert.equal(c.context.requestGemini({},'morning'), null);
  c.setTime('2026-11-14T08:30:00+09:00');
  assert(c.context.requestGemini({},'morning'));
});
t('短時間429はRetryInfo/Retry-Afterを尊重し、日次枠を永久停止しない', () => {
  const body = JSON.stringify({error:{message:'requests per minute exceeded',details:[{retryDelay:'120s'}]}});
  const c = aiContext([[429,body,{'Retry-After':'180'}],[200,aiOk]]);
  assert.equal(c.context.requestGemini({},'morning'),null);
  assert.equal(c.context.requestGemini({},'intraday'),null);
  assert.equal(c.requests.length,1);
  assert.equal(c.context.geminiUsageStatus().dailyBlocked,false);
  c.setTime('2026-11-13T08:33:01+09:00');
  assert(c.context.requestGemini({},'morning'));
});
t('共有間隔: 場中は待たず縮退、朝刊だけ上限内で待機し送信', () => {
  const c = aiContext([[200,aiOk],[200,aiOk]]);
  vm.runInContext('CONFIG.GEMINI_MIN_INTERVAL_MS = 15000', c.context);
  assert(c.context.requestGemini({},'intraday'));
  assert.equal(c.context.requestGemini({},'pdf'),null);
  assert(c.context.requestGemini({},'morning'));
  assert.deepEqual(c.sleeps,[15000]); assert.equal(c.requests.length,2);
});
t('ロック不可・破損台帳は無通信、同時予約は最後の1枠を二重利用しない', () => {
  const c = aiContext([]);
  c.lock.available=false;
  assert.equal(c.context.requestGemini({},'morning'),null);
  c.lock.available=true;
  c.props.set('GEMINI_USAGE_V1','bad');
  assert.equal(c.context.requestGemini({},'morning'),null);
  c.props.set('GEMINI_USAGE_V1',JSON.stringify({day:'2026-11-12',used:19,optionalUsed:17}));
  assert.equal(c.context.reserveGeminiCall('morning').allowed,true);
  assert.equal(c.context.reserveGeminiCall('morning').allowed,false);
  assert.equal(c.requests.length,0);
});
t('成功キャッシュ: 同じ朝刊/PDFは生成枠を消費せず、別日・別モデルは分離', () => {
  const c = aiContext([[200,aiOk],[200,aiOk],[200,aiOk]]);
  assert(c.context.requestGemini({},'morning','same-disclosures'));
  assert(c.context.requestGemini({},'morning','same-disclosures'));
  assert.equal(c.requests.length,1);
  c.props.set('GEMINI_MODEL','another-model');
  assert(c.context.requestGemini({},'morning','same-disclosures'));
  assert.equal(c.requests.length,2);
  c.setTime('2026-11-14T08:30:00+09:00');
  assert(c.context.requestGemini({},'morning','same-disclosures'));
  assert.equal(c.requests.length,3);
});
t('太平洋時間の夏時間: 夏はJST16時、冬は17時に日次枠切替', () => {
  const c = aiContext([]);
  for(const [before,after] of [['2026-07-14T15:59:59+09:00','2026-07-14T16:00:00+09:00'],['2026-11-13T16:59:59+09:00','2026-11-13T17:00:00+09:00']]){
    c.setTime(before); const first = c.context.geminiUsageStatus().day;
    c.setTime(after); assert.notEqual(c.context.geminiUsageStatus().day,first);
  }
});
t('診断は既定で生成しない。生成呼び出しの迂回経路がない', () => {
  const c = aiContext([]);
  vm.runInContext(fs.readFileSync(path.join(gasDir,'Diagnose.gs'),'utf8'),c.context);
  c.context.diagnoseGemini(); c.context.diagnoseGeminiGenerate();
  assert.equal(c.requests.length,0);
  for(const file of fs.readdirSync(gasDir).filter(name=>name.endsWith('.gs') && name !== 'Gemini.gs')){
    assert(!fs.readFileSync(path.join(gasDir,file),'utf8').includes(':generateContent'),file);
  }
});

t('PDF専用上限で止めても場中と朝刊は利用でき、用途別の試行数が残る', () => {
  const c = aiContext(Array.from({length:6},()=>[200,aiOk]));
  for(let n=0;n<4;n++) assert(c.context.requestGemini({},'pdf'));
  assert.equal(c.context.extractRevision('https://example.com/file.pdf'),null);
  assert(c.context.requestGemini({},'intraday'));
  assert(c.context.requestGemini({},'morning'));
  assert.equal(c.context.geminiUsageStatus().byPurpose.pdf,4);
  assert.equal(c.requests.length,6);
});
t('リセット境界をまたいだ古い日次429は翌日の枠を止めない', () => {
  const c = aiContext([]);
  const ticket = c.context.reserveGeminiCall('morning');
  c.setTime('2026-11-13T17:00:00+09:00');
  c.context.recordGeminiRateLimit({daily:true,waitMs:3600000},ticket.day);
  assert.equal(c.context.geminiUsageStatus().dailyBlocked,false);
  assert.equal(c.context.reserveGeminiCall('intraday').allowed,true);
});
t('PDFの実経路も共通台帳・ヘッダー認証を使い、成功後はPDF取得ごとキャッシュ', () => {
  const c = aiContext([]);
  const urls = [];
  c.context.UrlFetchApp.fetch = (url, options) => {
    urls.push(url);
    if(url === 'https://example.com/file.pdf') return {getBlob:()=>({getBytes:()=>[1,2,3]})};
    assert.equal(options.headers['x-goog-api-key'],'test-secret');
    assert(!url.includes('key='));
    return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({is_revision:true,op_old:100,op_new:120})}]}}]})};
  };
  assert.equal(c.context.extractRevision('https://example.com/file.pdf').pct,20);
  assert.equal(c.context.extractRevision('https://example.com/file.pdf').pct,20);
  assert.equal(urls.length,2); // PDFと生成を各1回のみ
  assert.equal(c.context.geminiUsageStatus().byPurpose.pdf,1);
});
t('診断・トランスポート失敗を含め20件上限以上は送信しない', () => {
  const c = aiContext(Array.from({length:30},()=>new Error('network')));
  vm.runInContext('CONFIG.GEMINI_DIAGNOSTIC_GENERATE = true', c.context);
  for(let n=0;n<20;n++) c.context.requestGemini({},'diagnostic');
  assert.equal(c.requests.length,17);
  c.context.requestGemini({},'morning');
  c.context.requestGemini({},'morning');
  assert.equal(c.requests.length,20);
  assert.equal(c.context.geminiUsageStatus().used,20);
});

t('朝刊ではPDF解析よりAI本文を優先し、既定では生成1回だけ', () => {
  const c = aiContext([[200,aiOk]]);
  let pdfCalls=0, saved;
  c.context.fetchTdnet=()=>[{id:'one',company:'会社',code:'1234',title:'業績予想の上方修正',pubdate:new Date('2026-11-12T16:00:00+09:00'),url:'https://example.com/file.pdf'}];
  c.context.extractRevision=()=>{pdfCalls++;return null;};
  c.context.getMarketBrief=()=>({}); c.context.buildMarketLines=()=>[];
  c.context.getTodayEvents=()=>[]; c.context.answerCheck=()=>[];
  c.context.saveDigest=value=>{saved=value;}; c.context.postDiscord=()=>false;
  c.context.buildArticle=it=>it; c.context.decideImpact=()=> 'mid'; c.context.saveArticleIfNew=()=>{};
  c.context.morningDigest();
  assert.equal(pdfCalls,0); assert.equal(c.requests.length,1);
  assert.equal(saved.body,'解説\n続き');
  assert.equal(c.context.geminiUsageStatus().byPurpose.morning,1);
});
t('日本時間0時をまたいでも日次超過ブロックは解除しない', () => {
  const c = aiContext([[429,daily429]]);
  c.setTime('2026-11-13T23:59:00+09:00');
  c.context.requestGemini({},'intraday');
  c.setTime('2026-11-14T00:01:00+09:00');
  assert.equal(c.context.requestGemini({},'morning'),null);
  assert.equal(c.requests.length,1);
  assert.equal(c.context.geminiUsageStatus().dailyBlocked,true);
});
t('全GASファイルの構文を検証', () => {
  for(const file of fs.readdirSync(gasDir).filter(name=>name.endsWith('.gs'))){
    new vm.Script(fs.readFileSync(path.join(gasDir,file),'utf8'),{filename:file});
  }
});

t('ロックサービス自体の例外でも生成せず、呼び出し元の一覧フォールバックを返す', () => {
  const c = aiContext([]);
  c.context.LockService.getScriptLock = () => { throw new Error('lock service unavailable'); };
  assert.equal(c.context.callAi('入力','一覧','morning'),'一覧');
  assert.equal(c.context.extractRevision('https://example.com/file.pdf'),null);
  assert.equal(c.requests.length,0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
