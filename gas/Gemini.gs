/**
 * Gemini生成を一元管理。無料枠はAPIキー単位でなくGoogleプロジェクト単位。
 * RPDはAmerica/Los_Angelesの0時でリセット（夏時間もUtilitiesに任せる）。
 * 送信試行は成功/失敗を問わず事前に数える。GAS内の同時実行はScriptLockで調停。
 * 別GAS/AI Studio等の利用量は把握できないため、APIの429を最終的な制限として扱う。
 */
const GEMINI_LEDGER_KEY = 'GEMINI_USAGE_V1';

function geminiModel() {
  return PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL') || CONFIG.GEMINI_MODEL;
}

function geminiQuotaDay(now) {
  return Utilities.formatDate(now, 'America/Los_Angeles', 'yyyy-MM-dd');
}

/** ロック失敗・壊れた台帳はフェイルクローズ。枠を勝手にゼロへ戻さない。 */
function withGeminiLedger(action) {
  let lock;
  let acquired = false;
  try {
    lock = LockService.getScriptLock();
    acquired = lock.tryLock(1000);
    if (!acquired) { Logger.log('Gemini budget: lock unavailable'); return null; }
    const props = PropertiesService.getScriptProperties();
    const now = new Date();
    const day = geminiQuotaDay(now);
    const raw = props.getProperty(GEMINI_LEDGER_KEY);
    let state = raw ? JSON.parse(raw) : null;
    if (state && (!/^\d{4}-\d{2}-\d{2}$/.test(state.day) || !Number.isInteger(state.used) || state.used < 0 ||
        !Number.isInteger(state.optionalUsed) || state.optionalUsed < 0 || state.optionalUsed > state.used)) {
      throw new Error('invalid ledger');
    }
    if (state && state.day > day) throw new Error('future ledger');
    if (!state || state.day !== day) state = { day, used: 0, optionalUsed: 0, byPurpose: {}, dailyBlocked: false, nextAt: 0, cooldownUntil: 0 };
    const result = action(state, now);
    props.setProperty(GEMINI_LEDGER_KEY, JSON.stringify(state));
    return result;
  } catch (e) {
    Logger.log('Gemini budget: ledger unavailable (generation skipped)');
    return null;
  } finally {
    if (acquired) {
      try { lock.releaseLock(); } catch (e) { Logger.log('Gemini budget: lock release failed'); }
    }
  }
}

/** 朝刊は日本時間の翌日付になるPT枠を使用。PTリセット後の手動朝刊は翌朝用の予約を使わない。 */
function geminiBudgetDecision(state, now, purpose) {
  const limit = CONFIG.GEMINI_DAILY_LIMIT;
  const reserve = CONFIG.GEMINI_MORNING_RESERVE;
  if (!Number.isInteger(limit) || !Number.isInteger(reserve) || reserve < 1 || limit < reserve) return { allowed: false, reason: 'invalid_config' };
  if (purpose === 'diagnostic' && !CONFIG.GEMINI_DIAGNOSTIC_GENERATE) return { allowed: false, reason: 'diagnostic_disabled' };
  const priority = purpose === 'morning' && Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd') > state.day;
  if (purpose === 'pdf' && ((state.byPurpose || {}).pdf || 0) >= CONFIG.GEMINI_PDF_DAILY_LIMIT) return { allowed: false, reason: 'pdf_budget' };
  if (state.dailyBlocked) return { allowed: false, reason: 'daily_exhausted' };
  if (state.used >= limit) return { allowed: false, reason: 'daily_budget' };
  if (priority && state.used - state.optionalUsed >= reserve) return { allowed: false, reason: 'morning_budget' };
  if (!priority && state.optionalUsed >= limit - reserve) return { allowed: false, reason: 'morning_reserved' };
  const waitMs = Math.max(state.nextAt || 0, state.cooldownUntil || 0) - now.getTime();
  if (waitMs > 0) return { allowed: false, reason: 'cooldown', waitMs };
  return { allowed: true, priority, day: state.day };
}

function inspectGeminiBudget(purpose) {
  return withGeminiLedger((state, now) => geminiBudgetDecision(state, now, purpose));
}

function reserveGeminiCall(purpose) {
  return withGeminiLedger((state, now) => {
    const decision = geminiBudgetDecision(state, now, purpose);
    if (decision.allowed) {
      state.used++;
      state.byPurpose = state.byPurpose || {};
      state.byPurpose[purpose] = (state.byPurpose[purpose] || 0) + 1;
      if (!decision.priority) state.optionalUsed++;
      state.nextAt = now.getTime() + CONFIG.GEMINI_MIN_INTERVAL_MS;
    }
    return decision;
  });
}

/** 日次制限はstructured QuotaFailureを優先し、本文の明示的な日次表記も拾う。 */
function geminiRateLimit(body, headers, now) {
  let error = {};
  try { error = JSON.parse(body).error || {}; } catch (e) { /* 不明429は短時間制限として待機 */ }
  const details = Array.isArray(error.details) ? error.details : [];
  const violations = details.flatMap(d => Array.isArray(d.violations) ? d.violations : []);
  const daily = violations.some(v => /PerDay|Daily|per_day/i.test(String(v.quotaId) + ' ' + String(v.quotaMetric))) ||
    /per day|daily|requests per day|\bRPD\b|PerDay/i.test(error.message || '');
  let waitMs = CONFIG.GEMINI_RATE_COOLDOWN_MS;
  for (const detail of details) {
    const match = String(detail.retryDelay || '').match(/^(\d+(?:\.\d+)?)s$/);
    if (match) waitMs = Math.max(waitMs, Math.ceil(Number(match[1]) * 1000));
  }
  for (const name of Object.keys(headers || {})) {
    if (name.toLowerCase() !== 'retry-after') continue;
    const value = String(headers[name]);
    const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now.getTime();
    if (Number.isFinite(delay)) waitMs = Math.max(waitMs, delay);
  }
  return { daily, waitMs };
}

function recordGeminiRateLimit(info, requestDay) {
  return withGeminiLedger((state, now) => {
    if (requestDay !== state.day) return true; // 前日分の遅い429で新しい日の朝刊を止めない
    if (info.daily) state.dailyBlocked = true;
    state.cooldownUntil = Math.max(state.cooldownUntil || 0, now.getTime() + info.waitMs);
    return true;
  });
}

/** トークン量の多いPDFも同じ生成枠を使用。キャッシュは現在の日付・モデルに限定。 */
function geminiCacheKey(purpose, cacheId) {
  if (!cacheId) return null;
  const value = [geminiModel(), geminiQuotaDay(new Date()), purpose, cacheId].join('|');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return 'gemini:' + bytes.map(n => (n & 255).toString(16).padStart(2, '0')).join('');
}

function readGeminiCache(purpose, cacheId) {
  try {
    const key = geminiCacheKey(purpose, cacheId);
    return key ? CacheService.getScriptCache().get(key) : null;
  } catch (e) { return null; }
}

function requestGemini(payload, purpose, cacheId) {
  purpose = ['morning', 'pdf', 'intraday', 'diagnostic'].includes(purpose) ? purpose : 'intraday';
  const props = PropertiesService.getScriptProperties();
  const key = (props.getProperty('GEMINI_API_KEY') || '').trim();
  if (!key) { Logger.log('Gemini: GEMINI_API_KEY 未設定'); return null; }
  const cached = readGeminiCache(purpose, cacheId);
  if (cached) return cached;
  const model = geminiModel();
  const redact = value => String(value).split(key).join('[REDACTED]');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  for (let attempt = 1; attempt <= CONFIG.GEMINI_MAX_ATTEMPTS; attempt++) {
    let ticket = reserveGeminiCall(purpose);
    // 朝刊のみ短い待ち時間を許可。場中やPDFは待機せず既存フォールバックへ。
    if (ticket && !ticket.allowed && ticket.waitMs > 0 && ticket.waitMs <= CONFIG.GEMINI_MAX_WAIT_MS && purpose === 'morning') {
      Utilities.sleep(ticket.waitMs);
      ticket = reserveGeminiCall(purpose);
    }
    if (!ticket || !ticket.allowed) {
      Logger.log(`Gemini purpose=${purpose} skipped: ${ticket ? ticket.reason : 'ledger_unavailable'}`);
      return null;
    }
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': key },
        payload: JSON.stringify(payload), muteHttpExceptions: true,
      });
      const status = res.getResponseCode();
      const body = res.getContentText();
      if (status === 200) {
        try {
          const data = JSON.parse(body);
          const candidate = (data.candidates || [])[0];
          const text = candidate && candidate.content && (candidate.content.parts || [])
            .filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join('\n').trim();
          if (text && (!candidate.finishReason || candidate.finishReason === 'STOP')) {
            try {
              const cacheKey = geminiCacheKey(purpose, cacheId);
              if (cacheKey) CacheService.getScriptCache().put(cacheKey, text, CONFIG.GEMINI_CACHE_SECONDS);
            } catch (e) { /* キャッシュ障害は生成成功を破棄しない */ }
            return text;
          }
          Logger.log(`Gemini model=${model} HTTP 200 invalid/blocked response: ${redact(body)}`);
        } catch (e) { Logger.log(`Gemini model=${model} HTTP 200 parse error: ${redact(body)}`); }
        return null;
      }
      Logger.log(`Gemini model=${model} purpose=${purpose} attempt=${attempt} HTTP ${status}: ${redact(body)}`);
      if (status === 429) {
        const info = geminiRateLimit(body, res.getAllHeaders(), new Date());
        recordGeminiRateLimit(info, ticket.day);
        // 日次超過では同一実行の再試行も、その日の後続生成も止める。
        Logger.log(`Gemini quota: ${info.daily ? 'daily_exhausted' : 'rate_cooldown'}; generation paused`);
        return null;
      }
      if (status < 500) return null;
    } catch (e) { Logger.log(`Gemini model=${model} purpose=${purpose} transport error: ${redact(e)}`); }
    if (attempt < CONFIG.GEMINI_MAX_ATTEMPTS) Utilities.sleep(CONFIG.GEMINI_RETRY_MS * Math.pow(2, attempt - 1));
  }
  return null;
}

/** キーやプロンプトを出さない手動確認。生成リクエストは消費しない。 */
function geminiUsageStatus() {
  const status = withGeminiLedger(state => ({ ...state, limit: CONFIG.GEMINI_DAILY_LIMIT, morningReserve: CONFIG.GEMINI_MORNING_RESERVE }));
  Logger.log(JSON.stringify(status));
  return status;
}
