// xpizza-dispatch/dispatch-driver-problem.test.mjs
/* DRIVER F — EXECUTES THE REAL TORRE RENDERER ON THE REAL SERVER CORE'S PAYLOAD.
 * The payload is produced by xpizza-functions/driver-problem-alert.js itself (never hand-built), then classified by the real
 * dispatch-alerts.js and rendered by alertContent + renderDispatcherAlerts lifted out of index.html, so a drift on either
 * side (a renamed field, a missing case, the unknown-kind fallback «Alerta / driver problem») fails here.
 * Run: node xpizza-dispatch/dispatch-driver-problem.test.mjs */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { classifyAlert, sortAlertEntries, driverProblemReasonLabel, driverProblemContent } from './dispatch-alerts.js';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { alertOnDriverProblem, REASONS } = require('../xpizza-functions/driver-problem-alert.js');
const html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
let pass = 0; const ok = (n) => { console.log(`  ✓ ${n}`); pass++; };

function lift(name) {
  const at = html.indexOf(`function ${name}(`);
  assert.notStrictEqual(at, -1, `premise — ${name} must be findable in index.html`);
  let i = html.indexOf('{', at), depth = 0, end = i;
  for (; end < html.length; end++) {
    if (html[end] === '{') depth++;
    else if (html[end] === '}') { depth--; if (!depth) break; }
  }
  return html.slice(at, end + 1);
}
const colaLine = html.match(/const COLA_OWNED_ALERT_TYPES = new Set\(\[[^\]]*\]\);/);
assert.ok(colaLine, 'premise — COLA_OWNED_ALERT_TYPES is findable');
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// the page's import must carry the new export and a bumped cache key (a stale cached module would lack driverProblemReasonLabel)
assert.match(html, /import \{ classifyAlert, sortAlertEntries, driverProblemReasonLabel, driverProblemContent \} from '\.\/dispatch-alerts\.js\?v=4';/, 'DRVF-TORRE-IMPORT the page imports the helpers (incl. the extracted driverProblemContent) with a bumped ?v');

function build({ allOrders = {}, allDrivers = {} } = {}) {
  // eslint-disable-next-line no-new-func
  return new Function('escapeHtml', 'allOrders', 'allDrivers', 'driverProblemReasonLabel', 'driverProblemContent',
    `${lift('displayOrderLabel')}; ${lift('alertContent')}; return alertContent;`)(escapeHtml, allOrders, allDrivers, driverProblemReasonLabel, driverProblemContent);
}
function buildRender({ allOrders = {}, allDrivers = {} } = {}) {
  const els = {};
  const $ = (id) => (els[id] = els[id] || { innerHTML: '', textContent: '', hidden: false, classList: { toggle() {}, add() {}, remove() {} }, querySelectorAll: () => [] });
  // eslint-disable-next-line no-new-func
  const render = new Function('escapeHtml', 'allOrders', 'allDrivers', 'driverProblemReasonLabel', 'driverProblemContent', '$', 'sortAlertEntries',
    `${colaLine[0]}; ${lift('displayOrderLabel')}; ${lift('alertContent')}; ${lift('renderDispatcherAlerts')}; return renderDispatcherAlerts;`)(
    escapeHtml, allOrders, allDrivers, driverProblemReasonLabel, driverProblemContent, $, sortAlertEntries);
  return { render, els };
}

// the REAL emitter's payload, through a minimal fake db
async function emit(rec, { order = { restaurant_id: 'tb_rest', display_number: 42 }, name = 'Tbname' } = {}) {
  let written = null;
  const db = {
    ref: (p) => ({
      once: async () => ({ val: () => (p === 'orders/tb_order_1' ? order : null) }),
      transaction: async (fn) => { written = fn(null); return { committed: true }; },
    }),
  };
  await alertOnDriverProblem(db, { oid: 'tb_order_1', pid: 'tb_push_1', rec, now: 1_800_000_000_000 }, { resolveDriverName: async () => name, log: { warn() {} } });
  return written;
}

const LABELS = {
  waiting_restaurant: 'Estoy esperando en el restaurante', not_ready_incomplete: 'El pedido no está listo o está incompleto',
  customer_no_answer: 'El cliente no contesta', address_not_found: 'No encuentro la dirección', restaurant_closed: 'El local está cerrado', other: 'Otro',
};

{
  assert.deepStrictEqual(Object.keys(LABELS).sort(), [...REASONS].sort(), 'DRVF-TORRE-REASONS the Torre labels cover exactly the server enum');
  for (const r of REASONS) assert.strictEqual(driverProblemReasonLabel(r), LABELS[r], `DRVF-TORRE-LABEL ${r} = the approved prototype copy`);
  assert.strictEqual(driverProblemReasonLabel('__proto__'), 'Otro', 'DRVF-TORRE-LABEL-PROTO an inherited key never renders');
  assert.strictEqual(driverProblemReasonLabel('tb_unknown'), 'Otro', 'DRVF-TORRE-LABEL-UNKNOWN an unknown id never renders raw');
  ok('the six reason labels are the approved copy, keyed by exactly the server enum; unknown ids → «Otro»');
}

{
  const a = await emit({ reason: 'customer_no_answer', by: 'tb_driver_1', at: 1 });
  const c = classifyAlert(a);
  assert.strictEqual(c.known, true, 'DRVF-TORRE-KNOWN driver_problem is a known type (not «Otros / Revisar»)');
  assert.strictEqual(c.severity, 'amber', 'DRVF-TORRE-AMBER');
  assert.strictEqual(c.category, 'driver-problem', 'DRVF-TORRE-CATEGORY');
  ok('classified known · amber · driver-problem');
}

for (const reason of REASONS) {
  const a = await emit({ reason, by: 'tb_driver_1', at: 1 });
  const out = build()(a);
  assert.strictEqual(out.title, 'Problema con el pedido', `DRVF-TORRE-TITLE ${reason} (not the «Alerta» fallback)`);
  assert.strictEqual(out.detail, `Pedido #42 · ${escapeHtml(LABELS[reason])} · Tbname`, `DRVF-TORRE-DETAIL ${reason}`);
}
ok('every reason renders «Problema con el pedido» / «Pedido #42 · {motivo} · {repartidor}» from the real payload');

{
  const a = await emit({ reason: 'other', by: 'tb_driver_1', at: 1, note: '<img src=x onerror=alert(1)> "tb" & \'q\'' });
  const out = build()(a);
  assert.ok(out.detail.endsWith(' — &lt;img src=x onerror=alert(1)&gt; &quot;tb&quot; &amp; &#39;q&#39;'), 'DRVF-TORRE-XSS the note is escaped');
  assert.doesNotMatch(out.detail, /<img/, 'DRVF-TORRE-XSS-RAW no raw markup');
  ok('the driver note renders escaped (XSS probe)');
}

{
  // no enrichment (order gone, no name) → the page's own order lookup + the driver map, then neutral fallbacks — never "undefined"
  const a = await emit({ reason: 'address_not_found', by: 'tb_driver_1', at: 1 }, { order: null, name: null });
  assert.strictEqual(build({ allOrders: { tb_order_1: { display_number: 7 } }, allDrivers: { tb_driver_1: { name: 'Mapname' } } })(a).detail,
    'Pedido #7 · No encuentro la dirección · Mapname', 'DRVF-TORRE-FALLBACK-PAGE the page lookups fill the gaps');
  const bare = build()(a).detail;
  assert.strictEqual(bare, 'Pedido #ER_1 · No encuentro la dirección · Un repartidor', 'DRVF-TORRE-FALLBACK-NEUTRAL');
  assert.doesNotMatch(bare, /undefined|null|\[object/, 'DRVF-TORRE-NO-PLACEHOLDER');
  ok('without enrichment: the page\'s own order/driver lookups, else neutral fallbacks; no placeholders');
}

{
  const a = await emit({ reason: 'restaurant_closed', by: 'tb_driver_1', at: 1 });
  const { render, els } = buildRender();
  render({ driver_problem_tb_order_1_tb_push_1: a });
  const h = els['torre-list'].innerHTML;
  assert.match(h, /Problema con el pedido/, 'DRVF-TORRE-RENDER the row title is on screen');
  assert.match(h, /Pedido #42 · El local está cerrado · Tbname/, 'DRVF-TORRE-RENDER-DETAIL');
  assert.match(h, /data-alert-id="driver_problem_tb_order_1_tb_push_1"/, 'DRVF-TORRE-RENDER-ID the row carries its id (dismiss + navigation)');
  assert.doesNotMatch(h, /Otros \/ Revisar/, 'DRVF-TORRE-RENDER-NOT-OTROS not buried in the unknown bucket');
  assert.match(h, /class="ex amber"/, 'DRVF-TORRE-RENDER-AMBER');
  ok('renderDispatcherAlerts puts the real alert in the main list, amber, with its id — not in «Otros / Revisar»');
}

console.log(`\n${pass} passed`);
