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

// Customer-facing brand/display name per restaurant (D1). NOT identity.name ('X Pizza' ≠ the brand
// 'X. Pizza' — seed_identity.js:25 tracks the brand separately). Pure presentation copy, so a code
// map (no config-plane machinery). brandFor defaults to 'X. Pizza' → x_pizza/legacy/unknown render
// the existing literal byte-for-byte.
const BRAND_BY_RESTAURANT = { x_pizza: 'X. Pizza', la_musa: 'La Musa' };
function brandFor(restaurantId) {
  return BRAND_BY_RESTAURANT[restaurantId] || 'X. Pizza';
}

// Per-restaurant customer-facing food copy (E1). x_pizza values are the EXACT current literals →
// byte-identical; only the la_musa branch differs (and it's dark). "pizza" is feminine (está listA),
// "pedido" is masculine (está listO) — a bare noun-swap is wrong, so map the WHOLE ready line.
const ITEMS_EMOJI_BY_RESTAURANT = { x_pizza: '🍕', la_musa: '🍜' };
const READY_LINE_BY_RESTAURANT = {
  x_pizza: '¡Tu pizza está lista! 🍕',   // unchanged literal
  la_musa: '¡Tu pedido está listo! 🍜',
};
function itemsEmojiFor(restaurantId) { return ITEMS_EMOJI_BY_RESTAURANT[restaurantId] || '🍕'; }
function readyLineFor(restaurantId) { return READY_LINE_BY_RESTAURANT[restaurantId] || READY_LINE_BY_RESTAURANT.x_pizza; }

// Per-restaurant UltraMsg config (C2). x_pizza (and any non-la_musa) → the module globals + the
// HARDCODED TRACKING_BASE constant, byte-for-byte (NOT process.env.TRACKING_BASE — that's undefined
// and would break x_pizza links). la_musa → its own (instance, token, tracking base) via _LA_MUSA
// env; returns null when its creds are unset → sendMessage skips (fail-safe: never sends a la_musa
// order from X. Pizza's number). env is injected for unit testing.
function resolveWhatsappConfig(restaurantId, env = process.env) {
  if (restaurantId === 'la_musa') {
    const instanceId = env.ULTRAMSG_INSTANCE_ID_LA_MUSA;
    const token = env.ULTRAMSG_TOKEN_LA_MUSA;
    const trackingBase = env.TRACKING_BASE_LA_MUSA;   // set post-C4
    // TRACKING_BASE_LA_MUSA is folded into la_musa's can-send creds: if it's unset we return null
    // (skip the send) rather than fall back to the X. Pizza link — otherwise a la_musa order could
    // send via la_musa's number but with an X. Pizza tracking link (partial leak).
    if (!instanceId || !token || !trackingBase) return null;
    return { apiBase: `https://api.ultramsg.com/${instanceId}`, token, trackingBase };
  }
  return { apiBase: API_BASE, token: TOKEN, trackingBase: TRACKING_BASE };
}

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
async function sendMessage(toPhone, body, restaurantId = 'x_pizza') {
  const cfg = resolveWhatsappConfig(restaurantId);
  if (!cfg || !cfg.apiBase || !cfg.token) {
    console.warn(`whatsapp: no UltraMsg config for restaurant '${restaurantId}', skipping send`);
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
      token: cfg.token,
      to: normalized,
      body: body,
      // Disable WhatsApp link previews — they're noisy and the tracking link
      // is the main content; a thumbnail preview adds nothing.
      // 'priority': '10',  // default; optional
    });
    const url = `${cfg.apiBase}/messages/chat`;
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

// Per-restaurant enablement (C2, model B). x_pizza → EXACTLY isEnabled(db) (the global flag),
// byte-identical, no new config-plane read. A non-x_pizza restaurant ADDITIONALLY requires its
// identity.whatsapp_enabled === true (fail-safe: a failed/absent read → false → skip), giving it an
// independent per-restaurant kill switch.
async function isEnabledForRestaurant(db, restaurantId = 'x_pizza') {
  // x_pizza: EXACTLY isEnabled(db) — preserves its fail-OPEN default (read error → enabled),
  // byte-identical to the pre-C2 behavior. No identity read.
  if (restaurantId === 'x_pizza') return await isEnabled(db);

  // Non-x_pizza: BOTH reads fail-CLOSED (read error / absent → skip). The global flag is read here
  // directly (NOT via isEnabled, which fail-opens) so an unreadable global flag never lets a la_musa
  // send slip through.
  let globalOn;
  try {
    globalOn = (await db.ref('config/whatsapp_enabled').once('value')).val() !== false;
  } catch (e) {
    console.warn(`whatsapp: global flag read failed for ${restaurantId}, skipping send`, e.message);
    return false;
  }
  if (!globalOn) return false;
  try {
    const v = (await db.ref(`restaurants/${restaurantId}/identity/whatsapp_enabled`).once('value')).val();
    return v === true;
  } catch (e) {
    console.warn(`whatsapp: failed to read ${restaurantId} whatsapp_enabled, skipping send`, e.message);
    return false;
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

function trackingUrl(token, restaurantId = 'x_pizza') {
  const cfg = resolveWhatsappConfig(restaurantId);
  const base = (cfg && cfg.trackingBase) || TRACKING_BASE;
  return `${base}/${token}`;
}

function tplOrderReceived({ customerName, orderId, itemsText, total, trackingToken, restaurantId }) {
  return [
    `¡Hola ${customerName || ''}! 👋`,
    ``,
    `Recibimos tu pedido en ${brandFor(restaurantId)} ✅`,
    ``,
    `${itemsEmojiFor(restaurantId)} ${itemsText || ''}`,
    `💰 Total: L${total}`,
    ``,
    `Tu pedido está siendo preparado. Te avisamos cuando esté en camino 🛵`,
    ``,
    `Sigue tu pedido en tiempo real:`,
    trackingUrl(trackingToken, restaurantId),
    ``,
    `¡Gracias por preferirnos!`
  ].join('\n');
}

// Pickup confirmation. Used by createOrder when order_type === 'pickup'.
// pickupTime is either the literal string 'standard' (= ASAP, ~20 min) or
// a human-readable label like '6:00 PM–6:20 PM' selected by the customer
// from the schedule sheet on the order form.
function tplPickupReceived({ customerName, orderId, itemsText, total, pickupTime, trackingToken, restaurantId }) {
  const timeLine = pickupTime === 'standard'
    ? 'Estará listo en aproximadamente 20 minutos.'
    : `Hora de recogida: ${pickupTime}`;
  return [
    `¡Hola ${customerName || ''}! 👋`,
    ``,
    `Recibimos tu pedido en ${brandFor(restaurantId)} ✅`,
    ``,
    `${itemsEmojiFor(restaurantId)} ${itemsText || ''}`,
    `💰 Total: L${total}`,
    ``,
    `🏪 Recogida en restaurante`,
    timeLine,
    ``,
    `Te avisamos por WhatsApp cuando esté listo para recoger.`,
    ``,
    `Sigue tu pedido:`,
    trackingUrl(trackingToken, restaurantId),
    ``,
    `¡Gracias por preferirnos!`
  ].join('\n');
}

function tplDriverAssigned({ customerName, driverName, trackingToken, restaurantId }) {
  return [
    readyLineFor(restaurantId),
    ``,
    `${driverName || 'Nuestro repartidor'} sale ahora del restaurante con tu pedido${customerName ? ', ' + customerName : ''}.`,
    ``,
    `Sigue su ubicación:`,
    trackingUrl(trackingToken, restaurantId)
  ].join('\n');
}

function tplOutForDelivery({ driverName, etaMinutes, trackingToken, restaurantId }) {
  const eta = etaMinutes ? `\nLlegada estimada: ~${etaMinutes} min` : '';
  return [
    `🛵 ${driverName || 'Tu repartidor'} ya viene en camino${eta}`,
    ``,
    trackingUrl(trackingToken, restaurantId)
  ].join('\n');
}

function tplDelivered({ customerName, restaurantId }) {
  return [
    `✅ ¡Entregado!`,
    ``,
    `Esperamos que disfrutes tu ${brandFor(restaurantId)}${customerName ? ', ' + customerName : ''}.`,
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

// Pickup ready for collection (KDS Phase 2c). Sent by notifyPickupReady when a PICKUP order → 'ready'
// (the kitchen "Listo" tap), AT MOST ONCE per order. Per-restaurant brand/emoji/link resolve via
// resolveWhatsappConfig. The tracking link is INCLUDED when a token is present and OMITTED otherwise
// (never build a URL from an absent/bad token) — the core "listo para recoger" message still sends.
function tplPickupReady({ customerName, trackingToken, restaurantId }) {
  const lines = [
    `${itemsEmojiFor(restaurantId)} ¡Tu pedido está listo para recoger!`,
    ``,
    `${customerName ? '¡Hola ' + customerName + '! 👋 ' : ''}Ya puedes pasar por ${brandFor(restaurantId)} a recogerlo. 🏪`
  ];
  if (trackingToken) {
    lines.push(``, `Detalles:`, trackingUrl(trackingToken, restaurantId));
  }
  lines.push(``, `¡Gracias por preferirnos!`);
  return lines.join('\n');
}

module.exports = {
  sendMessage,
  isEnabled,
  isEnabledForRestaurant,
  resolveWhatsappConfig,
  brandFor,
  itemsEmojiFor,
  readyLineFor,
  trackingUrl,
  normalizePhone,
  tplOrderReceived,
  tplPickupReceived,
  tplDriverAssigned,
  tplOutForDelivery,
  tplDelivered,
  tplCancelled,
  tplPickupReady,
  TRACKING_BASE
};
