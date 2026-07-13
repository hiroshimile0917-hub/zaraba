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
const src = ['Code.gs', 'Analyze.gs', 'Market.gs', 'Edinet.gs', 'CalendarEvents.gs', 'JQuants.gs', 'TradingCalendar.gs']
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
