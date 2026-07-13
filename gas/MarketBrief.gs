/**
 * MarketBrief.gs — マーケット概況(朝刊用)
 * 前夜の米国市場・為替・前日の日本市場・投資部門別売買動向を無料ソースで取得。
 * ソース: Yahoo chart API(キー不要) → stooq(フォールバック) / J-Quants(TOPIX・投資部門別)
 * 取得できない項目は黙ってスキップ(朝刊は止めない)。
 */

// 表示する指標: [ラベル, Yahooシンボル, stooqシンボル, 小数桁]
const MARKET_SYMBOLS = [
  ['S&P500',        '^GSPC',  '^spx',   0],
  ['ナスダック',     '^IXIC',  '^ndq',   0],
  ['ドル円',         'JPY=X',  'usdjpy', 1],
  ['日経平均(前日)', '^N225',  '^nkx',   0],
  ['日経先物(CME)',  'NIY=F',  null,     0],
];

/** マーケット概況を取得 @return {Object} { items:[{label,last,pct}], investors } */
function getMarketBrief() {
  const brief = { items: [], investors: null };

  for (const [label, ySym, sSym, dec] of MARKET_SYMBOLS) {
    let q = null;
    try { q = yahooLastTwo(ySym); } catch (e) { q = null; }
    if (!q && sSym) { try { q = stooqLastTwo(sSym); } catch (e) { q = null; } }
    if (q) brief.items.push({ label: label, last: q.last, pct: q.pct, dec: dec });
  }

  // TOPIX(J-Quants)
  try {
    const j = jqGet('/indices/topix', { from: fmtYmd(new Date(Date.now() - 10 * 86400000)) });
    const rows = j && (j.topix || []);
    if (rows && rows.length >= 2) {
      const sorted = rows.slice().sort((a, b) => a.Date < b.Date ? 1 : -1);
      const last = Number(sorted[0].Close), prev = Number(sorted[1].Close);
      if (isFinite(last) && isFinite(prev) && prev > 0) {
        brief.items.push({ label: 'TOPIX(前日)', last: last, pct: (last - prev) / prev * 100, dec: 0 });
      }
    }
  } catch (e) { /* skip */ }

  // 投資部門別(外国人・週次)
  try {
    const j = jqGet('/markets/trades_spec', { from: fmtYmd(new Date(Date.now() - 70 * 86400000)) });
    brief.investors = parseInvestorRows(j && j.trades_spec);
  } catch (e) { brief.investors = null; }

  return brief;
}

/** Yahoo chart APIで直近2営業日の終値 @return {{last,pct}|null} */
function yahooLastTwo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=10d&interval=1d`;
  const res = UrlFetchApp.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const r = JSON.parse(res.getContentText()).chart;
  const q = r && r.result && r.result[0];
  if (!q) return null;
  const closes = ((q.indicators.quote[0] || {}).close || []).filter(c => c != null);
  if (closes.length < 2) return null;
  const last = closes[closes.length - 1], prev = closes[closes.length - 2];
  return { last: last, pct: (last - prev) / prev * 100 };
}

/** stooqで直近2営業日の終値 */
function stooqLastTwo(sym) {
  const d2 = new Date(), d1 = new Date(Date.now() - 20 * 86400000);
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&d1=${fmtYmdCompact(d1)}&d2=${fmtYmdCompact(d2)}&i=d`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return null;
  const rows = parseStooqCsv(res.getContentText()); // 新しい順
  if (!rows || rows.length < 2) return null;
  return { last: rows[0].close, pct: (rows[0].close - rows[1].close) / rows[1].close * 100 };
}

/**
 * 投資部門別売買動向から外国人の動向を要約(純粋関数・テスト対象)
 * 金額の単位がプランにより異なる可能性があるため、方向と連続週数のみを返す
 * @return {{net:'buy'|'sell', weeks:number, endDate:string}|null}
 */
function parseInvestorRows(rows) {
  if (!rows || !Array.isArray(rows) || rows.length === 0) return null;
  // 外国人のネット金額フィールドをパターン探索
  const balKey = Object.keys(rows[0]).find(k => /foreign/i.test(k) && /balance|net/i.test(k));
  let getNet;
  if (balKey) {
    getNet = r => Number(r[balKey]);
  } else {
    const buyKey = Object.keys(rows[0]).find(k => /foreign/i.test(k) && /purchase|buy/i.test(k));
    const sellKey = Object.keys(rows[0]).find(k => /foreign/i.test(k) && /sale|sell/i.test(k));
    if (!buyKey || !sellKey) return null;
    getNet = r => Number(r[buyKey]) - Number(r[sellKey]);
  }
  const dateKey = Object.keys(rows[0]).find(k => /end.*date/i.test(k)) ||
                  Object.keys(rows[0]).find(k => /date/i.test(k));
  if (!dateKey) return null;

  // 週ごとに合算(市場区分が複数行に分かれる場合に対応)
  const byWeek = {};
  for (const r of rows) {
    const d = String(r[dateKey]).slice(0, 10);
    const n = getNet(r);
    if (!isFinite(n)) continue;
    byWeek[d] = (byWeek[d] || 0) + n;
  }
  const weeks = Object.keys(byWeek).sort().reverse();
  if (!weeks.length) return null;

  const latestNet = byWeek[weeks[0]];
  const dir = latestNet >= 0 ? 'buy' : 'sell';
  let streak = 0;
  for (const w of weeks) {
    if ((byWeek[w] >= 0 ? 'buy' : 'sell') === dir) streak++;
    else break;
  }
  return { net: dir, weeks: streak, endDate: weeks[0] };
}

/** Discord/プロンプト用のテキスト行(純粋関数・テスト対象) */
function buildMarketLines(brief) {
  const lines = [];
  for (const it of (brief.items || [])) {
    const sign = it.pct >= 0 ? '+' : '';
    const val = Number(it.last).toLocaleString('ja-JP', {
      minimumFractionDigits: it.dec, maximumFractionDigits: it.dec });
    lines.push(`${it.label} ${val}(${sign}${it.pct.toFixed(1)}%)`);
  }
  const inv = brief.investors;
  if (inv) {
    const dir = inv.net === 'buy' ? '買い越し' : '売り越し';
    lines.push(`外国人投資家 ${inv.weeks}週連続${dir}(〜${inv.endDate})`);
  }
  return lines;
}
