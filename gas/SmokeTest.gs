/**
 * SmokeTest.gs — 全データソースの一括疎通テスト
 * GASエディタに新規ファイル「SmokeTest」として追加し、smokeTest() を実行。
 * (Verify.gsのDiscord診断とは独立。関数名の重複なし)
 */

function smokeTest() {
  const results = [];
  const ok = (name, detail) => results.push(`✅ ${name}${detail ? ' — ' + detail : ''}`);
  const ng = (name, detail) => results.push(`❌ ${name}${detail ? ' — ' + detail : ''}`);
  const skip = (name, detail) => results.push(`⏭ ${name}${detail ? ' — ' + detail : ''}`);
  const props = PropertiesService.getScriptProperties();

  // 1. スクリプトプロパティ
  ['DISCORD_WEBHOOK_URL', 'GEMINI_API_KEY'].forEach(k => {
    props.getProperty(k) ? ok(`プロパティ ${k}`) : ng(`プロパティ ${k}`, '未設定(必須)');
  });
  ['EDINET_API_KEY', 'JQUANTS_MAIL', 'JQUANTS_PASSWORD', 'CRON_TOKEN'].forEach(k => {
    props.getProperty(k) ? ok(`プロパティ ${k}`) : skip(`プロパティ ${k}`, '未設定(任意/該当機能はスキップ)');
  });

  // 2. TDnet(Yanoshin)
  try {
    const items = fetchTdnet(5);
    items.length > 0 && items[0].title && items[0].pubdate instanceof Date && !isNaN(items[0].pubdate)
      ? ok('TDnet取得', `${items.length}件 / 例:「${items[0].company}(${items[0].code}) ${String(items[0].title).slice(0, 25)}…」`)
      : ng('TDnet取得', '0件またはフィールド不整合');
  } catch (e) { ng('TDnet取得', String(e)); }

  // 3. Gemini
  try {
    const r = callAi('「テスト」と3文字だけ返してください。');
    r && !r.includes('失敗') ? ok('Gemini応答', r.slice(0, 20)) : ng('Gemini応答', r);
  } catch (e) { ng('Gemini応答', String(e)); }

  // 4. スプレッドシート
  try {
    const ss = getSs();
    getSheet('articles'); getSheet('digests'); getSheet('caps'); getSheet('earnings');
    ok('スプレッドシート', ss.getName() + ' / ' + ss.getUrl());
  } catch (e) { ng('スプレッドシート', String(e)); }

  // 5. J-Quants
  if (props.getProperty('JQUANTS_MAIL')) {
    try {
      const token = jqIdToken();
      if (!token) ng('J-Quants認証', 'idToken取得失敗(メール/パスワードを確認)');
      else {
        ok('J-Quants認証');
        const closes = jqDailyCloses('7203', 5);
        closes && closes.length
          ? ok('J-Quants日足(7203)', `${closes[0].date} 終値${closes[0].close}`)
          : ng('J-Quants日足(7203)', 'daily_quotes空(データ更新は夕方以降)');
        const cap = jqMarketCapOku('7203');
        cap ? ok('J-Quants時価総額(7203)', `約${cap.toLocaleString()}億円`) : ng('J-Quants時価総額(7203)', '計算失敗');
        const margin = jqWeeklyMargin('7203');
        margin ? ok('J-Quants信用残(7203)', `${margin.date} 買残${margin.long}`) : skip('J-Quants信用残(7203)', '取得できず(プラン範囲を確認)');
        const sp = jqShortPositions('7203');
        sp !== null ? ok('J-Quants空売り残高(7203)', `${sp.length}件`) : skip('J-Quants空売り残高(7203)', '取得できず(プラン範囲外なら自動非表示で運用)');
        const ann = jqAnnouncementByDate(fmtYmd(new Date()));
        ann !== null ? ok('J-Quants決算発表予定', `本日${ann.length}件`) : skip('J-Quants決算発表予定', '取得できず');
      }
    } catch (e) { ng('J-Quants', String(e)); }
  } else skip('J-Quants', '未設定');

  // 6. EDINET
  if (props.getProperty('EDINET_API_KEY')) {
    try {
      const key = props.getProperty('EDINET_API_KEY');
      const url = `https://api.edinet-fsa.go.jp/api/v2/documents.json?date=${fmtYmd(new Date())}&type=2&Subscription-Key=${key}`;
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() === 200) {
        const j = JSON.parse(res.getContentText());
        const n = (j.results || []).length;
        const lvh = (j.results || []).filter(d => d.docTypeCode === '350' || d.docTypeCode === '360').length;
        ok('EDINET一覧', `本日${n}件(うち大量保有系${lvh}件)`);
      } else ng('EDINET一覧', `HTTP ${res.getResponseCode()}(401/403ならキー無効)`);
    } catch (e) { ng('EDINET', String(e)); }
  } else skip('EDINET', 'キー未設定');

  // 7. 株価フォールバック(stooq)
  try {
    const rows = fetchStooqDaily('7203', 7);
    rows && rows.length ? ok('stooq日足(フォールバック)', `${rows[0].date} 終値${rows[0].close}`)
                        : skip('stooq日足(フォールバック)', '取得できず(J-Quantsが動けば問題なし)');
  } catch (e) { skip('stooq', String(e)); }

  // 8. 取引カレンダー(祝日判定)
  try {
    const biz = isBusinessDayJP(new Date());
    ok('営業日判定', `本日=${biz ? '営業日' : '休場'}`);
  } catch (e) { ng('営業日判定', String(e)); }

  // 9. 業績修正PDF抽出(直近の実開示でテスト)
  try {
    const revs = fetchTdnet(100).filter(it => isRevisionTitle(it.title) && it.url);
    if (revs.length === 0) skip('PDF修正率抽出', '直近100件に業績修正なし(後日 testExtract() で確認可)');
    else {
      const rev = extractRevision(revs[0].url);
      rev && rev.text ? ok('PDF修正率抽出', `${revs[0].company}: ${rev.text}`)
                      : skip('PDF修正率抽出', '抽出null→キーワード判定にフォールバック');
    }
  } catch (e) { ng('PDF修正率抽出', String(e)); }

  Logger.log('\n===== スモークテスト結果 =====\n' + results.join('\n'));
  return results.join('\n');
}

/** 直近の業績修正1件でPDF抽出だけを試す */
function testExtract() {
  const revs = fetchTdnet(200).filter(it => isRevisionTitle(it.title) && it.url);
  if (!revs.length) { Logger.log('直近200件に業績修正なし'); return; }
  const it = revs[0];
  Logger.log(`対象: ${it.company}(${it.code}) ${it.title}\n${it.url}`);
  const rev = extractRevision(it.url);
  Logger.log(rev ? JSON.stringify(rev, null, 2) : '抽出できず(キーワード判定にフォールバック)');
}
