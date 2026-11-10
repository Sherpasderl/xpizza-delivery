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
export async function deriveBrandConfig(w, { dir, html }) {
  const ev = (expr) => w.eval(expr);
  const A = w.__ACCOUNT && w.__ACCOUNT.CONFIG;
  if (!A) throw new Error(`capp brand-config: ${dir} — window.__ACCOUNT.CONFIG is absent (account.js did not run)`);
  const doc = w.document;

  const pageRid = ev("typeof RESTAURANT_ID !== 'undefined' ? RESTAURANT_ID : null");
  const menuRid = ev('liveMenuRid()');
  const rid = agreed([A.restaurant_id, menuRid].concat(pageRid === null ? [] : [pageRid]), `${dir} restaurant id (account CONFIG / liveMenuRid / RESTAURANT_ID)`);

  const store = [...doc.querySelectorAll('.pickup-store-name')].map((e) => e.textContent.trim());
  const wa = [...doc.querySelectorAll('a[href^="https://wa.me/"]')].map((a) => a.getAttribute('href').slice('https://wa.me/'.length));
  // Payment methods, from the RUNTIME handlers: every element whose handler names selectPay is clicked with
  // selectPay temporarily replaced by a recorder; each click must make exactly ONE call with one string.
  // A handler that calls it differently, twice, or not at all THROWS — nothing is skipped.
  const payEls = [...doc.querySelectorAll('[onclick*="selectPay"]')];
  if (!payEls.length) throw new Error(`capp brand-config: ${dir} — no element's handler names selectPay`);
  const realPay = w.selectPay; const payCalls = [];
  w.selectPay = function () { payCalls.push(Array.from(arguments)); };
  const payList = [];
  try {
    for (const el of payEls) {
      const before = payCalls.length;
      el.dispatchEvent(new w.MouseEvent('click', { bubbles: false, cancelable: true }));
      const mine = payCalls.slice(before);
      if (mine.length !== 1 || mine[0].length !== 1 || typeof mine[0][0] !== 'string') throw new Error(`capp brand-config: ${dir} — a selectPay handler (${el.getAttribute('onclick')}) made ${JSON.stringify(mine)} instead of exactly one selectPay(<string>)`);
      payList.push(mine[0][0]);
    }
  } finally { w.selectPay = realPay; }
  const pays = [...new Set(payList)].sort();

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

  // The pending-pay key: OBSERVED at runtime — the page's own hosted-checkout path is driven to the point where
  // it stashes the order (see observePendingPayKey). Before S0-prod this was an inline literal read by an
  // exactly-one source fallback; the observed key must equal what that fallback read (pinned by the golden).
  const pend = await observePendingPayKey(w, dir);

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

/* Drive the page's REAL card path on this (fresh) window just far enough for it to stash the pending order:
   one priced dish, contact fields, selectPay('online'), processPixelPay(), and a hosted-checkout reply. Every
   localStorage write is recorded; the key whose value carries this probe's poll token is the pending-pay key,
   and there must be exactly ONE. The redirect that follows is jsdom's unimplemented navigation (harmless).
   Call it LAST on a window: it leaves a cart and a sent order behind. */
export async function observePendingPayKey(w, dir) {
  const TOKEN = 'capp-probe-poll-token';
  const writes = [];
  // Storage.prototype, not the instance: assigning to localStorage.setItem would STORE an item named "setItem".
  const proto = w.Storage.prototype; const realSet = proto.setItem;
  proto.setItem = function (k, v) { writes.push([String(k), String(v)]); return realSet.call(this, k, v); };
  const prevRespond = w.__respond;
  w.__respond = (url, init) => {
    if (/\/chargeOnlineOrder$/.test(String(url))) {
      const body = JSON.parse(init.body);
      const cfg = { ok: true, order_id: body.order_id, poll_token: TOKEN, checkout_url: 'https://pay.invalid/capp-probe' };
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(cfg), text: () => Promise.resolve(JSON.stringify(cfg)), clone() { return this; } });
    }
    return prevRespond(url, init);
  };
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); };
  try {
    const dish = w.liveMenuGlobalGet('MENU').find((d) => d.price > 0);
    if (!dish) throw new Error(`capp brand-config: ${dir} — no priced dish to drive the card path`);
    w.chg(dish.id, 1); await tick();
    for (const [id, v] of [['cname', 'Cliente Prueba'], ['cphone', '98765432']]) w.document.getElementById(id).value = v;
    w.selectPay('online'); await tick();
    if (w.buildOrder() !== true) throw new Error(`capp brand-config: ${dir} — the page refused to compose the probe order`);
    const p = w.processPixelPay(); if (p && p.catch) p.catch(() => {});
    await tick(); await tick();
  } finally { proto.setItem = realSet; w.__respond = prevRespond; }
  const hits = [...new Set(writes.filter(([, v]) => v.includes(TOKEN)).map(([k]) => k))];
  if (hits.length !== 1) throw new Error(`capp brand-config: ${dir} — expected the hosted-checkout path to stash under exactly ONE key, saw ${JSON.stringify(hits)} (all writes: ${JSON.stringify(writes.map(([k]) => k))})`);
  return hits[0];
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

// ── S0-prod: THE LIVE INLINE RESTAURANT-CONFIG BLOCK ──────────────────────────────────────────────────────
// Each live form carries its restaurant's DATA as the FIRST LINES of the page's existing first inline <script> (so no
// script element is added and every <script@N> ordinal stays put), between two exact marker lines:
//   /* RESTAURANT-CONFIG:BEGIN — … */
//   window.RESTAURANT_CONFIG = Object.freeze({ … Object.freeze({…}) … });
//   /* RESTAURANT-CONFIG:END */
// configBlockLines() is the ONE emitter (the forms' lines and the third brand's are both its output: pure data, every
// nested object frozen explicitly, no computed access). readInlineConfig() finds the block (exactly once, as the first
// statement of the first inline script, before any reader) and EXECUTES it in an isolated vm with an empty `window`,
// so the value under test is what the browser builds. validateLiveConfig() is the strict live schema; it refuses any
// factura-like field outright. Key names avoid the order-field vocabulary the R3 census tracks (`rid`, `latitude`,
// `longitude`; not lat/lng/hub_lat/hub_lng, which orders carry — the status→httpStatus collision rule).
import vm from 'node:vm';
export const LIVE_SCHEMA = 'sherpa-restaurant-config/1';
export const CONFIG_BEGIN = "/* RESTAURANT-CONFIG:BEGIN — this restaurant's DATA (PLAN-shared-order-form §5 S0-prod). Read by this page and account.js; validated by capp-s0prod-config.test.mjs. Data only: never code, never a factura flag (that is a server capability). */";
export const CONFIG_END = '/* RESTAURANT-CONFIG:END */';
const LIVE_FIELDS = ['schema', 'rid', 'display_name', 'branding', 'map', 'hours', 'min_order_lempiras', 'payment_methods',
  'rewards', 'order_id_prefix', 'storage_keys', 'empty_cart_noun', 'item_key'];

const lit = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `Object.freeze([${v.map(lit).join(',')}])`;
  return `Object.freeze({${Object.entries(v).map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}:${lit(x)}`).join(',')}})`;
};
export function configBlockLines(cfg) { return [CONFIG_BEGIN, `window.RESTAURANT_CONFIG = ${lit(cfg)};`, CONFIG_END]; }

export function readInlineConfig(html, label = 'page') {
  const lines = html.split('\n');
  const at = (t) => lines.map((l, i) => (l === t ? i : -1)).filter((i) => i >= 0);
  const b = at(CONFIG_BEGIN), e = at(CONFIG_END);
  if (b.length !== 1 || e.length !== 1) throw new Error(`capp live config: ${label} — expected exactly ONE RESTAURANT-CONFIG BEGIN/END pair, found ${b.length}/${e.length}`);
  if (e[0] !== b[0] + 2) throw new Error(`capp live config: ${label} — the block must be BEGIN, one assignment line, END`);
  // the FIRST statement of the page's FIRST inline script: the line before BEGIN opens it, and no inline script precedes it
  const firstInline = lines.findIndex((l) => /^<script>\s*$/.test(l));
  if (firstInline < 0 || firstInline !== b[0] - 1) throw new Error(`capp live config: ${label} — the block is not the first statement of the page's first inline <script> (opens at line ${firstInline + 1}, block at ${b[0] + 1})`);
  const before = lines.slice(0, b[0]).join('\n');
  if (/RESTAURANT_CONFIG/.test(before) || /<script[^>]*src="account\.js"/.test(before)) throw new Error(`capp live config: ${label} — a reader precedes the block`);
  const line = lines[b[0] + 1];
  if (!/^window\.RESTAURANT_CONFIG = Object\.freeze\(\{.*\}\);$/.test(line)) throw new Error(`capp live config: ${label} — the block's line is not a single frozen assignment`);
  const sandbox = { window: {}, Object };
  vm.runInNewContext(line, sandbox, { timeout: 1000 });
  const cfg = sandbox.window.RESTAURANT_CONFIG;
  if (!cfg || typeof cfg !== 'object') throw new Error(`capp live config: ${label} — the block did not define window.RESTAURANT_CONFIG`);
  if (line !== configBlockLines(JSON.parse(JSON.stringify(cfg)))[1]) throw new Error(`capp live config: ${label} — the block is not the canonical emitter's output (hand-edited?)`);
  return { index: b[0] + 1, line, config: cfg };
}

const deepFrozen = (o) => !(o && typeof o === 'object') || (Object.isFrozen(o) && Object.values(o).every(deepFrozen));

export function validateLiveConfig(c) {
  const bad = [];
  const need = (cond, msg) => { if (!cond) bad.push(msg); };
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  const fin = (n) => typeof n === 'number' && Number.isFinite(n);
  const str = (s) => typeof s === 'string' && s.length > 0;
  if (!isObj(c)) return ['config is not an object'];
  const walk = (o, p) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (/factura|fiscal|rtn|isv/i.test(k)) bad.push(`factura-like field ${p}${k}: factura is a SERVER capability, never client config`); walk(v, `${p}${k}.`); } };
  walk(c, '');
  need(deepFrozen(c), 'not deep-frozen');
  for (const k of Object.keys(c)) need(LIVE_FIELDS.includes(k), `unknown key ${k}`);
  for (const k of LIVE_FIELDS) need(Object.prototype.hasOwnProperty.call(c, k), `missing key ${k}`);
  need(c.schema === LIVE_SCHEMA, 'schema');
  need(typeof c.rid === 'string' && /^[a-z][a-z0-9_]*$/.test(c.rid), 'rid');
  need(str(c.display_name), 'display_name');
  need(isObj(c.branding) && /^#[0-9A-Fa-f]{6}$/.test(c.branding.accent || '') && isObj(c.branding.palette) && Object.keys(c.branding).length === 2 && Object.values(c.branding.palette).every((v) => /^#[0-9A-Fa-f]{6}$/.test(v)), 'branding');
  need(isObj(c.map) && Object.keys(c.map).length === 3 && fin(c.map.latitude) && Math.abs(c.map.latitude) <= 90 && fin(c.map.longitude) && Math.abs(c.map.longitude) <= 180 && fin(c.map.radius_km) && c.map.radius_km > 0, 'map');
  need(isObj(c.hours) && Object.keys(c.hours).length === 7 && [0, 1, 2, 3, 4, 5, 6].every((d) => c.hours[d] === null || (isObj(c.hours[d]) && Object.keys(c.hours[d]).length === 2 && Number.isInteger(c.hours[d].open) && Number.isInteger(c.hours[d].close) && c.hours[d].open >= 0 && c.hours[d].open < c.hours[d].close && c.hours[d].close <= 1440)), 'hours');
  need(fin(c.min_order_lempiras) && c.min_order_lempiras >= 0, 'min_order_lempiras');
  need(Array.isArray(c.payment_methods) && c.payment_methods.length > 0 && c.payment_methods.every((p) => PAY.includes(p)) && new Set(c.payment_methods).size === c.payment_methods.length, 'payment_methods');
  need(isObj(c.rewards) && ['punch', 'points'].includes(c.rewards.kind), 'rewards');
  need(typeof c.order_id_prefix === 'string' && /^[A-Z]{2,5}-$/.test(c.order_id_prefix), 'order_id_prefix');
  need(isObj(c.storage_keys) && Object.keys(c.storage_keys).length === 3 && /^[a-z0-9_]+_pending_pay$/.test(c.storage_keys.pending_pay || '') && /^[a-z0-9_]+$/.test(c.storage_keys.account_marker || '') && /^[a-z0-9_]+$/.test(c.storage_keys.account_intent || ''), 'storage_keys');
  need(str(c.empty_cart_noun), 'empty_cart_noun');
  need(c.item_key === 'id' || c.item_key === 'name', 'item_key');
  return bad;
}
