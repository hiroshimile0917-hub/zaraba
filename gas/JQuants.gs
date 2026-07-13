/**
 * JQuants.gs — J-Quants API V2(スタンダードプラン)
 *
 * 認証: APIキー方式(x-api-keyヘッダー・有効期限なし)
 *   J-Quantsダッシュボード(jpx-jquants.com)でAPIキーを発行し、
 *   スクリプトプロパティ JQUANTS_API_KEY に設定する。Googleログインのままで利用可能。
 *
 * 互換レイヤー: 呼び出し側(Market.gs / CalendarEvents.gs / TradingCalendar.gs / SmokeTest.gs)は
 *   V1時代のパス・フィールド名のまま動くよう、jqGet() 内でV2へ変換する。
 *
 * 未設定の場合、各機能は従来のフォールバック(Yahoo/stooq/JPX Excel)で動作する。
 */

const JQ_V2_BASE = 'https://api.jquants.com/v2';

// V1パス → V2パスの対応表
const JQ_PATH_MAP = {
  '/prices/daily_quotes':            '/equities/bars/daily',
  '/listed/info':                    '/equities/master',
  '/fins/statements':                '/fins/summary',
  '/fins/announcement':              '/equities/earnings-calendar',
  '/markets/weekly_margin_interest': '/markets/margin-interest',
  '/markets/short_selling_positions':'/markets/short-sale-report',
  '/markets/trading_calendar':       '/markets/calendar',
  '/indices/topix':                  '/indices/bars/daily/topix',
  '/markets/trades_spec':            '/equities/investor-types',
};

/** APIキー取得。互換のため jqIdToken() も同じものを返す(truthy判定用) */
function jqApiKey() {
  const k = (PropertiesService.getScriptProperties().getProperty('JQUANTS_API_KEY') || '').trim();
  return k || null;
}
function jqIdToken() { return jqApiKey(); } // 旧コード互換

/**
 * 認証付きGET(V1パスを受けてV2に変換、ページネーション対応、レスポンスをV1風に整形)
 * @return {Object|null}
 */
function jqGet(path, params) {
  const key = jqApiKey();
  if (!key) return null;
  const v2path = JQ_PATH_MAP[path] || path;
  try {
    const p = {};
    for (const k in (params || {})) {
      if (params[k] == null || params[k] === '') continue;
      // V1時代のパラメータ名の読み替え
      const name = (k === 'disclosed_date_from') ? 'from' : k;
      p[name] = params[k];
    }
    const qs = Object.keys(p).map(k => `${k}=${encodeURIComponent(p[k])}`).join('&');
    let url = `${JQ_V2_BASE}${v2path}${qs ? '?' + qs : ''}`;
    let rows = [];
    let lastCode = null;
    for (let i = 0; i < 5; i++) { // 最大5ページ
      const res = UrlFetchApp.fetch(url, {
        headers: { 'x-api-key': key }, muteHttpExceptions: true,
      });
      lastCode = res.getResponseCode();
      if (lastCode !== 200) {
        if (i === 0) Logger.log(`jqGet ${v2path} HTTP ${lastCode}: ` + res.getContentText().slice(0, 200));
        break;
      }
      const j = JSON.parse(res.getContentText());
      rows = rows.concat(jqExtractRows(j));
      if (!j.pagination_key) break;
      url = `${JQ_V2_BASE}${v2path}?${qs ? qs + '&' : ''}pagination_key=${encodeURIComponent(j.pagination_key)}`;
    }
    if (lastCode !== 200 && rows.length === 0) return null;
    return jqShapeAsV1(path, rows);
  } catch (e) {
    Logger.log('jqGet error: ' + e);
    return null;
  }
}

/** レスポンスからデータ配列を取り出す("data"キー優先、無ければ最初の配列) */
function jqExtractRows(j) {
  if (Array.isArray(j.data)) return j.data;
  for (const k in j) if (Array.isArray(j[k])) return j[k];
  return [];
}

/** V2の行データをV1風のレスポンス形に整形(呼び出し側の互換維持) */
function jqShapeAsV1(v1path, rows) {
  switch (v1path) {
    case '/prices/daily_quotes':
      return { daily_quotes: rows.map(r => ({
        Date: r.Date || r.D,
        Close: firstNum(r, ['C', 'Close']),
        AdjustmentClose: firstNum(r, ['AdjC', 'AdjustmentClose', 'AdjClose']),
      })) };
    case '/fins/statements':
      return { statements: rows };
    case '/fins/announcement':
      return { announcement: rows.map(r => ({
        Date: r.Date || r.AnnouncementDate || r.D,
        Code: r.Code || r.LocalCode || '',
        CompanyName: firstStr(r, [/company.*name/i, /^name$/i, /会社/]),
      })) };
    case '/markets/weekly_margin_interest':
      return { weekly_margin_interest: rows.map(r => ({
        Date: r.Date || r.D,
        LongMarginTradeVolume: firstByPattern(r, [/long.*(margin)?.*vol/i, /^long/i]),
        ShortMarginTradeVolume: firstByPattern(r, [/short.*(margin)?.*vol/i, /^short(?!.*sell)/i]),
      })) };
    case '/markets/short_selling_positions':
      return { short_selling_positions: rows.map(r => ({
        DisclosedDate: firstStr(r, [/disclosed.*date/i]) || r.Date || r.D,
        CalculatedDate: firstStr(r, [/calculated.*date/i]) || '',
        ShortSellerName: firstStr(r, [/seller.*name/i, /name/i]) || '',
        ShortPositionsToSharesOutstandingRatio: firstByPattern(r, [/ratio/i]),
      })) };
    case '/markets/trading_calendar':
      return { trading_calendar: rows.map(r => ({
        Date: r.Date || r.D,
        HolidayDivision: String(firstByPattern(r, [/division/i, /holiday/i]) != null
          ? firstByPattern(r, [/division/i, /holiday/i]) : '1'),
      })) };
    case '/indices/topix':
      return { topix: rows.map(r => ({
        Date: r.Date || r.D,
        Close: firstNum(r, ['C', 'Close']),
      })) };
    case '/markets/trades_spec':
      return { trades_spec: rows };
    default:
      return { data: rows };
  }
}

// ---------- フィールド探索ヘルパー(V2のフィールド名変動に強くする) ----------

function firstNum(row, keys) {
  for (const k of keys) {
    if (row[k] != null && row[k] !== '') { const n = Number(row[k]); if (isFinite(n)) return n; }
  }
  return null;
}
function firstByPattern(row, patterns) {
  for (const pat of patterns) {
    for (const k in row) {
      if (pat.test(k) && row[k] != null && row[k] !== '') {
        const n = Number(row[k]); if (isFinite(n)) return n;
      }
    }
  }
  return null;
}
function firstStr(row, patterns) {
  for (const pat of patterns) {
    for (const k in row) {
      if (pat.test(k) && row[k] != null && String(row[k]).trim() !== '') return String(row[k]);
    }
  }
  return null;
}

/** 4桁コード → 5桁コード(V2は4桁も可だが普通株限定のため5桁で統一) */
function jqCode(code4) { return String(code4) + '0'; }

// ---------- 日足株価 ----------

/** 直近の日足終値(調整後)を新しい順で @return {Array<{date,close,rawClose}>|null} */
function jqDailyCloses(code, days) {
  const to = new Date();
  const from = new Date(to.getTime() - (days + 12) * 86400000);
  const j = jqGet('/prices/daily_quotes', {
    code: jqCode(code), from: fmtYmd(from), to: fmtYmd(to),
  });
  if (!j || !Array.isArray(j.daily_quotes)) return null;
  return jqClosesFromResponse(j);
}

/** レスポンス→[{date, close}] 新しい順(純粋関数・テスト対象) */
function jqClosesFromResponse(j) {
  const out = [];
  for (const q of (j.daily_quotes || [])) {
    const close = (q.AdjustmentClose != null) ? q.AdjustmentClose : q.Close;
    if (close == null) continue;
    out.push({ date: q.Date, close: Number(close), rawClose: q.Close != null ? Number(q.Close) : null });
  }
  out.sort((a, b) => a.date < b.date ? 1 : -1);
  return out.length ? out : null;
}

// ---------- 時価総額(株価×発行済株式数) ----------

/** @return {number|null} 億円 */
function jqMarketCapOku(code) {
  const st = jqGet('/fins/statements', { code: jqCode(code) });
  const shares = jqPickShares(st);
  if (!shares) return null;
  const closes = jqDailyCloses(code, 7);
  if (!closes || !closes.length) return null;
  const price = closes[0].rawClose != null ? closes[0].rawClose : closes[0].close;
  return Math.round(price * shares / 1e8); // 円→億円
}

/** 財務情報から株式数を推定(V2 fins/summary対応・テスト対象)
 *  優先順: ①発行済株式数系フィールド ②AvgSh(平均株式数) ③Eq(自己資本)÷BPS(1株純資産) */
function jqPickShares(st) {
  if (!st || !Array.isArray(st.statements)) return null;
  const dateOf = r => r.DiscDate || r.DisclosedDate || r.Date || r.D || '';
  const rows = st.statements.slice().sort((a, b) => dateOf(a) < dateOf(b) ? 1 : -1);
  for (const r of rows) {
    // ① 明示的な発行済株式数フィールド(将来の追加に備えて残す)
    for (const k in r) {
      if (/issued/i.test(k) && /share/i.test(k)) {
        const n = Number(r[k]);
        if (isFinite(n) && n > 1e5) return n;
      }
    }
    // ② 平均株式数(期中平均・自己株控除後。時価総額の概算には十分)
    const avg = Number(r.AvgSh);
    if (isFinite(avg) && avg > 1e5) return avg;
    // ③ 自己資本 ÷ 1株純資産 = 株式数
    const eq = Number(r.Eq), bps = Number(r.BPS);
    if (isFinite(eq) && isFinite(bps) && eq > 0 && bps > 0) {
      const n = eq / bps;
      if (n > 1e5 && n < 1e12) return n;
    }
  }
  return null;
}

// ---------- 決算発表予定 ----------

/** 指定日の決算発表予定 @return {Array<{code,company}>|null} nullはJ-Quants利用不可 */
function jqAnnouncementByDate(ymd) {
  const j = jqGet('/fins/announcement', { from: ymd, to: ymd });
  if (!j || !Array.isArray(j.announcement)) return null;
  return j.announcement
    .filter(a => (a.Date || '').slice(0, 10) === ymd)
    .map(a => ({ code: String(a.Code || '').slice(0, 4), company: a.CompanyName || '' }));
}

// ---------- 信用残(週末残高) ----------

/** 直近の信用取引週末残高 @return {Object|null} */
function jqWeeklyMargin(code) {
  const from = new Date(Date.now() - 40 * 86400000);
  const j = jqGet('/markets/weekly_margin_interest', {
    code: jqCode(code), from: fmtYmd(from),
  });
  if (!j || !Array.isArray(j.weekly_margin_interest) || !j.weekly_margin_interest.length) return null;
  const rows = j.weekly_margin_interest.slice().sort((a, b) => a.Date < b.Date ? 1 : -1);
  const r = rows[0], prev = rows[1] || null;
  if (r.LongMarginTradeVolume == null && r.ShortMarginTradeVolume == null) return null;
  return {
    date: r.Date,
    long: Number(r.LongMarginTradeVolume) || 0,
    short: Number(r.ShortMarginTradeVolume) || 0,
    longPrev: prev ? Number(prev.LongMarginTradeVolume) || 0 : null,
    shortPrev: prev ? Number(prev.ShortMarginTradeVolume) || 0 : null,
  };
}

// ---------- 空売り残高報告(残高割合0.5%以上) ----------

/** 直近の空売り残高報告(提出者別・最新のみ) @return {Array|null} */
function jqShortPositions(code) {
  const from = new Date(Date.now() - 30 * 86400000);
  const j = jqGet('/markets/short_selling_positions', {
    code: jqCode(code), from: fmtYmd(from),
  });
  if (!j || !Array.isArray(j.short_selling_positions)) return null;
  const byName = {};
  for (const r of j.short_selling_positions) {
    const name = r.ShortSellerName || '';
    if (!name) continue;
    if (!byName[name] || byName[name].DisclosedDate < r.DisclosedDate) byName[name] = r;
  }
  return Object.values(byName)
    .map(r => {
      let ratio = Number(r.ShortPositionsToSharesOutstandingRatio);
      if (!isFinite(ratio)) return null;
      if (ratio <= 1) ratio = ratio * 100; // 比率表記(0.0123)なら%へ
      return { name: r.ShortSellerName, ratio: Math.round(ratio * 100) / 100, date: r.DisclosedDate };
    })
    .filter(Boolean)
    .filter(r => r.ratio > 0)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 5);
}

/** 銘柄ページ用の追加データ(J-Quants未設定ならnull) */
function jqStockExtras(code) {
  if (!jqApiKey()) return null;
  const out = {};
  try { out.margin = jqWeeklyMargin(code); } catch (e) { out.margin = null; }
  try { out.shortPositions = jqShortPositions(code); } catch (e) { out.shortPositions = null; }
  try { out.capOku = getMarketCapOku(code); } catch (e) { out.capOku = null; }
  return out;
}

// ---------- 診断 ----------

/** V2 APIキーの疎通診断(実行ログに結果を出す) */
function diagnoseJQuantsV2() {
  const out = [];
  const key = jqApiKey();
  if (!key) {
    Logger.log('❌ JQUANTS_API_KEY が未設定。ダッシュボード(jpx-jquants.com)でAPIキーを発行し、\n' +
      'プロジェクトの設定 → スクリプトプロパティ に JQUANTS_API_KEY として追加してください。');
    return;
  }
  out.push(`✅ APIキー設定あり(長さ${key.length}文字 / 末尾…${key.slice(-4)})`);
  try {
    const res = UrlFetchApp.fetch(`${JQ_V2_BASE}/equities/bars/daily?code=72030&from=${fmtYmd(new Date(Date.now() - 10 * 86400000))}`, {
      headers: { 'x-api-key': key }, muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 200) {
      const j = JSON.parse(res.getContentText());
      const rows = jqExtractRows(j);
      out.push(`✅ V2疎通成功: 7203の日足${rows.length}件取得`);
      if (rows.length) out.push('   サンプル行のキー: ' + Object.keys(rows[0]).join(', '));
      out.push('   → smokeTest() を再実行してJ-Quants全項目を確認してください');
    } else {
      out.push(`❌ HTTP ${code}: ` + res.getContentText().slice(0, 300));
      if (code === 401 || code === 403) out.push('   → キーが無効。ダッシュボードで再発行して貼り直し');
      if (code === 429) out.push('   → レート制限。少し待って再実行');
    }
  } catch (e) { out.push('❌ 例外: ' + e); }
  Logger.log(out.join('\n'));
}
