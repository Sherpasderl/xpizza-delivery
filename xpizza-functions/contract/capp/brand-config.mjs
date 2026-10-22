// CUSTOMER APP S0-test — THE INERT BRAND-CONFIG PLUMBING (PLAN-shared-order-form.FINAL §5 S0).
//
// What this is: the per-restaurant config the shared renderer will be driven by, DERIVED FROM THE LIVE
// FORKS so the parity harness can be keyed by data instead of by folder name. It is the same shape
// S0-prod's RESTAURANT_CONFIG takes; S0-prod swaps the SOURCE (from "read the running page" to the
// authored config) and the goldens built on top of it prove nothing moved.
//
// What this is NOT: production code. No page loads it, nothing under xpizza-orders/ or la-musa-orders/
// references it, and the validator below is called only by tests. That is what "inert" means here.
//
// 🔴 RUNTIME FIRST. Every value that the running page exposes is read FROM THE RUNNING PAGE (the shared
// jsdom harness executes the real form), never from a regex over its source. Structural tests that read
// source text have passed while the runtime disagreed three times on this project. A value that only
// exists as an inline literal (the pending-pay storage key) falls back to source text, and that fallback
// throws unless the pattern matches EXACTLY ONCE: zero matches and two matches are both errors, never a
// silent first-match.

export const SCHEMA = 'capp-restaurant-config/s0';
const PAY = ['cash', 'online'];
const FIELDS = ['schema', 'restaurant_id', 'form', 'identity', 'branding', 'map', 'hours', 'min_order_lempiras',
  'payment_methods', 'uses_platform_factura', 'rewards', 'order_id', 'storage_keys', 'copy', 'contact'];

// The one source-text fallback: exactly one match, or a loud error naming what was looked for.
export function exactlyOne(src, re, label) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const all = [...src.matchAll(g)];
  if (all.length !== 1) throw new Error(`capp brand-config: ${label} — expected exactly ONE match of ${re}, found ${all.length}`);
  return all[0];
}

// One value that several runtime places carry must agree everywhere it appears, or it is not one value.
function agreed(values, label) {
  const set = [...new Set(values)];
  if (set.length !== 1) throw new Error(`capp brand-config: ${label} — the page carries ${set.length} different values: ${JSON.stringify(set)}`);
  return set[0];
}

/* Derive one brand's config from its RUNNING page. `w` is a window from form-harness loadForm(dir) that has
   not been driven yet (fresh boot), `html` is that page's index.html source (for the single fallback). */
export function deriveBrandConfig(w, { dir, html }) {
  const ev = (expr) => w.eval(expr);
  const A = w.__ACCOUNT && w.__ACCOUNT.CONFIG;
  if (!A) throw new Error(`capp brand-config: ${dir} — window.__ACCOUNT.CONFIG is absent (account.js did not run)`);
  const doc = w.document;

  const pageRid = ev("typeof RESTAURANT_ID !== 'undefined' ? RESTAURANT_ID : null");
  const menuRid = ev('liveMenuRid()');
  const rid = agreed([A.restaurant_id, menuRid].concat(pageRid === null ? [] : [pageRid]), `${dir} restaurant id (account CONFIG / liveMenuRid / RESTAURANT_ID)`);

  const store = [...doc.querySelectorAll('.pickup-store-name')].map((e) => e.textContent.trim());
  const wa = [...doc.querySelectorAll('a[href^="https://wa.me/"]')].map((a) => a.getAttribute('href').slice('https://wa.me/'.length));
  const pays = [...new Set([...doc.querySelectorAll('[onclick*="selectPay("]')].map((e) => (/selectPay\('([a-z]+)'\)/.exec(e.getAttribute('onclick')) || [])[1]).filter(Boolean))].sort();

  // The order-id prefix, from the page's OWN minter.
  const minted = ev('genOrderId()');
  const pre = /^([A-Z]+-)/.exec(minted);
  if (!pre) throw new Error(`capp brand-config: ${dir} — genOrderId() minted ${JSON.stringify(minted)}, which carries no PREFIX-`);

  // The error noun, from the page's OWN empty-cart refusal (goToLocation on a fresh, empty cart).
  ev('goToLocation()');
  const errText = (doc.getElementById('err1') || {}).textContent || '';
  const noun = /^Seleccioná al menos (?:una|un) (.+)\.$/.exec(errText.trim());
  if (!noun) throw new Error(`capp brand-config: ${dir} — the empty-cart refusal read ${JSON.stringify(errText)}; no noun`);
  ev("document.getElementById('err1').style.display='none'; document.getElementById('err1').textContent=''");

  const hours = {};
  const H = ev('HOURS');
  for (let d = 0; d < 7; d++) hours[d] = H[d] ? { open: H[d].open, close: H[d].close } : null;

  // FALLBACK (source text): the pending-pay key is an inline literal with no runtime handle.
  const pend = exactlyOne(html, /localStorage\.setItem\('([a-z0-9_]+_pending_pay)'/, `${dir} pending-pay storage key`)[1];

  return {
    schema: SCHEMA,
    restaurant_id: rid,
    form: { dir, page_restaurant_id: pageRid, menu_rid: menuRid },
    identity: { display_name: A.brand, title: doc.title, pickup_store_name: agreed(store, `${dir} pickup store name`) },
    branding: { accent: A.accent, palette: { ...A.palette } },
    map: { lat: ev('RESTAURANT_LAT'), lng: ev('RESTAURANT_LNG'), radius_km: ev('DELIVERY_RADIUS_KM') },
    hours,
    min_order_lempiras: ev('MIN_ORDER'),
    payment_methods: pays,
    uses_platform_factura: null,          // a SERVER capability (factura/eligibility.js); never derived from a client
    rewards: { kind: A.rewards && A.rewards.kind },
    order_id: { prefix: pre[1] },
    storage_keys: { pending_pay: pend, account_marker: A.MARKER },
    copy: { error_noun: noun[1] },
    contact: { whatsapp: agreed(wa, `${dir} WhatsApp number`) },
  };
}

// The inert validator. Mirrors the RESTAURANT_CONFIG shape; strict keys; called only by tests.
export function validateRestaurantConfig(c) {
  const bad = [];
  const need = (cond, msg) => { if (!cond) bad.push(msg); };
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  const fin = (n) => typeof n === 'number' && Number.isFinite(n);
  const str = (s) => typeof s === 'string' && s.length > 0;
  if (!isObj(c)) return ['config is not an object'];
  for (const k of Object.keys(c)) need(FIELDS.includes(k), `unknown key ${k}`);
  for (const k of FIELDS) need(Object.prototype.hasOwnProperty.call(c, k), `missing key ${k}`);
  need(c.schema === SCHEMA, `schema ${JSON.stringify(c.schema)}`);
  need(typeof c.restaurant_id === 'string' && /^[a-z][a-z0-9_]*$/.test(c.restaurant_id), 'restaurant_id');
  need(isObj(c.form) && str(c.form.dir) && c.form.menu_rid === c.restaurant_id && (c.form.page_restaurant_id === null || c.form.page_restaurant_id === c.restaurant_id), 'form');
  need(isObj(c.identity) && str(c.identity.display_name) && str(c.identity.title) && str(c.identity.pickup_store_name), 'identity');
  need(isObj(c.branding) && /^#[0-9A-Fa-f]{6}$/.test(c.branding.accent || '') && isObj(c.branding.palette) && Object.values(c.branding.palette).every((v) => /^#[0-9A-Fa-f]{6}$/.test(v)), 'branding');
  need(isObj(c.map) && fin(c.map.lat) && Math.abs(c.map.lat) <= 90 && fin(c.map.lng) && Math.abs(c.map.lng) <= 180 && fin(c.map.radius_km) && c.map.radius_km > 0, 'map');
  need(isObj(c.hours) && [0, 1, 2, 3, 4, 5, 6].every((d) => c.hours[d] === null || (isObj(c.hours[d]) && Number.isInteger(c.hours[d].open) && Number.isInteger(c.hours[d].close) && c.hours[d].open >= 0 && c.hours[d].open < c.hours[d].close && c.hours[d].close <= 1440)) && Object.keys(c.hours).length === 7, 'hours');
  need(fin(c.min_order_lempiras) && c.min_order_lempiras >= 0, 'min_order_lempiras');
  need(Array.isArray(c.payment_methods) && c.payment_methods.length > 0 && c.payment_methods.every((p) => PAY.includes(p)), 'payment_methods');
  need(c.uses_platform_factura === null, 'uses_platform_factura must stay null client-side (server capability)');
  need(isObj(c.rewards) && ['punch', 'points'].includes(c.rewards.kind), 'rewards');
  need(isObj(c.order_id) && /^[A-Z]{2,5}-$/.test(c.order_id.prefix || ''), 'order_id');
  need(isObj(c.storage_keys) && /^[a-z0-9_]+_pending_pay$/.test(c.storage_keys.pending_pay || '') && /^[a-z0-9_]+$/.test(c.storage_keys.account_marker || ''), 'storage_keys');
  need(isObj(c.copy) && str(c.copy.error_noun), 'copy');
  need(isObj(c.contact) && /^\d{8,15}$/.test(c.contact.whatsapp || ''), 'contact');
  return bad;
}
