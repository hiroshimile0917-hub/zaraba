/**
 * Diagnose.gs — Gemini / J-Quants の失敗原因診断
 * GASに新規ファイル「Diagnose」として追加し、
 * diagnoseGemini() と diagnoseJQuants() をそれぞれ実行してログを確認。
 */

/** Gemini失敗の切り分け: キー無効 / API無効 / モデル名廃止 を判定 */
function diagnoseGemini() {
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  Logger.log(key ? 'Geminiキー設定あり（値は非表示）' : 'Geminiキー未設定');
  Logger.log('Gemini model=' + geminiModel());
  geminiUsageStatus(); // 生成を消費しない診断を既定とする
}

/** 明示的に設定を有効化した場合だけ、場中と同じ残枠で生成テスト。 */
function diagnoseGeminiGenerate() {
  Logger.log(callAi('テストと返して', '生成テストはスキップまたは失敗', 'diagnostic'));
}

/** J-Quants認証失敗の切り分け: 資格情報誤り / 形式問題 を判定 */
function diagnoseJQuants() {
  const out = [];
  const props = PropertiesService.getScriptProperties();
  const mail = props.getProperty('JQUANTS_MAIL');
  const pass = props.getProperty('JQUANTS_PASSWORD');

  if (!mail || !pass) { Logger.log('❌ JQUANTS_MAIL / JQUANTS_PASSWORD が未設定'); return; }
  out.push(`✅ メール設定あり: ${mail.replace(/(.{3}).+(@.+)/, '$1***$2')}`);
  out.push(`✅ パスワード設定あり(長さ${pass.length}文字)`);
  if (mail.trim() !== mail || pass.trim() !== pass) out.push('⚠ 前後に空白/改行あり → .envを修正して applySecrets をやり直し');
  if (/^["'].*["']$/.test(pass)) out.push('⚠ パスワードがクォートで囲まれている → クォートを外す');

  // 古いトークンキャッシュを破棄して再認証
  props.deleteProperty('JQ_ID_TOKEN'); props.deleteProperty('JQ_ID_TOKEN_EXP');
  props.deleteProperty('JQ_REFRESH_TOKEN'); props.deleteProperty('JQ_REFRESH_TOKEN_EXP');

  try {
    const res = UrlFetchApp.fetch('https://api.jquants.com/v1/token/auth_user', {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ mailaddress: mail.trim(), password: pass.trim() }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code === 200) {
      out.push('✅ 認証成功(refreshToken取得OK)');
      // idTokenまで確認
      const token = jqIdToken();
      out.push(token ? '✅ idToken取得OK → J-Quants全機能が使えます。smokeTest() を再実行してください'
                     : '❌ idToken交換に失敗(一時的な可能性。数分後に再実行)');
    } else {
      out.push(`❌ 認証失敗 HTTP ${code}`);
      out.push('   body=' + res.getContentText().slice(0, 300));
      if (code === 400 || code === 403) {
        out.push('   → メールまたはパスワードが違います。');
        out.push('   → jpx-jquants.com にブラウザでログインできるか確認し、その資格情報を.envに設定');
        out.push('   → Googleアカウント連携で登録した場合はパスワード認証不可のことあり。その場合はパスワードを設定/再設定する');
      }
    }
  } catch (e) { out.push('❌ 例外: ' + e); }

  Logger.log(out.join('\n'));
}
