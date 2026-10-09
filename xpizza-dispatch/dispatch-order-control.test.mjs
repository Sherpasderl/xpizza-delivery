// xpizza-dispatch/dispatch-order-control.test.mjs — D4-c4 "Pausar pedidos": the dispatch banner + the held tag
// (PLAN-D4c4 rev 13 §4/§0.3/§0.7/§0.9). Run: node xpizza-dispatch/dispatch-order-control.test.mjs
// Fed by the SHARED state module exactly as the browser loads it (a classic script → window.OrderControlState), with nodes
// shaped as the owner CLI writes them (tools/order-control-core.js txnCallback). Display-only: the module writes nothing.
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pauseBannerModel, pauseBannerHtml, heldTag, PAUSE_RECHECK_MS, UNAVAILABLE_TEXT } from './dispatch-order-control.js';

const require = createRequire(import.meta.url);
const C = require('../xpizza-functions/tools/order-control-core.js');
let pass = 0; const ok = (l) => { console.log(`  ✓ ${++pass} ${l}`); };

// the shared module as the BROWSER gets it
const win = {}; vm.runInContext(fs.readFileSync(new URL('./order-control-state.js', import.meta.url), 'utf8'), vm.createContext({ self: win }));
const S = win.OrderControlState;
assert.ok(S && S.effectiveState);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmtTime = (ms) => `T${ms}`;
const NOW = 1_900_000_000_000;
const TS = 1_899_000_000_000;
// a node exactly as the CLI's transaction writes it (the server timestamp resolved)
const written = (to, opId = 'op1', prev = null) => {
  const out = C.txnCallback({ expectedVersion: C.versionOf(prev), to, opId, actor: 'Ana', principal: 'ana@example.com', reason: 'cocina llena', timestamp: TS })(prev);
  return out;
};
const model = (nodes, extra = {}) => pauseBannerModel({ status: 'ok', nodes, names: {}, now: NOW, S, ...extra });

{
  for (const status of ['loading', 'error', undefined]) assert.deepStrictEqual(pauseBannerModel({ status, nodes: {}, names: {}, now: NOW, S }), { state: 'unavailable' });
  assert.deepStrictEqual(pauseBannerModel({ status: 'ok', nodes: {}, names: {}, now: NOW, S: undefined }), { state: 'unavailable' }, 'the shared script failed to load → never "abierto"');
  assert.strictEqual(pauseBannerHtml({ state: 'unavailable' }, { esc, fmtTime }).includes(UNAVAILABLE_TEXT), true);
  assert.strictEqual(UNAVAILABLE_TEXT, 'Estado de pausa no disponible — reintentando');
  ok('loading / unreadable node / the shared script missing → "Estado de pausa no disponible — reintentando" (never "abierto")');
}
{
  assert.deepStrictEqual(model({}), { state: 'ok', paused: [], unknown: [] });
  assert.strictEqual(pauseBannerHtml(model({}), { esc, fmtTime }), '');
  const resumed = written({ paused: false }, 'op2', written({ paused: true }));
  assert.deepStrictEqual(model({ x_pizza: resumed }), { state: 'ok', paused: [], unknown: [] });
  ok('no nodes, or every restaurant resumed (paused:false) → nothing shown (the banner hides)');
}
{
  const nodes = { x_pizza: written({ paused: true }), r3_synthetic: written({ paused: true, until: NOW + 60000 }) };
  const m = model(nodes, { names: { x_pizza: 'X. Pizza' } });
  assert.deepStrictEqual(m.paused, [
    { rid: 'r3_synthetic', name: 'r3_synthetic', until: NOW + 60000, reason: 'cocina llena' },
    { rid: 'x_pizza', name: 'X. Pizza', until: null, reason: 'cocina llena' },
  ]);
  const html = pauseBannerHtml(m, { esc, fmtTime });
  assert.ok(html.includes('<b>X. Pizza</b> — pedidos pausados · cocina llena'), html);
  assert.ok(html.includes(`<b>r3_synthetic</b> — pedidos pausados hasta T${NOW + 60000} · cocina llena`), html);
  assert.ok(!/[⏸\u{1F300}-\u{1FAFF}]/u.test(html), 'a monochrome line icon, no emoji');
  ok('every rid in the PARENT node is enumerated — a THIRD synthetic restaurant appears with no code change; indefinite → "pedidos pausados", timed → "hasta HH:MM" (browser time); the reason; a line icon, no emoji');
}
{
  const nodes = { la_musa: written({ paused: true }) };
  assert.strictEqual(model(nodes, { names: { la_musa: null } }).paused[0].name, 'la_musa', 'unreadable name → the rid');
  assert.strictEqual(model(nodes, { names: { la_musa: '   ' } }).paused[0].name, 'la_musa', 'blank name → the rid');
  assert.strictEqual(model(nodes, { names: {} }).paused[0].name, 'la_musa', 'name not fetched yet → the rid');
  assert.strictEqual(model(nodes, { names: { la_musa: 42 } }).paused[0].name, 'la_musa', 'non-string name → the rid');
  ok('an unreadable / blank / missing / non-string identity name → the raw rid is shown (no brand literal anywhere)');
}
{
  const T = NOW + 30000;
  const nodes = { a: written({ paused: true, until: T }) };
  assert.strictEqual(pauseBannerModel({ status: 'ok', nodes, names: {}, now: T - 1, S }).paused.length, 1);
  assert.strictEqual(pauseBannerModel({ status: 'ok', nodes, names: {}, now: T, S }).paused.length, 0, 'gone at until — no write, the same node');
  assert.deepStrictEqual(nodes.a, written({ paused: true, until: T }), 'the model never mutates the node');
  assert.strictEqual(PAUSE_RECHECK_MS, 30000);
  ok('the banner DISAPPEARS at until with NO write: now = until − 1 ms shown, now = until gone (the board re-evaluates every 30 s, on node updates and on visibilitychange / focus)');
}
{
  const nodes = { ok1: written({ paused: true }), bad: { current: { paused: 'true', until: '123' } }, bad2: { current: { paused: true, until: null } }, bad3: 'garbage', bad4: { current: [] } };
  const m = model(nodes);
  assert.deepStrictEqual(m.unknown.map((u) => u.rid), ['bad', 'bad2', 'bad4']);
  // a non-object PARENT node has no `current` — exactly what the functions read (order_control/<rid>/current) → OPEN for both
  assert.ok(!m.unknown.some((u) => u.rid === 'bad3') && !m.paused.some((p) => p.rid === 'bad3'));
  assert.deepStrictEqual(m.paused.map((p) => p.rid), ['ok1']);
  const html = pauseBannerHtml(m, { esc, fmtTime });
  assert.ok(html.includes(`<b>bad</b> — ${UNAVAILABLE_TEXT}`), 'a malformed node → its "no disponible" row (§0.7)');
  assert.ok(model({ x: { events: { op: {} } } }).paused.length === 0 && model({ x: { events: { op: {} } } }).unknown.length === 0, 'a node with no current → OPEN');
  ok('a successfully read but MALFORMED node (no coercion) → its own "Estado de pausa no disponible" row; a node without `current` is OPEN');
}
{
  const m = model({ '<x>': { current: { paused: true, reason: '<img src=x onerror=alert(1)>' } } }, { names: { '<x>': '<b>Evil</b>' } });
  const html = pauseBannerHtml(m, { esc, fmtTime });
  assert.ok(!html.includes('<img') && !html.includes('<b>Evil</b>') && html.includes('&lt;img'), 'name, reason and rid are escaped');
  ok('the name, the reason and the rid are HTML-escaped');
}
{
  assert.strictEqual(heldTag({ control_held: { at: 1, cause: 'paused' } }), 'retenido — pausa');
  assert.strictEqual(heldTag({ control_held: { at: 1, cause: 'unavailable' } }), 'retenido — estado de pausa no disponible');
  assert.strictEqual(heldTag({ control_held: { at: 1 } }), 'retenido — pausa');
  for (const o of [{}, null, undefined, { control_held: null }, { control_held: 'x' }, { scheduled_blocked: true }]) assert.strictEqual(heldTag(o), '');
  ok('held tag from the order\'s OWN marker: cause paused → "retenido — pausa"; unavailable → "retenido — estado de pausa no disponible"; no marker → none (scheduled_blocked untouched)');
}
{
  const src = fs.readFileSync(new URL('./dispatch-order-control.js', import.meta.url), 'utf8');
  assert.ok(!/x_pizza|la_musa|X\. Pizza|La Musa/.test(src), 'no brand literal');
  assert.ok(!/\bimport\b|\b(ref|fbSet|fbUpdate|fbRemove|runTransaction|onValue|get|fetch)\(/.test(src.replace(/\/\/[^\n]*/g, '')), 'no database / network access at all — it writes nothing');
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.ok(/setInterval\(renderPauseBanner, PAUSE_RECHECK_MS\);/.test(html) && /addEventListener\('visibilitychange', \(\) => \{ if \(!document\.hidden\) renderPauseBanner\(\); \}\);/.test(html) && /addEventListener\('focus', renderPauseBanner\);/.test(html), 'the board re-evaluates on the 30 s timer, visibilitychange and focus');
  assert.ok(/now: Date\.now\(\) \+ serverTimeOffset/.test(html) && /XPD\.subscribeToServerTimeOffset\(/.test(html), 'against the server-corrected clock');
  assert.ok(/XPD\.subscribeToOrderControl\(/.test(html) && /orderControlStatus = 'error'/.test(html), 'the parent subscription, with an error path');
  const xpd = fs.readFileSync(new URL('./xpizza-delivery.js', import.meta.url), 'utf8');
  assert.ok(/onValue\(ref\(db, 'order_control'\),/.test(xpd), 'the PARENT node');
  assert.ok(/get\(ref\(db, `restaurants\/\$\{rid\}\/identity\/name`\)\)/.test(xpd), 'names from identity/name');
  assert.ok(/held-tag/.test(html) && /heldTag\(o\)/.test(html), 'the held tag on Programados rows');
  ok('wiring: brand-agnostic + write-free module; the board subscribes to the PARENT order_control node and identity/name, evaluates with .info/serverTimeOffset, and re-renders on the 30 s timer, visibilitychange and focus; Programados rows carry the held tag');
}

{
  // CSS structure (codex build r1, SHOULD-FIX 1 + 2). No headless browser in the repo, so the rules are asserted here; the
  // rendered check (computed display / left edge in Chrome) is evidence outside the repo.
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const decl = (body, prop) => { const m = body.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`)); return m ? m[1].trim() : null; };
  const own = rules.filter((r) => r.sel.split(',').map((x) => x.trim()).includes('.pause-banner'));
  assert.strictEqual(own.length, 1, 'exactly one .pause-banner base rule');
  assert.strictEqual(decl(own[0].body, 'display'), 'flex', 'the base rule shows the banner as a flex column');
  const hid = rules.filter((r) => r.sel.split(',').map((x) => x.trim()).includes('.pause-banner[hidden]'));
  assert.strictEqual(hid.length, 1, 'a .pause-banner[hidden] rule exists');
  assert.strictEqual(decl(hid[0].body, 'display'), 'none', '[hidden] → display:none (the class display:flex would otherwise override the UA [hidden] rule)');
  // nothing more specific than .pause-banner[hidden] (0,2,0) re-shows it, and no !important display on the banner
  // (every selector whose SUBJECT is the banner itself: .pause-banner / #pause-banner with optional qualifiers, possibly after ancestors)
  const subject = /(^|[\s>+~])(\.pause-banner|#pause-banner)(\[[^\]]+\]|:[\w-]+|\.[\w-]+)*$/;
  const setters = rules.flatMap((r) => r.sel.split(',').map((x) => x.trim()).filter((sel) => subject.test(sel) && decl(r.body, 'display') !== null).map((sel) => `${sel} { display: ${decl(r.body, 'display')} }`));
  assert.deepStrictEqual(setters, ['.pause-banner { display: flex }', '.pause-banner[hidden] { display: none }'], 'no other rule sets the banner\'s own display');
  // the fixed rail and the offset that clears it
  const rail = rules.find((r) => r.sel === '.nav-rail');
  assert.ok(rail && decl(rail.body, 'position') === 'fixed' && decl(rail.body, 'left') === '0', 'the nav rail is fixed at the left edge');
  const railW = decl(rail.body, 'width');
  assert.strictEqual(railW, '54px');
  assert.strictEqual(decl(own[0].body, 'margin-left'), railW, 'the banner starts at the rail width, like header.topbar / .app');
  const shift = rules.find((r) => r.sel === 'header.topbar, .app');
  assert.ok(shift && decl(shift.body, 'margin-left') === railW, 'the topbar / .app shift is the same width');
  // the element: body level (not inside .app, which would double the offset), hidden by default, toggled by its content
  const body = html.slice(html.indexOf('<body'));
  const at = body.indexOf('<div class="pause-banner" id="pause-banner" role="status" aria-live="polite" hidden></div>');
  assert.ok(at > 0, 'the banner element starts hidden');
  assert.ok(at > body.indexOf('</header>') && at < body.indexOf('<div class="app left-open right-open" id="app">'), 'a body-level sibling after the topbar and before .app');
  assert.ok(/el\.innerHTML = html; el\.hidden = !html;/.test(html), 'renderPauseBanner hides the element exactly when the model renders nothing');
  ok('CSS: .pause-banner[hidden] { display:none } so OPEN / resumed / expired leaves NO strip; the banner clears the fixed 54px nav rail (margin-left = the rail width, as topbar / .app); body-level, hidden by default');
}

console.log(`\ndispatch-order-control: OK (${pass})`);
