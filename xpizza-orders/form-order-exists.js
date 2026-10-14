"use strict";
// ── form-order-exists — THE RECOVERY SCREEN FOR A TYPED `409 order_exists` REFUSAL, shared by every order form (G2) ──
//
// The server refuses to create an order whose id already exists, with ONE typed body (order-exists.js orderExistsBody):
//   409 { error: 'order_exists', reason, detail, order_id }.
// Instead of a generic error and a retry that fails the same way, the customer sees a calm recovery screen in stage s4:
// what happened, the order reference (#ABCD — the last 4 of the id, which is dispatch's FALLBACK label; dispatch shows
// the order's display_number when one is assigned), a button to write to THIS restaurant on WhatsApp (its own number, read
// from the page's existing contact line; the prefill carries the FULL id, the staff's lookup reference), and "Volver al
// pedido". The server's `detail` is never displayed. Nothing here touches the order id, the stash or any request: the
// caller's Back handler only returns to s2, and the existing id logic decides what the next send uses.
//
// Keyed STRICTLY to the typed error (status 409 + error 'order_exists'; any reason). Every other refusal keeps its own
// handling. Same bytes load as a classic browser script AND a Node module (no ESM), like the other shared form modules.

const OE_PREFIX = "Hola, tengo un problema con mi pedido ";

function isOrderExists(status, body) {
  return status === 409 && !!body && typeof body === "object" && body.error === "order_exists";
}

// "#" + the last 4 characters, uppercased; "" for an empty or non-string id.
function orderRef(orderId) {
  if (typeof orderId !== "string" || !orderId) return "";
  return "#" + orderId.slice(-4).toUpperCase();
}

// The page's OWN WhatsApp link (the contact line) + a prefill of the fixed text and the full id — nothing else. null when
// the page has no such link (the contact button is then hidden).
function storeContactHref(doc, orderId) {
  let a = null;
  try { a = doc.querySelector('.contact-line a[href^="https://wa.me/"]'); } catch (_) { a = null; }
  if (!a) return null;
  const base = String(a.getAttribute("href") || "").split("?")[0];
  if (!/^https:\/\/wa\.me\/[0-9]+$/.test(base)) return null;
  return base + "?text=" + encodeURIComponent(OE_PREFIX + String(orderId == null ? "" : orderId) + ".");
}

function els(doc) {
  const msg = doc.getElementById("sending-msg");
  return {
    block: doc.getElementById("order-exists-recovery"),
    ref: doc.getElementById("oe-ref"),
    contact: doc.getElementById("oe-contact"),
    back: doc.getElementById("oe-back"),
    msg,
    wrap: msg ? msg.parentElement : null,                 // the spinner + message container
    spinner: doc.querySelector("#s4 .spinner"),
  };
}

// Show the recovery screen for this refusal. The displayed values are set with textContent / an attribute only.
function renderOrderExists(doc, body, opts) {
  const e = els(doc);
  if (!e.block) return false;
  const id = body && typeof body.order_id === "string" ? body.order_id : "";
  if (e.ref) e.ref.textContent = orderRef(id);
  const href = storeContactHref(doc, id);
  if (e.contact) {
    if (href) { e.contact.setAttribute("href", href); e.contact.hidden = false; }
    else { e.contact.removeAttribute("href"); e.contact.hidden = true; }
  }
  if (e.spinner) e.spinner.hidden = true;
  if (e.msg) e.msg.hidden = true;
  if (e.wrap) e.wrap.hidden = true;
  if (e.back) e.back.onclick = function () { try { if (opts && typeof opts.onBack === "function") opts.onBack(); } catch (_) {} };
  e.block.hidden = false;
  return true;
}

// Hide the recovery screen and restore the sending view. A no-op when it is already hidden.
function resetOrderExists(doc) {
  const e = els(doc);
  if (e.block) e.block.hidden = true;
  if (e.spinner) e.spinner.hidden = false;
  if (e.msg) e.msg.hidden = false;
  if (e.wrap) e.wrap.hidden = false;
}

const OrderExists = { isOrderExists, orderRef, storeContactHref, renderOrderExists, resetOrderExists, OE_PREFIX };
if (typeof module !== "undefined" && module.exports) module.exports = OrderExists;
if (typeof window !== "undefined") { window.OrderExists = OrderExists; }
