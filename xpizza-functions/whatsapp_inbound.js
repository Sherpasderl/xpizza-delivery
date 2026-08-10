/**
 * X Pizza — Inbound WhatsApp classifier
 * version: 1.0.0
 *
 * Receives messages from UltraMsg webhook (someone wrote to X. Pizza
 * WhatsApp number). Classifies into intent buckets and produces an
 * appropriate auto-reply.
 *
 * Design principles:
 * - Conservative: when in doubt, send a polite generic reply rather than
 *   silence. Customers in Honduras EXPECT a fast WhatsApp response.
 * - Context-aware: short replies like "gracias" / emoji-only get a
 *   minimal acknowledgement, not a sales pitch.
 * - Never auto-reply to ourselves: skip if `from_me` flag is set.
 * - Operating hours aware: closed-hours messages include reopening time.
 */

// Per-restaurant inbound config (mirrors BRAND_BY_RESTAURANT in whatsapp.js). x_pizza values are the
// EXACT current literals EXCEPT orderFormUrl — migrated to orders.xpizza.hn (the one intended X. Pizza
// change). la_musa points to its own order form, tracker, brand, and ack emoji.
const CONFIG_BY_RESTAURANT = {
  x_pizza: { orderFormUrl: 'https://orders.xpizza.hn',  trackingBase: 'https://xpizzatrack.netlify.app', restaurantName: 'X. Pizza', ackEmoji: '🍕' },
  la_musa: { orderFormUrl: 'https://orders.lamusa.hn',  trackingBase: 'https://track.lamusa.hn',         restaurantName: 'La Musa',  ackEmoji: '🍜' }
};
const KNOWN_INBOUND_RESTAURANTS = Object.keys(CONFIG_BY_RESTAURANT);

// Resolve the restaurant an inbound message is for, from the ?restaurant= webhook query param. Absent /
// empty / unknown / malformed → 'x_pizza', so X. Pizza's existing webhook URL is byte-identical. The
// webhook's shared-secret check still gates every request; this only ROUTES an already-authenticated one.
function resolveInboundRestaurant(raw) {
  const r = typeof raw === 'string' ? raw.trim() : '';
  return KNOWN_INBOUND_RESTAURANTS.includes(r) ? r : 'x_pizza';
}
function configFor(restaurantId) { return CONFIG_BY_RESTAURANT[restaurantId] || CONFIG_BY_RESTAURANT.x_pizza; }

// True when a NON-EMPTY ?restaurant= param didn't resolve to a known restaurant (→ x_pizza fail-safe).
// The caller console.warns on this to surface a mis-wired webhook URL instead of silently serving x_pizza
// replies. Aligned with resolveInboundRestaurant: absent/empty → false (legit default), non-string → true.
function isUnrecognizedRestaurantParam(raw) {
  if (raw == null || raw === '') return false;
  if (typeof raw !== 'string') return true;
  const r = raw.trim();
  return r !== '' && !KNOWN_INBOUND_RESTAURANTS.includes(r);
}

// Operating hours (Honduras / America/Tegucigalpa, UTC-6, no DST)
// Day index: 0=Sunday, 1=Monday, ..., 6=Saturday
// open/close in 24h "HH:MM" local Honduras time. null = closed all day.
const HOURS = {
  0: { open: '12:00', close: '19:45' },  // Domingo
  1: { open: '12:00', close: '19:45' },  // Lunes
  2: { open: '12:00', close: '19:45' },  // Martes
  3: { open: '12:00', close: '19:45' },  // Miércoles
  4: { open: '12:00', close: '20:45' },  // Jueves
  5: { open: '12:00', close: '20:45' },  // Viernes
  6: { open: '12:00', close: '20:45' }   // Sábado
};

// Day names for the closed message
const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// Convert a UTC timestamp to Honduras local time pieces (UTC-6, no DST).
// We don't use Intl.DateTimeFormat because it pulls in tz data weirdly in
// Cloud Functions; manual offset is reliable and explicit.
function nowInHonduras(refDate = new Date()) {
  const utcMs = refDate.getTime();
  const localMs = utcMs - (6 * 60 * 60 * 1000);
  const local = new Date(localMs);
  return {
    dayOfWeek: local.getUTCDay(),       // 0..6
    hours: local.getUTCHours(),         // 0..23
    minutes: local.getUTCMinutes(),
    timestampLocal: local
  };
}

// Returns { isOpen, opensAt, opensLabel } based on current Honduras time.
// opensAt: a Date when we'll be open next (or null if currently open).
// opensLabel: human string like "hoy a las 12:00 PM" or "mañana a las 12:00 PM"
function getHoursStatus(refDate = new Date(), hoursMap = HOURS) {
  const { dayOfWeek, hours, minutes } = nowInHonduras(refDate);
  const today = hoursMap[dayOfWeek];
  const minutesNow = hours * 60 + minutes;

  if (today) {
    const [oh, om] = today.open.split(':').map(Number);
    const [ch, cm] = today.close.split(':').map(Number);
    const openMin = oh * 60 + om;
    const closeMin = ch * 60 + cm;
    if (minutesNow >= openMin && minutesNow < closeMin) {
      return { isOpen: true, opensAt: null, opensLabel: null };
    }
    if (minutesNow < openMin) {
      // Closed but will open later today
      return {
        isOpen: false,
        opensLabel: `hoy a las ${formatTime12(today.open)}`
      };
    }
  }

  // After today's close (or all of today off) → find the next open day
  for (let i = 1; i <= 7; i++) {
    const nextDay = (dayOfWeek + i) % 7;
    const next = hoursMap[nextDay];
    if (next) {
      const dayLabel = i === 1 ? 'mañana' : `el ${DAY_NAMES[nextDay]}`;
      return {
        isOpen: false,
        opensLabel: `${dayLabel} a las ${formatTime12(next.open)}`
      };
    }
  }
  return { isOpen: false, opensLabel: null };
}

// "12:00" → "12:00 PM" / "19:45" → "7:45 PM"
function formatTime12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const displayHr = ((h % 12) || 12);
  return `${displayHr}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Convert identity.hours (RTDB config: { mon:{open:bool,start:"HH:MM",end:"HH:MM"}, ... }) to the
// day-index/open-close shape getHoursStatus expects. This is the SINGLE SOURCE for la_musa's inbound
// hours — no hardcoded duplication, so the auto-reply can't drift from the identity config. A closed or
// malformed day → null (getHoursStatus treats null as closed). x_pizza keeps its own hardcoded HOURS.
const IDENTITY_DAY_ABBR = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']; // index 0..6 (getUTCDay)
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;  // strict 24h HH:MM (00:00–23:59)
function hoursFromIdentity(identityHours) {
  const out = {};
  for (let i = 0; i < 7; i++) {
    const h = identityHours && identityHours[IDENTITY_DAY_ABBR[i]];
    // Validate HH:MM — a truthy-but-MALFORMED start/end degrades to null (closed), never passes through
    // to getHoursStatus where a bad value could misparse. (RegExp.test coerces non-strings → false.)
    out[i] = (h && h.open === true && HHMM_RE.test(h.start) && HHMM_RE.test(h.end)) ? { open: h.start, close: h.end } : null;
  }
  return out;
}

// ============================================================
// CLASSIFIER
// ============================================================
//
// Three intent buckets:
//   STATUS_CHECK  — asking about an existing order
//   GENERAL_INQUIRY — wants to order, asking about menu/prices/hours
//   SHORT_ACK — "gracias", "ok", emoji, very short — no sales pitch
//   UNHANDLED — doesn't match any keyword, polite generic reply + flag for human

const STATUS_KEYWORDS = [
  // Phrases (matched first, more specific)
  'mi pedido', 'mi orden', 'donde esta', 'donde está', 'dónde está',
  'ya viene', 'cuanto tiempo', 'cuánto tiempo', 'cuanto tarda', 'cuánto tarda',
  'cuanto demora', 'cuánto demora',
  // Single words
  'repartidor', 'motorista', 'tracking'
];

const GENERAL_KEYWORDS = [
  // Greetings
  'hola', 'buenas', 'buenas tardes', 'buenas noches', 'buenos dias', 'buenos días',
  'hi', 'hey', 'hello',
  // Order intent
  'quiero', 'ordenar', 'orden', 'pedido', 'pedir',
  // Product questions
  'pizza', 'pizzas', 'menu', 'menú', 'sabores', 'tamaño', 'tamaños',
  'tienen', 'combo', 'combos', 'bebidas',
  // Pricing
  'precio', 'precios', 'cuesta', 'cuanto', 'cuánto', 'oferta', 'ofertas',
  // Delivery
  'envio', 'envío', 'delivery', 'domicilio', 'cobertura', 'llegan',
  // Payment
  'pago', 'pagos', 'tarjeta', 'efectivo', 'transferencia',
  // Hours
  'horario', 'horarios', 'abierto', 'abiertos', 'cerrado', 'cuando abren',
  'hasta que hora', 'a que hora',
  // Information
  'informacion', 'información', 'info'
];

// Short-ack patterns: short messages, common pleasantries, emoji-only
const SHORT_ACK_PATTERNS = [
  /^gracias\b/i,
  /^muchas gracias\b/i,
  /^mil gracias\b/i,
  /^ok+\b/i,
  /^vale\b/i,
  /^bueno\b/i,
  /^👍$/u, /^❤️$/u, /^🙏$/u, /^✅$/u, /^🍕$/u, /^😊$/u, /^😀$/u, /^😁$/u
];

/**
 * Classify a message body into one of: STATUS_CHECK, GENERAL_INQUIRY,
 * SHORT_ACK, UNHANDLED. Returns the bucket name.
 */
function classify(body) {
  if (!body || typeof body !== 'string') return 'UNHANDLED';
  const text = body.trim();
  if (!text) return 'UNHANDLED';
  const lower = text.toLowerCase();

  // Short-ack first (catch "gracias" before keyword scan)
  for (const pat of SHORT_ACK_PATTERNS) {
    if (pat.test(text)) return 'SHORT_ACK';
  }
  // Anything ≤ 4 chars that contains an emoji or is a one-word pleasantry
  if (text.length <= 4 && !/[a-záéíóúñ0-9]/i.test(text)) return 'SHORT_ACK';

  // Status check (more specific, check before general)
  for (const kw of STATUS_KEYWORDS) {
    if (lower.includes(kw)) return 'STATUS_CHECK';
  }

  // General inquiry — keyword match
  for (const kw of GENERAL_KEYWORDS) {
    // Word-boundary-ish match: the keyword should be a "whole token" in the
    // message. Use simple boundary detection — Spanish word chars + accents.
    const re = new RegExp(`(^|[^a-záéíóúñ])${escapeRegex(kw)}([^a-záéíóúñ]|$)`, 'i');
    if (re.test(lower)) return 'GENERAL_INQUIRY';
  }

  return 'UNHANDLED';
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================
// REPLY TEMPLATES
// ============================================================

function tplGeneralInquiry(cfg, { isOpen, opensLabel }) {
  if (isOpen) {
    return [
      `¡Hola! 👋`,
      ``,
      `Para ver el menú y hacer tu pedido, visita:`,
      cfg.orderFormUrl,
      ``,
      `Si tienes una pregunta sobre un pedido existente, respóndenos aquí.`
    ].join('\n');
  }
  // Closed
  const opensSentence = opensLabel
    ? `Abrimos ${opensLabel}.`
    : 'Volvemos a abrir pronto.';
  return [
    `¡Hola! 👋`,
    ``,
    `Estamos cerrados ahora. ${opensSentence}`,
    ``,
    `Mientras tanto, puedes ver el menú en:`,
    cfg.orderFormUrl,
    ``,
    `Y hacer tu pedido cuando abramos. ¡Gracias!`
  ].join('\n');
}

function tplStatusCheckFound(cfg, { trackingToken, customerName }) {
  const url = `${cfg.trackingBase}/${trackingToken}`;
  return [
    `${customerName ? '¡Hola ' + customerName + '! ' : ''}Aquí puedes seguir tu pedido en tiempo real:`,
    url
  ].join('\n');
}

function tplStatusCheckNotFound(cfg) {
  return [
    `No encontramos un pedido activo a tu nombre.`,
    ``,
    `Si acabas de ordenar, espera unos minutos — te avisaremos por aquí.`,
    ``,
    `Si quieres hacer un nuevo pedido: ${cfg.orderFormUrl}`
  ].join('\n');
}

function tplShortAck(cfg) {
  // Brief, warm, no link spam
  return `¡Con gusto! ${cfg.ackEmoji}`;
}

function tplUnhandled(cfg, { isOpen, opensLabel }) {
  if (isOpen) {
    return [
      `Recibimos tu mensaje. Un colaborador te responderá pronto.`,
      ``,
      `Si quieres hacer un pedido: ${cfg.orderFormUrl}`
    ].join('\n');
  }
  const opensSentence = opensLabel
    ? `Te responderemos cuando abramos ${opensLabel}.`
    : 'Te responderemos cuando abramos.';
  return [
    `Recibimos tu mensaje. Estamos cerrados ahora.`,
    `${opensSentence}`,
    ``,
    `Para ver el menú: ${cfg.orderFormUrl}`
  ].join('\n');
}

// ── Auto-mute helpers (Path A) ──────────────────────────────────────────────
// When a human staff member replies to a customer from the WhatsApp app, suppress the bot's
// auto-reply to that customer for a window so the bot doesn't talk over the human. Pure — the
// admin RTDB reads/writes live in onIncomingWhatsApp.

// The mute leaf key for a phone: the SAME last-8-digit suffix the order-matching uses
// (fromPhoneRaw.slice(-8)), so the inbound `data.from` key and the outbound `data.to` key resolve
// to ONE leaf per customer. Strips a trailing @c.us (harmless if already stripped). '' on empty
// input (the caller skips the write) — and last-8-digits is always a valid RTDB key.
function muteKeyFor(phone) {
  return String(phone == null ? '' : phone).replace(/@c\.us$/, '').slice(-8);
}

// A HUMAN staff app-reply worth muting on, vs the bot's own API send. UltraMsg marks any outbound
// fromMe:true; self:false = typed by a person in the app, self:true = sent by our API (the bot).
// Strict === false so a missing `self` is treated as NOT-human (safe: never self-mutes the bot).
function isHumanOutbound(data) {
  return !!data && data.fromMe === true && data.self === false;
}

// Suppress the auto-reply iff a fresh human-handling mark exists within the window.
function shouldSuppressAutoReply(muteRecord, now, windowMs) {
  return !!muteRecord && Number.isFinite(muteRecord.at) && (now - muteRecord.at) < windowMs;
}

// The live mute window (ms) from config, or a 10-min default on unset / non-finite / non-positive.
function resolveMuteWindowMs(configVal) {
  const n = Number(configVal);
  return (Number.isFinite(n) && n > 0) ? n : 10 * 60 * 1000;
}

// Paid-after-close AUTO-REFUND customer message (owner-approved copy). Brand-aware sign-off: La Musa
// carries no pizza emoji (per the no-emoji-in-form-chrome design rule); X. Pizza keeps the 🍕 sign-off
// (OS notification text, not UI chrome). `total` is the whole-lempira refunded amount.
function tplPaidAfterCloseRefunded({ customerName, total, restaurantId }) {
  const hi = customerName ? `Hola ${customerName}, ` : '';
  const signoff = restaurantId === 'la_musa' ? '¡Te esperamos mañana!' : '¡Te esperamos mañana! 🍕';
  return `${hi}recibimos tu pago pero nuestra cocina ya está cerrada. Te reembolsamos L${total} completos — no se te cobrará. ${signoff}`;
}

module.exports = {
  classify,
  tplPaidAfterCloseRefunded,
  muteKeyFor,
  isHumanOutbound,
  shouldSuppressAutoReply,
  resolveMuteWindowMs,
  getHoursStatus,
  hoursFromIdentity,
  nowInHonduras,
  resolveInboundRestaurant,
  isUnrecognizedRestaurantParam,
  configFor,
  tplGeneralInquiry,
  tplStatusCheckFound,
  tplStatusCheckNotFound,
  tplShortAck,
  tplUnhandled,
  CONFIG_BY_RESTAURANT
};
