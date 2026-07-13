/**
 * DiagnoseShares.gs — 時価総額計算失敗の調査用(GASに新規ファイルとして追加)
 * diagnoseJQShares() を実行し、ログ全文を貼ってください。
 */
function diagnoseJQShares() {
  const out = [];
  const key = jqApiKey();
  if (!key) { Logger.log('❌ JQUANTS_API_KEY 未設定'); return; }

  const res = UrlFetchApp.fetch('https://api.jquants.com/v2/fins/summary?code=72030', {
    headers: { 'x-api-key': key }, muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  out.push(`fins/summary HTTP ${code}`);
  if (code !== 200) {
    out.push('body=' + res.getContentText().slice(0, 400));
    Logger.log(out.join('\n')); return;
  }
  const j = JSON.parse(res.getContentText());
  const rows = Array.isArray(j.data) ? j.data : (Object.values(j).find(v => Array.isArray(v)) || []);
  out.push(`行数: ${rows.length}`);
  if (!rows.length) { Logger.log(out.join('\n')); return; }

  const last = rows[rows.length - 1];
  out.push('--- 最終行の全フィールド名 ---');
  out.push(Object.keys(last).join(', '));
  out.push('--- 株式数・自己株らしきフィールドと値 ---');
  for (const k in last) {
    if (/share|issued|stock|treasury/i.test(k)) out.push(`${k} = ${last[k]}`);
  }
  Logger.log(out.join('\n'));
}
