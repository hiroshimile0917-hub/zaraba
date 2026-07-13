#!/usr/bin/env node
/**
 * .env → gas/SetupLocal.gs 生成ツール
 * 実行: node tools/env-to-setup.js
 * 生成された gas/SetupLocal.gs をGASエディタに貼り、applySecrets() を1回実行後、削除する。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const OUT_PATH = path.join(ROOT, 'gas', 'SetupLocal.gs');

const ALLOWED_KEYS = [
  'DISCORD_WEBHOOK_URL', 'GEMINI_API_KEY', 'EDINET_API_KEY',
  'JQUANTS_MAIL', 'JQUANTS_PASSWORD', 'CRON_TOKEN',
];

if (!fs.existsSync(ENV_PATH)) {
  console.error('.env が見つかりません。cp .env.example .env で作成し、値を記入してください。');
  process.exit(1);
}

const env = {};
for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
  const s = line.trim();
  if (!s || s.startsWith('#')) continue;
  const eq = s.indexOf('=');
  if (eq === -1) continue;
  const key = s.slice(0, eq).trim();
  let val = s.slice(eq + 1).trim();
  // 前後のクォートを除去
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    val = val.slice(1, -1);
  }
  if (ALLOWED_KEYS.includes(key) && val) env[key] = val;
}

const keys = Object.keys(env);
if (keys.length === 0) {
  console.error('.env に値が1つも設定されていません。');
  process.exit(1);
}

// 簡易バリデーション
const warn = [];
if (env.DISCORD_WEBHOOK_URL && !/^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(env.DISCORD_WEBHOOK_URL))
  warn.push('DISCORD_WEBHOOK_URL がWebhook URLの形式ではないようです');
if (env.JQUANTS_MAIL && !/@/.test(env.JQUANTS_MAIL))
  warn.push('JQUANTS_MAIL がメールアドレスの形式ではないようです');
for (const w of warn) console.warn('⚠ ' + w);

const body = `/**
 * SetupLocal.gs — シークレット反映用(自動生成・コミット禁止)
 * 使い方: GASエディタに貼り付け → applySecrets() を1回実行 → このファイルをGAS上から削除
 */
function applySecrets() {
  const props = PropertiesService.getScriptProperties();
  const secrets = ${JSON.stringify(env, null, 4).replace(/\n/g, '\n  ')};
  for (const k in secrets) props.setProperty(k, secrets[k]);
  Logger.log('反映しました: ' + Object.keys(secrets).join(', '));
  Logger.log('確認: このファイル(SetupLocal.gs)をGASエディタから削除してください。');
}

/** 反映状況の確認(値は末尾4文字だけ表示) */
function checkSecrets() {
  const props = PropertiesService.getScriptProperties();
  ${JSON.stringify(ALLOWED_KEYS)}.forEach(k => {
    const v = props.getProperty(k);
    Logger.log(k + ': ' + (v ? '設定済み(…' + v.slice(-4) + ')' : '未設定'));
  });
}
`;

fs.writeFileSync(OUT_PATH, body);
console.log('生成しました: gas/SetupLocal.gs (' + keys.length + '件: ' + keys.join(', ') + ')');
console.log('次の手順: GASエディタに貼り付け → applySecrets() を実行 → GAS上のSetupLocal.gsを削除');
