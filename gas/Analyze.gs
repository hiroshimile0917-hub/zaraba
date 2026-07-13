/**
 * Analyze.gs — 定量化・カテゴリ分類・インパクト判定
 * - 業績修正PDFから修正前後の数値を抽出(Geminiマルチモーダル・無料枠)
 * - 営業利益の会社予想比 ±10%以上=大 / ±5〜10%=中 の定量基準
 * - 抽出失敗時はキーワード判定にフォールバック
 */

// ---------- カテゴリ分類 ----------
function classifyCategory(title) {
  if (/上方修正|下方修正|業績予想|決算短信|月次|営業実績/.test(title)) return 'earnings';
  if (/公開買付|TOB|MBO|完全子会社化|経営統合|合併|業務提携|資本提携|資本業務提携|子会社化|株式取得|買収/.test(title)) return 'deal';
  if (/自己株式|増配|復配|配当予想|株式分割|株主優待|無償割当/.test(title)) return 'return';
  if (/大量保有|変更報告/.test(title)) return 'holding';
  return 'other';
}

// ---------- 業績修正判定 ----------
function isRevisionTitle(title) {
  return /上方修正|下方修正/.test(title) ||
    (/修正/.test(title) && /業績予想|通期|連結業績|配当予想/.test(title));
}

// ---------- PDFから修正前後の数値を抽出(Gemini) ----------
/**
 * @return {Object|null} { metric, oldVal, newVal, pct, signFlip, text, detail } 単位:百万円
 */
function extractRevision(pdfUrl) {
  if (!pdfUrl) return null;
  try {
    const blob = UrlFetchApp.fetch(pdfUrl, { muteHttpExceptions: true }).getBlob();
    if (blob.getBytes().length > 15 * 1024 * 1024) return null; // Gemini inline上限に配慮
    const b64 = Utilities.base64Encode(blob.getBytes());

    const key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${key}`;
    const prompt = [
      'この適時開示PDFが業績予想または配当予想の修正であれば、修正前(前回発表予想)と修正後(今回修正予想)の数値を抽出してください。',
      '対象は通期(通期がなければ最も長い期間)の連結(なければ単体)予想。',
      '単位は百万円に統一(「億円」表記なら100倍)。配当は円。該当がない項目は null。',
      '数値が読み取れない・修正開示でない場合は is_revision を false に。',
      'JSONのみを出力:',
      '{"is_revision":bool,"period":"2026年3月期"等,"sales_old":num,"sales_new":num,"op_old":num,"op_new":num,"ordinary_old":num,"ordinary_new":num,"np_old":num,"np_new":num,"dividend_old":num,"dividend_new":num}',
    ].join('\n');

    const payload = {
      contents: [{ parts: [
        { inline_data: { mime_type: 'application/pdf', data: b64 } },
        { text: prompt },
      ]}],
      generationConfig: { response_mime_type: 'application/json', temperature: 0 },
    };
    const res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) return null;
    const out = JSON.parse(res.getContentText());
    const data = JSON.parse(out.candidates[0].content.parts[0].text);
    return computeRevision(data);
  } catch (e) {
    Logger.log('extractRevision error: ' + e);
    return null;
  }
}

/**
 * 抽出JSONから代表指標(営業益優先)の修正率を計算(純粋関数・テスト対象)
 */
function computeRevision(data) {
  if (!data || !data.is_revision) return null;
  const metrics = [
    { key: 'op',       label: '営業益' },
    { key: 'ordinary', label: '経常益' },
    { key: 'np',       label: '純利益' },
    { key: 'sales',    label: '売上高' },
  ];
  for (const m of metrics) {
    const oldV = toNum(data[m.key + '_old']);
    const newV = toNum(data[m.key + '_new']);
    if (oldV == null || newV == null) continue;
    if (oldV === 0 && newV === 0) continue;

    const signFlip = (oldV < 0 && newV > 0) || (oldV > 0 && newV < 0);
    const pct = oldV !== 0 ? ((newV - oldV) / Math.abs(oldV)) * 100 : null;
    const text = formatRevisionText(m.label, oldV, newV, pct, signFlip);
    return {
      metric: m.label, oldVal: oldV, newVal: newV,
      pct: pct, signFlip: signFlip, text: text,
      period: data.period || '',
      detail: buildRevisionDetail(data),
    };
  }
  return null;
}

function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/** "営業益 会社予想比+12.3%(450→506億円)" 形式(値は百万円で受ける) */
function formatRevisionText(label, oldV, newV, pct, signFlip) {
  const oldOku = fmtOku(oldV), newOku = fmtOku(newV);
  if (signFlip) {
    const dir = newV > 0 ? '黒字転換' : '赤字転落';
    return `${label} ${dir}(${oldOku}→${newOku}億円)`;
  }
  if (pct == null) return `${label} ${oldOku}→${newOku}億円`;
  const sign = pct > 0 ? '+' : '';
  return `${label} 会社予想比${sign}${pct.toFixed(1)}%(${oldOku}→${newOku}億円)`;
}

function fmtOku(millionYen) {
  const oku = millionYen / 100;
  return Math.abs(oku) >= 100 ? String(Math.round(oku)) : String(Math.round(oku * 10) / 10);
}

function buildRevisionDetail(data) {
  const rows = [];
  const defs = [['sales', '売上高'], ['op', '営業益'], ['ordinary', '経常益'], ['np', '純利益']];
  for (const [k, label] of defs) {
    const o = toNum(data[k + '_old']), n = toNum(data[k + '_new']);
    if (o == null || n == null) continue;
    const pct = o !== 0 ? ((n - o) / Math.abs(o)) * 100 : null;
    rows.push(`${label} ${fmtOku(o)}→${fmtOku(n)}億円` + (pct != null ? `(${pct > 0 ? '+' : ''}${pct.toFixed(1)}%)` : ''));
  }
  const dO = toNum(data.dividend_old), dN = toNum(data.dividend_new);
  if (dO != null && dN != null && dO !== dN) rows.push(`配当 ${dO}→${dN}円`);
  return rows.join(' / ');
}

// ---------- インパクト判定(定量優先、キーワードはフォールバック) ----------
function decideImpact(it, revision) {
  // 1) 定量基準
  if (revision) {
    if (revision.signFlip) return 'high';
    if (revision.pct != null) {
      const a = Math.abs(revision.pct);
      if (a >= CONFIG.IMPACT_HIGH_PCT) return 'high';
      if (a >= CONFIG.IMPACT_MID_PCT) return 'mid';
      return 'low';
    }
  }
  // 2) タイトルで大が確定するイベント
  if (FORCE_HIGH_KEYWORDS.some(kw => it.title.includes(kw))) return 'high';
  // 3) キーワードフォールバック
  return scoreTitle(it.title) > 0 ? 'mid' : 'low';
}

// ---------- 記事オブジェクト構築 ----------
function buildArticle(it, impact, revision, source) {
  return {
    id: it.id,
    pubdate: it.pubdate,
    code: it.code,
    company: it.company,
    title: it.title,
    cat: classifyCategory(it.title),
    impact: impact,
    summary: it.summary || '',
    url: it.url || '',
    source: source || 'tdnet',
    revision: revision || null,
    capOku: null,
    filtered: false,
  };
}
