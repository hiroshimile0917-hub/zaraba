/**
 * Market.gs — 時価総額・株価(すべて無料ソース)
 *
 * 時価総額: Yahoo Finance(非公式quote API・cookie+crumb方式)。
 *   - 開示があった銘柄のみオンデマンド取得し、capsシートに7日キャッシュ。
 *   - 取得失敗時は null を返し、フィルタはフェイルオープン(アラートを止めない)。
 * 日足株価: stooq.com のCSV(無料・キー不要)。失敗時は Yahoo chart API にフォールバック。
 */

// ---------- 時価総額 ----------

/** @return {number|null} 時価総額(億円)。不明なら null
 *  優先: J-Quants(公式) → Yahoo(非公式フォールバック) → 古いキャッシュ */
function getMarketCapOku(code) {
  if (!/^\d{4}$/.test(String(code))) return null; // 4桁数字以外(ETF等の英字入り)は対象外
  const cached = capCacheGet(code);
  if (cached && cached.fresh) return cached.capOku;
  let cap = null;
  try { cap = jqMarketCapOku(code); } catch (e) { cap = null; }
  if (cap == null) cap = fetchYahooMarketCapOku(code);
  if (cap != null) {
    capCachePut(code, cap);
    return cap;
  }
  return cached ? cached.capOku : null; // 古いキャッシュでも無いよりまし
}

function fetchYahooMarketCapOku(code) {
  try {
    // 1) cookie取得
    const r1 = UrlFetchApp.fetch('https://fc.yahoo.com', { muteHttpExceptions: true, followRedirects: false });
    const setCookie = (r1.getAllHeaders()['Set-Cookie'] || '');
    const cookie = Array.isArray(setCookie) ? setCookie.map(c => c.split(';')[0]).join('; ') : String(setCookie).split(';')[0];
    if (!cookie) return null;
    const headers = { 'Cookie': cookie, 'User-Agent': 'Mozilla/5.0' };

    // 2) crumb取得
    const r2 = UrlFetchApp.fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', { headers: headers, muteHttpExceptions: true });
    if (r2.getResponseCode() !== 200) return null;
    const crumb = r2.getContentText().trim();
    if (!crumb || crumb.includes('{')) return null;

    // 3) quote取得
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${code}.T&fields=marketCap&crumb=${encodeURIComponent(crumb)}`;
    const r3 = UrlFetchApp.fetch(url, { headers: headers, muteHttpExceptions: true });
    if (r3.getResponseCode() !== 200) return null;
    const q = JSON.parse(r3.getContentText());
    const cap = q.quoteResponse && q.quoteResponse.result && q.quoteResponse.result[0] &&
                q.quoteResponse.result[0].marketCap;
    if (!cap) return null;
    return Math.round(cap / 1e8); // 円 → 億円
  } catch (e) {
    Logger.log('yahoo cap error: ' + e);
    return null;
  }
}

// ---------- 日足株価(stooq → Yahooフォールバック) ----------

/**
 * 直近の日足終値を新しい順で返す
 * 優先: J-Quants(公式) → stooq → Yahoo chart
 * @return {Array<{date:string(yyyy-MM-dd), close:number}>}
 */
function getDailyCloses(code, days) {
  let rows = null;
  try { rows = jqDailyCloses(code, days); } catch (e) { rows = null; }
  if (!rows || rows.length === 0) rows = fetchStooqDaily(code, days);
  if (!rows || rows.length === 0) rows = fetchYahooChartDaily(code, days);
  return rows || [];
}

function fetchStooqDaily(code, days) {
  try {
    const d2 = new Date();
    const d1 = new Date(d2.getTime() - (days + 10) * 86400000);
    const url = `https://stooq.com/q/d/l/?s=${code}.jp&d1=${fmtYmdCompact(d1)}&d2=${fmtYmdCompact(d2)}&i=d`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    return parseStooqCsv(res.getContentText());
  } catch (e) {
    return null;
  }
}

/** stooq CSV → [{date, close}] 新しい順(純粋関数・テスト対象) */
function parseStooqCsv(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  if (lines.length < 2 || !/^Date,/i.test(lines[0])) return null;
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 5) continue;
    const close = Number(c[4]);
    if (!isFinite(close)) continue;
    out.push({ date: c[0], close: close });
  }
  return out.reverse();
}

function fetchYahooChartDaily(code, days) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}.T?range=1mo&interval=1d`;
    const res = UrlFetchApp.fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const j = JSON.parse(res.getContentText());
    const r = j.chart && j.chart.result && j.chart.result[0];
    if (!r) return null;
    const ts = r.timestamp || [];
    const closes = (r.indicators.quote[0] || {}).close || [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      if (closes[i] == null) continue;
      out.push({ date: fmtYmd(new Date(ts[i] * 1000)), close: closes[i] });
    }
    return out.reverse().slice(0, days + 5);
  } catch (e) {
    return null;
  }
}

// ---------- 昨日の答え合わせ ----------

/**
 * 前営業日が「反応日」だったインパクト大銘柄の騰落率を返す
 * 反応日 = 場中開示なら当日、引け後開示なら翌営業日
 */
function answerCheck(now) {
  try {
    const reactionYmd = fmtYmd(prevBusinessDayJP(now));
    // 反応日に開示された大 + 反応日前営業日の15時以降に開示された大
    const dayBefore = fmtYmd(prevBusinessDayJP(prevBusinessDayJP(now)));
    const cands = [];
    for (const a of getHighImpactByDate(reactionYmd)) {
      if (timeToMin(a.time) < 15 * 60) cands.push(a); // 場中開示 → 当日反応
    }
    for (const a of getHighImpactByDate(dayBefore)) {
      if (timeToMin(a.time) >= 15 * 60) cands.push(a); // 引け後開示 → 翌営業日反応
    }
    // 同一銘柄は1件に
    const seen = new Set();
    const uniq = cands.filter(a => !seen.has(a.code) && seen.add(a.code)).slice(0, 8);

    return uniq.map(a => {
      const closes = getDailyCloses(a.code, 10);
      const idx = closes.findIndex(r => r.date === reactionYmd);
      let pct = null, note = '';
      if (idx !== -1 && idx + 1 < closes.length) {
        pct = ((closes[idx].close - closes[idx + 1].close) / closes[idx + 1].close) * 100;
        pct = Math.round(pct * 10) / 10;
      } else {
        note = '(株価データ未反映)';
      }
      return { code: a.code, company: a.company, title: a.title, pct: pct, note: note };
    });
  } catch (e) {
    Logger.log('answerCheck error: ' + e);
    return [];
  }
}

// ---------- 日付ユーティリティ ----------
// 営業日判定(土日+祝日)は TradingCalendar.gs の prevBusinessDayJP / isBusinessDayJP を使う

function timeToMin(hhmm) {
  const m = String(hhmm).match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
}

function fmtYmdCompact(d) { return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyyMMdd'); }
