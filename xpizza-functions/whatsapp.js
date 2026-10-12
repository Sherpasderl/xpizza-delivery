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

// D12b — the customer-facing brand comes from the restaurant's OWN config (restaurants/{rid}/identity: display_name, else
// name — the same resolution as the tracker's pickup line), never a per-brand literal map. A branded template is a DEFERRED
// message (codex D12b r1 P2-1): tplX(args) returns a minted, frozen { name, args }; sendMessage — already async, already
// given the restaurant — resolves the brand and only THEN renders the template with `brand` as an explicit ARGUMENT. No
// text substitution ever runs over customer data (names, notes, inbound replies), so nothing a customer types, and no
// configured value, can be rewritten into a brand or leak a marker. When nothing names the restaurant each template uses
// its own neutral wording — never another brand's name. Plain strings are sent exactly as given, with no identity read.
const { brandOf, readLiveBrand } = require('./pickup-label');
const MINTED = new WeakSet();   // only messages minted by this module's tplX are rendered — a look-alike object is not
function defer(name, args) {
  const m = Object.freeze({ name, args: Object.freeze({ ...args }) });
  MINTED.add(m);
  return m;
}
const isDeferred = (m) => !!m && typeof m === 'object' && MINTED.has(m);
// The default reader: D12b's bounded, fail-soft live read of the identity's two names (two leaf reads per branded message —
// fine at this volume; no memo, so a fresh display_name is used at once).
function defaultReadBrand(restaurantId) {
  try { return readLiveBrand(require('firebase-admin/database').getDatabase(), restaurantId); } catch (_) { return Promise.resolve(null); }
}
// codex D12b r2: a LOGIN CODE never waits on branding. For the sync-only templates the brand is used only when it is already
// in hand — this instance's restaurant-config identity cache (no I/O) — else the neutral wording, immediately.
const SYNC_ONLY = new Set(['otp']);
// codex D12b r3: only a FRESH cache entry counts (within restaurant-config's own TTL, with a valid fetched_at) — a stale one
// could name a brand that was renamed since; it is treated as nothing in hand (neutral), still with no read.
function defaultPeekBrand(restaurantId, now = Date.now()) {
  const { _cache, TTL_MS } = require('./restaurant-config');
  const c = _cache.get(restaurantId);
  if (!c || !c.identity || !Number.isFinite(c.fetched_at) || !Number.isFinite(TTL_MS) || now - c.fetched_at >= TTL_MS || now < c.fetched_at) return null;
  return { display_name: c.identity.display_name, name: c.identity.name };
}
function peekBrand(restaurantId, { peekBrand: peek = defaultPeekBrand } = {}) {
  let live = null;
  try { live = peek(restaurantId); } catch (_) { live = null; }
  return brandOf(live && live.display_name, live && live.name);
}
async function resolveBrand(restaurantId, { readBrand = defaultReadBrand } = {}) {
  let live = null;
  try { live = await readBrand(restaurantId); } catch (_) { live = null; }
  return brandOf(live && live.display_name, live && live.name);   // the brand, or null → the template's neutral wording
}
// render a minted deferred message with a resolved brand (null → neutral wording); throws on anything else
function renderTemplate(msg, brand) {
  if (!isDeferred(msg)) throw new Error('whatsapp: renderTemplate needs a message minted by a tpl* function');
  const r = RENDERERS[msg.name];
  if (typeof r !== 'function') throw new Error(`whatsapp: unknown template ${msg.name}`);
  return r({ ...msg.args, brand: brand || null });
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
async function sendMessage(toPhone, body, restaurantId = 'x_pizza', deps = {}) {
  const cfg = resolveWhatsappConfig(restaurantId);
  if (!cfg || !cfg.apiBase || !cfg.token) {
    console.warn(`whatsapp: no UltraMsg config for restaurant '${restaurantId}', skipping send`);
    return null;
  }
  const normalized = normalizePhone(toPhone);
  if (!normalized) {
    return null;
  }
  if (isDeferred(body)) {   // D12b: brand first, then render — sync-only templates (the OTP) never await a read
    body = renderTemplate(body, SYNC_ONLY.has(body.name) ? peekBrand(restaurantId, deps) : await resolveBrand(restaurantId, deps));
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
 * POSITIVE provider-acceptance signal for a sendMessage RESULT.
 *
 * `sendMessage` returns `data` (the parsed UltraMsg JSON) on `resp.ok && !data.error`, but `resp.json()` is
 * `.catch(()=>({}))` — so an HTTP-200 with an unreadable/empty body yields a bare `{}` that is TRUTHY yet proves
 * NOTHING was accepted. Any caller that must record "the provider actually accepted this message" (e.g. the
 * paid-after-close refund notice, whose whole reliability rests on a truthful sent-marker) MUST gate on this,
 * never on `res != null`. A genuinely accepted UltraMsg send returns `sent:true`/`"true"` and/or a message `id`
 * (logged at the send site); `{}` has neither → NOT confirmed → the caller leaves its sent-marker unset so a
 * recovery sweep re-drives. Pure + exported so the acceptance semantics live in one tested place.
 */
function isSendConfirmed(result) {
  if (!result || typeof result !== 'object') return false;         // null (failure/skip) or non-object → not confirmed
  if (result.error) return false;                                  // defensive: an error body is never acceptance
  if (result.sent === true || result.sent === 'true') return true; // UltraMsg positive-accept flag (bool or string)
  const id = result.id;                                            // ...or a real message id
  if (typeof id === 'number' && Number.isFinite(id)) return true;
  if (typeof id === 'string' && id.trim() !== '') return true;
  return false;                                                    // bare {} / no id / no sent flag → UNCONFIRMED
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

function renderOrderReceived({ customerName, orderId, itemsText, total, trackingToken, restaurantId, brand }) {
  return [
    `¡Hola ${customerName || ''}! 👋`,
    ``,
    brand ? `Recibimos tu pedido en ${brand} ✅` : 'Recibimos tu pedido ✅',
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
function renderPickupReceived({ customerName, orderId, itemsText, total, pickupTime, trackingToken, restaurantId, brand }) {
  const timeLine = pickupTime === 'standard'
    ? 'Estará listo en aproximadamente 20 minutos.'
    : `Hora de recogida: ${pickupTime}`;
  return [
    `¡Hola ${customerName || ''}! 👋`,
    ``,
    brand ? `Recibimos tu pedido en ${brand} ✅` : 'Recibimos tu pedido ✅',
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

function renderDelivered({ customerName, restaurantId, brand }) {
  return [
    `✅ ¡Entregado!`,
    ``,
    `Esperamos que disfrutes ${brand || 'tu pedido'}${customerName ? ', ' + customerName : ''}.`,
    ``,
    `¿Algún problema con tu pedido? Responde a este mensaje y te ayudamos.`
  ].join('\n');
}

function renderCancelled({ orderId, restaurantId, brand }) {
  return [
    `Lamentamos avisarte que tu pedido${orderId ? ' #' + orderId : ''}${brand ? ' en ' + brand : ''} fue cancelado.`,
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
function renderPickupReady({ customerName, trackingToken, restaurantId, brand }) {
  const lines = [
    `${itemsEmojiFor(restaurantId)} ¡Tu pedido está listo para recoger!`,
    ``,
    `${customerName ? '¡Hola ' + customerName + '! 👋 ' : ''}Ya puedes pasar por ${brand || 'el restaurante'} a recogerlo. 🏪`
  ];
  if (trackingToken) {
    lines.push(``, `Detalles:`, trackingUrl(trackingToken, restaurantId));
  }
  lines.push(``, `¡Gracias por preferirnos!`);
  return lines.join('\n');
}

// Prep-time ETA (Fix A): a per-merchant CONFIG value (restaurants/<rid>/prep_eta_min) → minutes.
// PURE + brand-blind — takes ONLY the config value: a finite positive number is used as-is, anything else
// (absent / NaN / <=0 / non-number) falls back to a single neutral default. The per-brand numbers live in
// config (seeded 20 / 30), NEVER in code (brand-agnostic tenet). The DB read is caught by the caller
// (notifyPreparing) — a rejected read yields undefined here → the fallback.
const DEFAULT_PREP_ETA_MIN = 25;
function resolvePrepEtaMin(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0) ? value : DEFAULT_PREP_ETA_MIN;
}

// Proactive "preparando" message (Fix A). Sent by notifyPreparing on the `preparing` transition (kitchen
// "Empezar"), AT MOST ONCE per order. READINESS wording only — a prep-stage ETA cannot promise dispatch, so
// delivery points to the later "va en camino" instead of an arrival/departure time. Tracking link included
// when a token is present, OMITTED otherwise (never build a URL from an absent token) — like tplPickupReady.
function renderPreparing({ customerName, etaMinutes, orderType, trackingToken, restaurantId, brand }) {
  const readiness = orderType === 'pickup'
    ? `estará listo para recoger en ~${etaMinutes} min.`
    : `estará listo en ~${etaMinutes} min. Te avisamos apenas salga en camino.`;
  const lines = [
    `👨‍🍳 ¡Manos a la obra!`,
    ``,
    `${customerName ? '¡Hola ' + customerName + '! 👋 ' : ''}Estamos preparando tu pedido${brand ? ' en ' + brand : ''} — ${readiness}`
  ];
  if (trackingToken) {
    lines.push(``, `Sigue tu pedido:`, trackingUrl(trackingToken, restaurantId));
  }
  lines.push(``, `¡Gracias por preferirnos!`);
  return lines.join('\n');
}

// One-time code (requestOtp). codex D12b r1 P2-2: the brand comes from config like every other message.
function renderOtp({ code, brand }) {
  return `Tu código${brand ? ' de ' + brand : ''} es ${code}. Vence en 5 minutos. No lo compartas.`;
}

const RENDERERS = Object.freeze({
  orderReceived: renderOrderReceived, pickupReceived: renderPickupReceived, delivered: renderDelivered,
  cancelled: renderCancelled, pickupReady: renderPickupReady, preparing: renderPreparing, otp: renderOtp,
});
// the PUBLIC templates: each returns a deferred message that sendMessage renders after resolving the brand
const tplOrderReceived = (args) => defer('orderReceived', args);
const tplPickupReceived = (args) => defer('pickupReceived', args);
const tplDelivered = (args) => defer('delivered', args);
const tplCancelled = (args) => defer('cancelled', args);
const tplPickupReady = (args) => defer('pickupReady', args);
const tplPreparing = (args) => defer('preparing', args);
const tplOtp = (args) => defer('otp', args);

module.exports = {
  sendMessage,
  isSendConfirmed,
  isEnabled,
  isEnabledForRestaurant,
  resolveWhatsappConfig,
  tplOtp,
  renderTemplate,
  resolveBrand,
  isDeferred,
  defaultPeekBrand,
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
  tplPreparing,
  resolvePrepEtaMin,
  TRACKING_BASE
};
