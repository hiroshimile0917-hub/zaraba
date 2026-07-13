/**
 * Edinet.gs — 大量保有報告(5%ルール)巡回
 * EDINET API v2(無料・要APIキー)。スクリプトプロパティ EDINET_API_KEY 未設定ならスキップ。
 * - 大量保有報告書(docTypeCode 350)/変更報告書(360)を検知
 * - CSVデータ(type=5)から保有割合(今回/前回)・発行者を抽出
 * - アクティビストウォッチリスト該当時はインパクト大
 */

// アクティビスト系提出者ウォッチリスト(部分一致・適宜追加)
const ACTIVIST_WATCHLIST = [
  'シティインデックスイレブンス', '村上', 'エスグラントコーポレーション',
  'エフィッシモ', 'Effissimo',
  'オアシス', 'Oasis',
  'ストラテジックキャピタル',
  '3D INVESTMENT', '3Dインベストメント',
  'バリューアクト', 'ValueAct',
  'ダルトン', 'Dalton', 'NAVF', 'ニッポン・アクティブ・バリュー',
  'シルチェスター', 'Silchester',
  'アセット・バリュー・インベスターズ', 'AVI',
  'カタリスト', 'Catalyst',
  'ひびき・パース', 'マネックス・アクティビスト',
  'パリサー', 'Palliser', 'エリオット', 'Elliott',
];

function edinetPatrol() {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('EDINET_API_KEY');
  if (!key) return; // 未設定ならスキップ(無料キーはEDINETサイトで発行)

  const seen = JSON.parse(props.getProperty('SEEN_EDINET') || '[]');
  const seenSet = new Set(seen);
  const today = fmtYmd(new Date());

  const url = `https://api.edinet-fsa.go.jp/api/v2/documents.json?date=${today}&type=2&Subscription-Key=${key}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return;
  const json = JSON.parse(res.getContentText());
  const docs = (json.results || []).filter(d =>
    (d.docTypeCode === '350' || d.docTypeCode === '360') && !seenSet.has(d.docID)
  ).slice(0, 10);

  for (const d of docs) {
    seenSet.add(d.docID);
    try {
      processHoldingReport(d, key);
    } catch (e) {
      Logger.log('edinet doc error: ' + e);
    }
    Utilities.sleep(1000);
  }
  props.setProperty('SEEN_EDINET', JSON.stringify([...seenSet].slice(-300)));
}

function processHoldingReport(d, key) {
  const isChange = d.docTypeCode === '360';
  const kind = isChange ? '変更報告書' : '大量保有報告書';
  const filer = d.filerName || '(提出者不明)';

  // CSVから保有割合・発行者を抽出(失敗しても速報は出す)
  const detail = fetchHoldingDetail(d.docID, key) || {};
  const issuer = detail.issuer || parseIssuerFromDescription(d.docDescription) || '';
  const code4 = normalizeSecCode(detail.secCode || d.secCode);

  const isActivist = ACTIVIST_WATCHLIST.some(w =>
    filer.toUpperCase().includes(w.toUpperCase()));
  const impact = isActivist ? 'high' : 'mid';

  let ratioText = '';
  if (detail.ratio != null && detail.prevRatio != null) {
    const arrow = detail.ratio > detail.prevRatio ? '↑' : detail.ratio < detail.prevRatio ? '↓' : '→';
    ratioText = `保有割合 ${detail.prevRatio.toFixed(2)}%→${detail.ratio.toFixed(2)}% ${arrow}`;
  } else if (detail.ratio != null) {
    ratioText = `保有割合 ${detail.ratio.toFixed(2)}%`;
  }

  const badge = isActivist ? '🚨' : '📢';
  const activistNote = isActivist ? '⚠️ アクティビスト系提出者' : '';
  const lines = [
    `${badge} **大量保有速報** ${issuer}${code4 ? `(${code4})` : ''}`,
    `${kind} 提出者: ${filer}`,
    ratioText,
    activistNote,
    detail.purpose ? `保有目的: ${detail.purpose.slice(0, 60)}` : '',
    `https://disclosure2.edinet-fsa.go.jp/`,
  ].filter(Boolean);
  postDiscord(lines.join('\n'));

  // 保存
  const title = `${kind}(提出者: ${filer})${ratioText ? ' ' + ratioText : ''}`;
  saveArticleIfNew({
    id: 'edinet:' + d.docID,
    pubdate: d.submitDateTime ? new Date(d.submitDateTime.replace(' ', 'T') + '+09:00') : new Date(),
    code: code4 || '----',
    company: issuer || filer,
    title: title,
    cat: 'holding',
    impact: impact,
    summary: [`提出者: ${filer}`, ratioText, activistNote].filter(Boolean).join(' / '),
    url: 'https://disclosure2.edinet-fsa.go.jp/',
    source: 'edinet',
    revision: null, capOku: null, filtered: false,
  });
}

/** EDINET CSV(type=5)から保有割合等を抽出 */
function fetchHoldingDetail(docId, key) {
  try {
    const url = `https://api.edinet-fsa.go.jp/api/v2/documents/${docId}?type=5&Subscription-Key=${key}`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    const blobs = Utilities.unzip(res.getBlob().setContentType('application/zip'));
    const csvBlob = blobs.find(b => /\.csv$/i.test(b.getName()));
    if (!csvBlob) return null;
    const text = csvBlob.getDataAsString('UTF-16LE');
    return parseHoldingCsv(text);
  } catch (e) {
    Logger.log('fetchHoldingDetail error: ' + e);
    return null;
  }
}

/** EDINET CSV(TSV/UTF-16)から要素を抽出(純粋関数・テスト対象) */
function parseHoldingCsv(text) {
  const out = { ratio: null, prevRatio: null, issuer: null, secCode: null, purpose: null };
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const cols = line.split('\t').map(s => s.replace(/^"|"$/g, ''));
    if (cols.length < 2) continue;
    const elem = cols[0] || '';
    const val = cols[cols.length - 1] || '';
    if (elem.includes('HoldingRatioOfShareCertificatesEtcPerLastReport')) {
      const n = parseFloat(val); if (isFinite(n)) out.prevRatio = n * (n <= 1 ? 100 : 1);
    } else if (elem.includes('HoldingRatioOfShareCertificatesEtc')) {
      const n = parseFloat(val); if (isFinite(n)) out.ratio = n * (n <= 1 ? 100 : 1);
    } else if (elem.includes('NameOfIssuer')) {
      if (!out.issuer && val && !/様式|CoverPage/.test(val)) out.issuer = val;
    } else if (elem.includes('SecurityCodeOfIssuer')) {
      if (val) out.secCode = val.trim();
    } else if (elem.includes('PurposeOfHolding')) {
      if (!out.purpose && val) out.purpose = val;
    }
  }
  return out;
}

function normalizeSecCode(sec) {
  if (!sec) return '';
  const s = String(sec).trim();
  return s.length === 5 && s.endsWith('0') ? s.slice(0, 4) : s.slice(0, 4);
}

function parseIssuerFromDescription(desc) {
  // docDescription例: "大量保有報告書(株式会社〇〇)" 等から発行者を推定
  const m = String(desc || '').match(/[((]([^))]+)[))]/);
  return m ? m[1] : null;
}
