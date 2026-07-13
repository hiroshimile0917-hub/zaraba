/**
 * Verify.gs — 疎通・切り分けツール(手動実行用)
 *
 * GASエディタで対象関数を選んで実行し、実行ログ(表示 > ログ / Ctrl+Enter)で結果を確認する。
 * いずれも配信本体には影響しない読み取り/単発送信のみ。
 *
 *   diagnoseDiscord()  … Discord通知が届かない原因を切り分ける(メッセージは送らない)
 *   smokeTestDiscord() … テストメッセージを1通だけ送って送信可否を確認する
 *
 * ※ smokeTest() / testExtract() は各ソース(TDnet/EDINET/Gemini等)の疎通確認用。
 *   本タスク(Discord切り分け)の範囲外のため未実装。必要になったら追加する。
 */

// ============ シークレット反映確認 ============

/**
 * スクリプトプロパティに必要なシークレットが反映されているか確認する。
 * ★値そのものは出力しない(設定有無と長さのみ)。ログを貼っても安全。
 * @return {string}
 */
function checkSecrets() {
  const P = PropertiesService.getScriptProperties();
  const required = ['DISCORD_WEBHOOK_URL', 'GEMINI_API_KEY'];
  const optional = ['EDINET_API_KEY', 'JQUANTS_MAIL', 'JQUANTS_PASSWORD', 'CRON_TOKEN'];
  const log = ['— シークレット反映状況(値は非表示)—'];
  const line = (k, req) => {
    const v = P.getProperty(k);
    const mark = v ? '✅' : (req ? '❌' : '⏭');
    log.push(mark + ' ' + k + (v ? '(設定済み ' + v.length + '文字)' : (req ? '(未設定・必須)' : '(未設定・任意)')));
  };
  required.forEach(k => line(k, true));
  optional.forEach(k => line(k, false));
  const missing = required.filter(k => !P.getProperty(k));
  if (missing.length) {
    log.push('→ 必須が未設定: ' + missing.join(', '));
    log.push('  SetupLocal.gs の applySecrets() 実行漏れ、または .env の値が空のまま変換した可能性。');
  } else {
    log.push('→ 必須はすべて設定済み。Discordが届かない場合は diagnoseDiscord() へ。');
  }
  return _emit(log);
}

// ============ Discord 切り分け ============

/**
 * Discord通知が届かない原因を切り分ける。
 * 判定する失敗モード: ①プロパティ未反映 ②URL形式 ③Webhook無効 ④別チャンネル
 * メッセージは送信せず、GET でWebhookのメタ情報(宛先チャンネル)まで確認する。
 * @return {string} 判定結果(実行ログにも出力)
 */
function diagnoseDiscord() {
  const log = [];
  const P = PropertiesService.getScriptProperties();
  const url = P.getProperty('DISCORD_WEBHOOK_URL');

  // ① プロパティ未反映
  if (!url) {
    log.push('❌ [①未反映] スクリプトプロパティ DISCORD_WEBHOOK_URL が未設定です。');
    log.push('   → SetupLocal.gs の applySecrets() を実行したか、');
    log.push('     [プロジェクトの設定 > スクリプトプロパティ] に DISCORD_WEBHOOK_URL があるか確認。');
    return _emit(log);
  }
  log.push('✅ [①] プロパティ設定済み(' + url.length + '文字)');

  // ② URL形式
  const trimmed = url.trim();
  if (trimmed !== url) {
    log.push('⚠️ [②形式] URLの前後に空白/改行が混入しています(コピペ由来とみられる)。');
    log.push('   → プロパティを trim して再保存すると確実。以降は trim 済みで検証します。');
  }
  const m = trimmed.match(
    /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/(\d+)\/([\w-]+)$/
  );
  if (!m) {
    log.push('❌ [②形式] Discord Webhook URL の形式に一致しません。');
    log.push('   期待: https://discord.com/api/webhooks/{id}/{token}');
    log.push('   実際(マスク): ' + _maskWebhook(trimmed));
    log.push('   → よくある誤り: チャンネルURLを貼っている / 「/api/webhooks/」が抜けている。');
    return _emit(log);
  }
  log.push('✅ [②] URL形式OK(id=' + m[1] + ', token=' + m[2].slice(0, 4) + '…' + m[2].slice(-2) + ')');

  // ③④ Webhookの有効性 + 宛先チャンネル(GET。メッセージは送らない)
  try {
    const res = UrlFetchApp.fetch(trimmed, { method: 'get', muteHttpExceptions: true });
    const code = res.getResponseCode();
    const body = res.getContentText();
    log.push('— GET応答: HTTP ' + code);

    if (code === 200) {
      let meta = {};
      try { meta = JSON.parse(body); } catch (e) {}
      log.push('✅ [③] Webhookは有効です。');
      log.push('✅ [④宛先] name="' + (meta.name || '?') + '"');
      log.push('          channel_id=' + (meta.channel_id || '?'));
      log.push('          guild_id=' + (meta.guild_id || '?'));
      log.push('   → この channel_id が「自分が見ているチャンネル」と一致するか確認。');
      log.push('     不一致なら③④は正常で、別チャンネルに投稿されているだけ(=見る場所が違う)。');
      log.push('   → 疎通の最終確認は smokeTestDiscord() を実行。');
    } else if (code === 401 || code === 403) {
      log.push('❌ [③無効] 認証エラー(' + code + ')。token が誤り/失効しています。');
      log.push('   → Discord側でWebhookを作り直し、新URLを再設定してください。');
    } else if (code === 404) {
      log.push('❌ [③無効] 404 Not Found。Webhookが削除済み、または id が誤りです。');
      log.push('   → Webhookを作り直してください。');
    } else if (code === 429) {
      log.push('⚠️ レート制限(429)。少し時間をおいて再実行してください。');
    } else {
      log.push('⚠️ 予期しない応答: HTTP ' + code + ' / body=' + body.slice(0, 200));
    }
  } catch (e) {
    log.push('❌ 通信例外: ' + e);
  }
  return _emit(log);
}

/**
 * テストメッセージを1通だけ送信し、レスポンスコードで送信可否を判定する。
 * @return {string} 判定結果(実行ログにも出力)
 */
function smokeTestDiscord() {
  const url = PropertiesService.getScriptProperties().getProperty('DISCORD_WEBHOOK_URL');
  if (!url) {
    return _emit(['❌ DISCORD_WEBHOOK_URL 未設定。先に diagnoseDiscord() を実行してください。']);
  }
  const stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  const msg = '🧪 ザラバ 疎通テスト ' + stamp;
  const res = UrlFetchApp.fetch(url.trim(), {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ content: msg }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const log = [];
  if (code === 204 || code === 200) {
    log.push('✅ 送信成功(HTTP ' + code + ')。');
    log.push('   Discordに「' + msg + '」が表示されれば疎通OK。');
    log.push('   表示されない場合は別チャンネルに投稿されている → diagnoseDiscord() の channel_id を確認。');
  } else {
    log.push('❌ 送信失敗 HTTP ' + code);
    log.push('   body=' + res.getContentText().slice(0, 300));
    log.push('   → diagnoseDiscord() で③無効/②形式を切り分けてください。');
  }
  return _emit(log);
}

// ============ 内部ヘルパー ============

/** ログ配列を実行ログに出力しつつ、結合文字列を返す */
function _emit(lines) {
  const out = lines.join('\n');
  Logger.log(out);
  return out;
}

/** Webhook URLの token 部分をマスクして表示用に整形 */
function _maskWebhook(u) {
  return String(u).replace(
    /(webhooks\/\d+\/)([\w-]+)/,
    function (_all, head, tok) {
      return head + tok.slice(0, 4) + '…' + tok.slice(-2);
    }
  );
}
