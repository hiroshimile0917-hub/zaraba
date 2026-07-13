/**
 * Api.gs — Web API(doGet)
 * デプロイ: 「ウェブアプリ」として公開(アクセス: 全員)。URLを index.html の API_URL に設定。
 *
 * エンドポイント:
 *   GET ?                → { digest, items }         ホーム用(最新朝刊+直近速報60件)
 *   GET ?code=6501       → { code, company, items }  銘柄ページ用
 *   GET ?action=morning&token=XXX  → 朝刊を実行(cron-job.org用。CRON_TOKEN必須)
 *   GET ?action=patrol&token=XXX   → 巡回を実行(同上)
 */

function doGet(e) {
  const p = (e && e.parameter) || {};

  // --- cron-job.org 等の外部キック(時刻精度が必要な場合) ---
  if (p.action) {
    const token = PropertiesService.getScriptProperties().getProperty('CRON_TOKEN');
    if (!token || p.token !== token) return jsonOut({ error: 'unauthorized' });
    if (p.action === 'morning') { morningDigest(); return jsonOut({ ok: 'morning' }); }
    if (p.action === 'patrol')  { patrol();        return jsonOut({ ok: 'patrol' }); }
    return jsonOut({ error: 'unknown action' });
  }

  // --- 銘柄ページ ---
  if (p.code) {
    const code = String(p.code).replace(/[^0-9A-Z]/g, '').slice(0, 5);
    const items = getArticlesByCode(code);
    let extras = null;
    try { extras = jqStockExtras(code); } catch (e) { extras = null; }
    return jsonOut({
      code: code,
      company: items.length ? items[0].company : '',
      items: items.map(toApiItem),
      extras: extras, // {capOku, margin:{date,long,short,longPrev,shortPrev}, shortPositions:[{name,ratio,date}]}
    });
  }

  // --- ホーム ---
  const digest = getLatestDigest();
  const items = getRecentArticles(60).filter(a => !a.filtered || a.impact === 'high');
  return jsonOut({
    digest: digest ? {
      date: digest.date, title: digest.title, body: digest.body,
      count: digest.count, events: digest.events, answers: digest.answers,
    } : null,
    items: items.map(toApiItem),
    generated: new Date().toISOString(),
  });
}

function toApiItem(a) {
  const today = fmtYmd(new Date());
  return {
    time: a.date === today ? a.time : a.date.slice(5).replace('-', '/') + ' ' + a.time,
    date: a.date,
    code: a.code,
    company: a.company,
    impact: a.impact === 'low' ? 'mid' : a.impact, // フロントはhigh/midの2段階表示
    cat: a.cat,
    title: a.title,
    summary: a.summary,
    url: a.url,
    source: a.source,
    revText: a.revText || '',
    revPct: a.revPct,
    revDetail: a.revDetail || '',
  };
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
