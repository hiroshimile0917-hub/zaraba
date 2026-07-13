/**
 * Store.gs — スプレッドシート永続化
 * シート構成(自動生成):
 *   articles : 配信記事(タイムライン)
 *   digests  : 朝刊ダイジェスト
 *   caps     : 時価総額キャッシュ
 *   earnings : 決算発表予定(週次更新)
 */

const SHEETS = {
  articles: ['ts', 'date', 'time', 'code', 'company', 'title', 'cat', 'impact',
             'summary', 'url', 'source', 'revText', 'revPct', 'revDetail', 'capOku', 'filtered', 'id'],
  digests:  ['ts', 'date', 'title', 'body', 'count', 'eventsJson', 'answersJson', 'marketJson'],
  caps:     ['code', 'capOku', 'updated'],
  earnings: ['date', 'code', 'company'],
};

function getSs() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* 作り直す */ }
  }
  const ss = SpreadsheetApp.create('ザラバDB');
  props.setProperty('SHEET_ID', ss.getId());
  return ss;
}

function getSheet(name) {
  const ss = getSs();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(SHEETS[name]);
    sh.setFrozenRows(1);
  }
  return sh;
}

// ---------- 記事 ----------

function saveArticleIfNew(a) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const sh = getSheet('articles');
    // 既存ID重複チェック(直近300行のみ走査で軽量化)
    const last = sh.getLastRow();
    if (last > 1) {
      const from = Math.max(2, last - 300);
      const ids = sh.getRange(from, 17, last - from + 1, 1).getValues().flat();
      if (ids.indexOf(a.id) !== -1) return false;
    }
    sh.appendRow([
      a.pubdate, fmtYmd(a.pubdate), fmtTime(a.pubdate), "'" + a.code, a.company, a.title,
      a.cat, a.impact, a.summary, a.url, a.source,
      a.revision ? a.revision.text : '', a.revision && a.revision.pct != null ? a.revision.pct : '',
      a.revision ? a.revision.detail : '',
      a.capOku != null ? a.capOku : '', a.filtered ? 1 : '', a.id,
    ]);
    return true;
  } finally {
    lock.releaseLock();
  }
}

/** 直近n件(新しい順) */
function getRecentArticles(n) {
  const sh = getSheet('articles');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const from = Math.max(2, last - n + 1);
  const rows = sh.getRange(from, 1, last - from + 1, SHEETS.articles.length).getValues();
  return rows.map(rowToArticle).reverse();
}

/** 指定コードの記事(新しい順、最大200) */
function getArticlesByCode(code) {
  const sh = getSheet('articles');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, SHEETS.articles.length).getValues();
  return rows.filter(r => String(r[3]).replace(/^'/, '') === String(code))
             .map(rowToArticle).reverse().slice(0, 200);
}

/** 指定日にインパクト大だった記事 */
function getHighImpactByDate(ymd) {
  const sh = getSheet('articles');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const from = Math.max(2, last - 500);
  const rows = sh.getRange(from, 1, last - from + 1, SHEETS.articles.length).getValues();
  return rows.filter(r => normYmd(r[1]) === ymd && r[7] === 'high').map(rowToArticle);
}

function rowToArticle(r) {
  return {
    ts: r[0], date: normYmd(r[1]), time: normHm(r[2]),
    code: String(r[3]).replace(/^'/, ''), company: r[4], title: r[5],
    cat: r[6], impact: r[7], summary: r[8], url: r[9], source: r[10],
    revText: r[11], revPct: r[12] === '' ? null : Number(r[12]), revDetail: r[13],
    capOku: r[14] === '' ? null : Number(r[14]), filtered: !!r[15], id: r[16],
  };
}

/** シートが日付/時刻をDate型に自動変換した場合に文字列へ正規化 */
function normYmd(v) { return (v instanceof Date) ? fmtYmd(v) : String(v || ''); }
function normHm(v)  { return (v instanceof Date) ? fmtTime(v) : String(v || ''); }

// ---------- ダイジェスト ----------

function saveDigest(d) {
  const sh = getSheet('digests');
  sh.appendRow([new Date(), d.date, d.title, d.body, d.count,
                JSON.stringify(d.events || []), JSON.stringify(d.answers || []),
                JSON.stringify(d.marketLines || [])]);
}

function getLatestDigest() {
  const sh = getSheet('digests');
  const last = sh.getLastRow();
  if (last < 2) return null;
  const r = sh.getRange(last, 1, 1, SHEETS.digests.length).getValues()[0];
  return {
    date: r[1], title: r[2], body: r[3], count: r[4],
    events: safeParse(r[5], []), answers: safeParse(r[6], []),
    marketLines: safeParse(r[7], []),
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch (e) { return fallback; }
}

// ---------- 時価総額キャッシュ ----------

function capCacheGet(code) {
  const sh = getSheet('caps');
  const last = sh.getLastRow();
  if (last < 2) return null;
  const rows = sh.getRange(2, 1, last - 1, 3).getValues();
  for (const r of rows) {
    if (String(r[0]).replace(/^'/, '') === String(code)) {
      const age = (Date.now() - new Date(r[2]).getTime()) / 86400000;
      if (age <= CONFIG.CAP_CACHE_DAYS) return { capOku: Number(r[1]), fresh: true };
      return { capOku: Number(r[1]), fresh: false, row: rows.indexOf(r) + 2 };
    }
  }
  return null;
}

function capCachePut(code, capOku) {
  const sh = getSheet('caps');
  const last = sh.getLastRow();
  if (last > 1) {
    const codes = sh.getRange(2, 1, last - 1, 1).getValues().flat();
    const idx = codes.findIndex(c => String(c).replace(/^'/, '') === String(code));
    if (idx !== -1) {
      sh.getRange(idx + 2, 2, 1, 2).setValues([[capOku, new Date()]]);
      return;
    }
  }
  sh.appendRow(["'" + code, capOku, new Date()]);
}

// ---------- 決算発表予定 ----------

function earningsReplaceAll(rows) {
  const sh = getSheet('earnings');
  sh.clearContents();
  sh.appendRow(SHEETS.earnings);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 3).setValues(rows.map(r => [r.date, "'" + r.code, r.company]));
  }
}

function earningsByDate(ymd) {
  const sh = getSheet('earnings');
  const last = sh.getLastRow();
  if (last < 2) return [];
  const rows = sh.getRange(2, 1, last - 1, 3).getValues();
  return rows.filter(r => {
    const d = (r[0] instanceof Date) ? fmtYmd(r[0]) : String(r[0]);
    return d === ymd;
  }).map(r => ({ code: String(r[1]).replace(/^'/, ''), company: r[2] }));
}
