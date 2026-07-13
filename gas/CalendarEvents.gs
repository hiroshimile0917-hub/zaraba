/**
 * CalendarEvents.gs — イベントカレンダー(本日の予定)
 * - 日銀会合・FOMC・米CPI: 静的データ(年1回、公表され次第更新する運用)
 * - SQ日: 毎月第2金曜を計算で導出(3/6/9/12月はメジャーSQ)
 * - 決算発表予定: JPXの決算発表予定Excelを週次で取り込み(Drive APIの
 *   高度なサービスが必要。未設定なら自動スキップ)
 *
 * 出典: 日銀公表「2026年の金融政策決定会合等の日程」/ FRB FOMCカレンダー / BLS CPIスケジュール
 */

// 日銀金融政策決定会合(2026年・結果発表は2日目)。◎=展望レポート公表回
const BOJ_MEETINGS_2026 = [
  { end: '2026-01-23', outlook: true },
  { end: '2026-03-19', outlook: false },
  { end: '2026-04-28', outlook: true },
  { end: '2026-06-16', outlook: false },
  { end: '2026-07-31', outlook: true },
  { end: '2026-09-18', outlook: false },
  { end: '2026-10-30', outlook: true },
  { end: '2026-12-18', outlook: false },
];

// FOMC(2026年・現地2日目。日本時間は翌未明に結果発表)
const FOMC_MEETINGS_2026 = [
  '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17',
  '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09',
];

// 米CPI発表日(2026年・現地8:30 → 日本時間21:30/22:30)
const US_CPI_2026 = [
  '2026-01-13', '2026-02-13', '2026-03-11', '2026-04-10',
  '2026-05-12', '2026-06-10', '2026-07-14', '2026-08-12',
  '2026-09-11', '2026-10-14', '2026-11-10', '2026-12-10',
];

/** 本日のイベント一覧 @return {Array<{type,label}>} */
function getTodayEvents(now) {
  const ymd = fmtYmd(now);
  const events = [];

  // 日銀
  for (const m of BOJ_MEETINGS_2026) {
    if (m.end === ymd) events.push({ type: 'boj', label: `日銀金融政策決定会合 結果発表${m.outlook ? '(展望レポート公表)' : ''}` });
    const start = new Date(m.end); start.setDate(start.getDate() - 1);
    if (fmtYmd(start) === ymd) events.push({ type: 'boj', label: '日銀金融政策決定会合(1日目)' });
  }

  // SQ
  const sq = sqDateOfMonth(now.getFullYear(), now.getMonth() + 1);
  if (sq === ymd) {
    const major = [3, 6, 9, 12].includes(now.getMonth() + 1);
    events.push({ type: 'sq', label: major ? 'メジャーSQ(先物・オプション同時清算)' : 'オプションSQ' });
  }

  // FOMC(現地2日目=日本時間翌未明に結果)
  for (const d of FOMC_MEETINGS_2026) {
    if (d === ymd) events.push({ type: 'fomc', label: 'FOMC結果発表(日本時間 翌未明)' });
  }

  // 米CPI
  for (const d of US_CPI_2026) {
    if (d === ymd) events.push({ type: 'cpi', label: '米消費者物価指数(CPI)発表(日本時間 今夜)' });
  }

  // 決算発表予定(J-Quants優先、なければJPX Excel週次取り込み分)
  let earnings = null;
  try { earnings = jqAnnouncementByDate(ymd); } catch (e) { earnings = null; }
  if (earnings == null) earnings = earningsByDate(ymd);
  if (earnings.length > 0) {
    const names = earnings.slice(0, 8).map(e => `${e.company}(${e.code})`).join('、');
    const more = earnings.length > 8 ? ` ほか${earnings.length - 8}社` : '';
    events.push({ type: 'earnings', label: `決算発表: ${names}${more}` });
  }

  return events;
}

/** その月のSQ日(第2金曜)を yyyy-MM-dd で返す(純粋関数・テスト対象) */
function sqDateOfMonth(year, month) {
  const first = new Date(year, month - 1, 1);
  const dow = first.getDay(); // 0=日
  const firstFriday = 1 + ((5 - dow) + 7) % 7;
  const secondFriday = firstFriday + 7;
  const mm = String(month).padStart(2, '0');
  const dd = String(secondFriday).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

// ---------- 決算発表予定(JPX・週次) ----------

/**
 * JPXの「決算発表予定日」Excelを取得して earnings シートに保存。
 * 高度なサービス「Drive API」(v2) の有効化が必要。未有効ならスキップ。
 */
function updateEarningsSchedule() {
  if (typeof Drive === 'undefined') {
    Logger.log('Drive API(高度なサービス)が未有効のため決算予定の取り込みをスキップ');
    return;
  }
  // JPXページからxlsxリンクを探す
  const page = UrlFetchApp.fetch(
    'https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html',
    { muteHttpExceptions: true }).getContentText();
  const m = page.match(/href="([^"]+\.xlsx)"/);
  if (!m) { Logger.log('JPX xlsxリンクが見つかりません'); return; }
  const xlsxUrl = m[1].startsWith('http') ? m[1] : 'https://www.jpx.co.jp' + m[1];

  const blob = UrlFetchApp.fetch(xlsxUrl, { muteHttpExceptions: true }).getBlob();

  // xlsx → Googleスプレッドシートに変換して読む
  const file = Drive.Files.insert(
    { title: 'zaraba_earnings_tmp', mimeType: MimeType.GOOGLE_SHEETS },
    blob, { convert: true });
  try {
    const ss = SpreadsheetApp.openById(file.id);
    const sh = ss.getSheets()[0];
    const values = sh.getDataRange().getValues();
    const rows = [];
    for (const r of values) {
      // 形式: [発表予定日, コード, 会社名, ...] 前後にヘッダ行があるため日付+4桁コードの行のみ採用
      const dateCell = r.find(c => c instanceof Date);
      const codeCell = r.map(String).find(c => /^\d{4}$/.test(c.trim()));
      const nameCell = r.map(String).find(c => /[ぁ-んァ-ヶ一-龠A-Za-z]{2,}/.test(c) && !/^\d+$/.test(c));
      if (dateCell && codeCell) {
        rows.push({ date: fmtYmd(dateCell), code: codeCell.trim(), company: (nameCell || '').trim() });
      }
    }
    if (rows.length > 0) earningsReplaceAll(rows);
    Logger.log(`決算予定 ${rows.length}件を取り込み`);
  } finally {
    Drive.Files.remove(file.id); // 一時ファイル削除
  }
}
