/**
 * Diagnose.gs — Gemini / J-Quants の失敗原因診断
 * GASに新規ファイル「Diagnose」として追加し、
 * diagnoseGemini() と diagnoseJQuants() をそれぞれ実行してログを確認。
 */

/** Gemini失敗の切り分け: キー無効 / API無効 / モデル名廃止 を判定 */
function diagnoseGemini() {
  const out = [];
  const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');

  if (!key) { Logger.log('❌ GEMINI_API_KEY が未設定'); return; }
  out.push(`✅ キー設定あり(長さ${key.length}文字 / 先頭${key.slice(0, 4)}…)`);
  if (key.trim() !== key) out.push('⚠ キーの前後に空白/改行あり → 貼り直し推奨');
  if (!/^AIza/.test(key.trim())) out.push('⚠ 通常キーは「AIza」で始まります。別の文字列を貼っていないか確認');

  // 1) 利用可能モデル一覧(キーの有効性チェックを兼ねる)
  try {
    const res = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key.trim()),
      { muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code === 200) {
      const models = (JSON.parse(res.getContentText()).models || [])
        .map(m => String(m.name).replace('models/', ''))
        .filter(n => n.includes('flash') || n.includes('gemini'));
      out.push('✅ キー有効。利用可能モデル(抜粋): ' + models.slice(0, 10).join(', '));
      out.push(models.includes(CONFIG.GEMINI_MODEL)
        ? `✅ 設定中のモデル「${CONFIG.GEMINI_MODEL}」は利用可能`
        : `❌ 設定中のモデル「${CONFIG.GEMINI_MODEL}」が一覧にない → Code.gs の CONFIG.GEMINI_MODEL を上の一覧のflash系に変更`);
    } else {
      out.push(`❌ モデル一覧取得失敗 HTTP ${code}`);
      out.push('   body=' + res.getContentText().slice(0, 300));
      if (code === 400 || code === 403) out.push('   → キーが無効。AI Studio (aistudio.google.com) でキーを再発行して貼り直し');
      if (code === 429) out.push('   → 無料枠のレート制限。数分待って再実行');
    }
  } catch (e) { out.push('❌ 例外: ' + e); }

  // 2) 実際の生成テスト(エラー本文を表示)
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${key.trim()}`;
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ contents: [{ parts: [{ text: 'テストと返して' }] }] }),
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    out.push(code === 200
      ? '✅ 生成テスト成功: ' + JSON.parse(res.getContentText()).candidates[0].content.parts[0].text.trim().slice(0, 30)
      : `❌ 生成テスト失敗 HTTP ${code}\n   body=` + res.getContentText().slice(0, 400));
  } catch (e) { out.push('❌ 生成テスト例外: ' + e); }

  Logger.log(out.join('\n'));
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
