/**
 * X Pizza — UltraMsg WhatsApp client
 * version: 1.0.0
 *
 * Minimal client for the UltraMsg API. We use the unofficial WhatsApp gateway
 * route ($39/mo flat) — UltraMsg's instance is connected via QR scan to the
 * X. Pizza WhatsApp account, so messages send from X. Pizza's actual number.
 *
 * Env vars (xpizza-functions/.env):
 *   ULTRAMSG_INSTANCE_ID  e.g. "instance170156"
 *   ULTRAMSG_TOKEN        the API token (treat as a password — never commit)
 *
 * Optional Firebase config flag:
 *   /config/whatsapp_enabled = false  → suppresses all sends without redeploy
 *                                       (default: enabled)
 *
 * Design choices:
 * - All sends are best-effort: we log errors but never throw out to the caller.
 *   Order fulfillment must not break because WhatsApp had a hiccup.
 * - Phone numbers are normalized to international format with country code.
 *   UltraMsg accepts numbers with country code, no '+', and no spaces.
 * - Templates live in this module so the message catalog is in one place.
 */

const fetch = require('node-fetch');

const INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;
const TOKEN = process.env.ULTRAMSG_TOKEN;
const API_BASE = INSTANCE_ID ? `https://api.ultramsg.com/${INSTANCE_ID}` : null;

// Honduras country code default (most customers). If a phone already includes
// a country code, we leave it as-is.
const DEFAULT_COUNTRY_CODE = '504';

// Public tracking site base URL — orders include a tracking_token, link is
// `${TRACKING_BASE}/${token}`. Update once xpizzatrack.netlify.app is live.
const TRACKING_BASE = 'https://xpizzatrack.netlify.app';

/**
 * Normalize a phone number for UltraMsg. UltraMsg wants country-code-prefixed
 * digits with no '+', no spaces, no dashes.
 *
 * Input examples → output:
 *   "+50488884444"   → "50488884444"
 *   "504 8888-4444"  → "50488884444"
 *   "88884444"       → "50488884444"  (Honduras 8-digit number, code prepended)
 *   "8888-4444"      → "50488884444"
 */
function normalizePhone(raw) {
  if (!raw) return null;
  // Strip everything that isn't a digit or '+'
  let cleaned = String(raw).replace(/[^\d+]/g, '');
  // Drop leading '+'
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1);
  // If it's 8 digits (Honduras local format), prepend country code
  if (cleaned.length === 8) cleaned = DEFAULT_COUNTRY_CODE + cleaned;
  // Validation: must be 10-15 digits to be plausibly an international number
  if (cleaned.length < 10 || cleaned.length > 15) {
    console.warn(`whatsapp: phone "${raw}" normalized to "${cleaned}" — looks invalid, skipping`);
    return null;
  }
  return cleaned;
}

/**
 * Send a WhatsApp message via UltraMsg. Returns null on failure (never throws).
 */
async function sendMessage(toPhone, body) {
  if (!INSTANCE_ID || !TOKEN) {
    console.warn('whatsapp: ULTRAMSG_INSTANCE_ID or ULTRAMSG_TOKEN not configured, skipping send');
    return null;
  }
  const normalized = normalizePhone(toPhone);
  if (!normalized) {
    return null;
  }
  if (!body || typeof body !== 'string') {
    console.warn('whatsapp: empty/invalid body, skipping send');
    return null;
  }

  try {
    const params = new URLSearchParams({
      token: TOKEN,
      to: normalized,
      body: body,
      // Disable WhatsApp link previews — they're noisy and the tracking link
      // is the main content; a thumbnail preview adds nothing.
      // 'priority': '10',  // default; optional
    });
    const url = `${API_BASE}/messages/chat`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      console.error(`whatsapp: send to ${normalized} failed`, resp.status, data);
      return null;
    }
    console.log(`whatsapp: sent to ${normalized}, msg id=${data.id || 'n/a'}`);
    return data;
  } catch (e) {
    console.error(`whatsapp: send to ${toPhone} threw`, e.message);
    return null;
  }
}

/**
 * Check the kill-switch flag in Firebase config.
 * Returns true if WhatsApp is enabled (default), false if explicitly disabled.
 */
async function isEnabled(db) {
  try {
    const snap = await db.ref('config/whatsapp_enabled').once('value');
    const val = snap.val();
    return val !== false;  // default ON
  } catch (e) {
    console.warn('whatsapp: failed to read config flag, defaulting to enabled', e.message);
    return true;
  }
}

// ============================================================
// MESSAGE TEMPLATES
// ============================================================
//
// Each template takes a context object (the order + driver/extra info) and
// returns the formatted message body. Templates kept in this file for easy
// tweaking without touching trigger logic.
//
// Tone matches the existing Make.com message — warm, emoji-friendly,
// transactional. Tracking link included where useful (first message and
// in-progress messages; not in delivered/cancelled which are terminal).

function trackingUrl(token) {
  return `${TRACKING_BASE}/${token}`;
}

function tplOrderReceived({ customerName, orderId, itemsText, total, trackingToken }) {
  return [
    `¡Hola ${customerName || ''}! 👋`,
    ``,
    `Recibimos tu pedido en X. Pizza ✅`,
    ``,
    `🍕 ${itemsText || ''}`,
    `💰 Total: L${total}`,
    ``,
    `Tu pedido está siendo preparado. Te avisamos cuando esté en camino 🛵`,
    ``,
    `Sigue tu pedido en tiempo real:`,
    trackingUrl(trackingToken),
    ``,
    `¡Gracias por preferirnos!`
  ].join('\n');
}

function tplDriverAssigned({ customerName, driverName, trackingToken }) {
  return [
    `¡Tu pizza está lista! 🍕`,
    ``,
    `${driverName || 'Nuestro repartidor'} sale ahora del restaurante con tu pedido${customerName ? ', ' + customerName : ''}.`,
    ``,
    `Sigue su ubicación:`,
    trackingUrl(trackingToken)
  ].join('\n');
}

function tplOutForDelivery({ driverName, etaMinutes, trackingToken }) {
  const eta = etaMinutes ? `\nLlegada estimada: ~${etaMinutes} min` : '';
  return [
    `🛵 ${driverName || 'Tu repartidor'} ya viene en camino${eta}`,
    ``,
    trackingUrl(trackingToken)
  ].join('\n');
}

function tplDelivered({ customerName }) {
  return [
    `✅ ¡Entregado!`,
    ``,
    `Esperamos que disfrutes tu X. Pizza${customerName ? ', ' + customerName : ''}.`,
    ``,
    `¿Algún problema con tu pedido? Responde a este mensaje y te ayudamos.`
  ].join('\n');
}

function tplCancelled({ orderId }) {
  return [
    `Lamentamos avisarte que tu pedido${orderId ? ' #' + orderId : ''} fue cancelado.`,
    ``,
    `Si pagaste por adelantado, te contactaremos pronto sobre el reembolso.`,
    ``,
    `Cualquier pregunta, escríbenos a este número.`
  ].join('\n');
}

module.exports = {
  sendMessage,
  isEnabled,
  normalizePhone,
  tplOrderReceived,
  tplDriverAssigned,
  tplOutForDelivery,
  tplDelivered,
  tplCancelled,
  TRACKING_BASE
};
