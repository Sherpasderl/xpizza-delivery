'use strict';
/* REAL-CREDENTIAL SCRUB for test processes (R3 P1-a, codex r2 P1-1c). The deeper hazard behind egress is a test process
 * that HOLDS a real credential: then any unguarded path has something real to send with. tools/emulator-run.js removes
 * every secret key below from the suite's environment (and the R3 runners assert they are absent before setting their
 * own FAKE test values in-process), so even an unguarded path has nothing real to send.
 *
 * The key set = the REVIEWED list (every secret the functions code reads from process.env, plus the platform's ambient
 * credential variables) ∪ the KEY NAMES of any functions .env* file present in the checkout. Only NAMES are read from a
 * .env file — never a value; nothing here prints, logs or returns a value.
 */
const fs = require('fs');
const path = require('path');

const REVIEWED = [
  // WhatsApp transport (UltraMsg) — both brands
  'ULTRAMSG_INSTANCE_ID', 'ULTRAMSG_TOKEN', 'ULTRAMSG_INSTANCE_ID_LA_MUSA', 'ULTRAMSG_TOKEN_LA_MUSA', 'WHATSAPP_WEBHOOK_SECRET',
  // PixelPay
  'PIXELPAY_GW_ACCESS_TOKEN', 'PIXELPAY_KEY_ID', 'PIXELPAY_SECRET', 'PIXELPAY_WEBHOOK_SECRET', 'PIXELPAY_PUBLIC_KEY', 'PIXELPAY_MERCHANT_EMAIL',
  // order intake / tokens / hashing secrets
  'MAKE_SECRET', 'INTAKE_SECRET', 'EDIT_TOKEN_SECRET', 'QUOTE_TOKEN_SECRET', 'RECON_SECRET', 'STATS_HMAC_SECRET', 'OTP_SALT',
  // web push
  'VAPID_PRIVATE_KEY',
  // maps / google APIs (named here so a future key is scrubbed the day it appears)
  'GOOGLE_MAPS_API_KEY', 'MAPS_API_KEY', 'GOOGLE_API_KEY',
  // stacked-delivery sequencing (BUILD-stacked-seq-server T3): the Routes API key, bound to autoAssign + sweep only
  'ROUTES_API_KEY',
  // ambient platform credentials
  'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GCLOUD_TOKEN', 'CLOUDSDK_AUTH_ACCESS_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN',
  'NETLIFY_AUTH_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
];

// the KEY NAMES (left of `=`) of the functions .env* files in this checkout — values are never read into a variable
function envFileKeyNames(fnDir = path.join(__dirname, '..')) {
  const names = new Set();
  let files = [];
  try { files = fs.readdirSync(fnDir).filter((f) => /^\.env(\..+)?$/.test(f) && !/\.example$/.test(f)); } catch (_) { files = []; }
  for (const f of files) {
    let text = ''; try { text = fs.readFileSync(path.join(fnDir, f), 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) { const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line); if (m) names.add(m[1]); }
    text = '';
  }
  return [...names];
}
// .env names that are configuration, not credentials (kept: a suite may need them and they hold nothing secret)
const NOT_SECRET = new Set(['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FB_DATABASE_URL', 'PIXELPAY_ENV', 'PIXELPAY_MODE', 'PIXELPAY_ENDPOINT', 'PIXELPAY_APP_URL', 'PIXELPAY_CALLBACK_URL', 'PIXELPAY_RETURN_URL_LA_MUSA', 'PIXELPAY_SANDBOX_AMOUNT', 'TRACKING_BASE', 'TRACKING_BASE_LA_MUSA', 'CREATEORDER_URL', 'CORS_EXTRA_ENDPOINTS', 'VAPID_PUBLIC_KEY', 'VAPID_SUBJECT', 'KDS_SHEET_NAME', 'CREATEORDER_WA_NOTIFY_MS']);
function secretKeys(fnDir) { return [...new Set([...REVIEWED, ...envFileKeyNames(fnDir).filter((k) => !NOT_SECRET.has(k))])].sort(); }

// removes every secret key from `env` (in place); returns the NAMES removed (never values)
function scrub(env, keys = secretKeys()) { const removed = []; for (const k of keys) if (Object.prototype.hasOwnProperty.call(env, k)) { delete env[k]; removed.push(k); } return removed; }
const present = (env, keys = secretKeys()) => keys.filter((k) => Object.prototype.hasOwnProperty.call(env, k));

module.exports = { REVIEWED, NOT_SECRET, secretKeys, envFileKeyNames, scrub, present };
