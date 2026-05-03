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

const ORDER_FORM_URL = 'https://xpizzaorders.netlify.app';
const TRACKING_BASE = 'https://xpizzatrack.netlify.app';
const RESTAURANT_NAME = 'X. Pizza';

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
function getHoursStatus(refDate = new Date()) {
  const { dayOfWeek, hours, minutes } = nowInHonduras(refDate);
  const today = HOURS[dayOfWeek];
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
    const next = HOURS[nextDay];
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

function tplGeneralInquiry({ isOpen, opensLabel }) {
  if (isOpen) {
    return [
      `¡Hola! 👋`,
      ``,
      `Para ver el menú y hacer tu pedido, visita:`,
      ORDER_FORM_URL,
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
    ORDER_FORM_URL,
    ``,
    `Y hacer tu pedido cuando abramos. ¡Gracias!`
  ].join('\n');
}

function tplStatusCheckFound({ trackingToken, customerName }) {
  const url = `${TRACKING_BASE}/${trackingToken}`;
  return [
    `${customerName ? '¡Hola ' + customerName + '! ' : ''}Aquí puedes seguir tu pedido en tiempo real:`,
    url
  ].join('\n');
}

function tplStatusCheckNotFound() {
  return [
    `No encontramos un pedido activo a tu nombre.`,
    ``,
    `Si acabas de ordenar, espera unos minutos — te avisaremos por aquí.`,
    ``,
    `Si quieres hacer un nuevo pedido: ${ORDER_FORM_URL}`
  ].join('\n');
}

function tplShortAck() {
  // Brief, warm, no link spam
  return `¡Con gusto! 🍕`;
}

function tplUnhandled({ isOpen, opensLabel }) {
  if (isOpen) {
    return [
      `Recibimos tu mensaje. Un empleado te responderá pronto.`,
      ``,
      `Si quieres hacer un pedido: ${ORDER_FORM_URL}`
    ].join('\n');
  }
  const opensSentence = opensLabel
    ? `Te responderemos cuando abramos ${opensLabel}.`
    : 'Te responderemos cuando abramos.';
  return [
    `Recibimos tu mensaje. Estamos cerrados ahora.`,
    `${opensSentence}`,
    ``,
    `Para ver el menú: ${ORDER_FORM_URL}`
  ].join('\n');
}

module.exports = {
  classify,
  getHoursStatus,
  nowInHonduras,
  tplGeneralInquiry,
  tplStatusCheckFound,
  tplStatusCheckNotFound,
  tplShortAck,
  tplUnhandled,
  ORDER_FORM_URL,
  RESTAURANT_NAME
};
