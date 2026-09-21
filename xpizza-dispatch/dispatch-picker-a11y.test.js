// xpizza-dispatch/dispatch-picker-a11y.test.js
//
// Slice A — assign/reassign picker keyboard + screen-reader accessibility (design:
// docs/superpowers/specs/2026-09-20-dispatch-assign-flow-a11y-design.md).
//
// The dispatch board's picker lives INLINE in index.html (single <script type="module">), so this suite
// reads the shipped file and asserts on its markup / CSS / script text. Two kinds of guard:
//   (1) FEATURE guards — the a11y wiring is present (dialog role, button rows, aria-label, amber warning).
//   (2) NO-REGRESSION guards — the assignment-logic sites are BYTE-IDENTICAL to the approved base. These
//       compare against the exact base blob (git show <BASE>:…) so an accidental edit to the CAS freeze,
//       requireConfirm policy, confirm() texts or assign calls turns this suite red.
// Plus one genuinely-executable behavioral guard: the file's own escapeHtml is eval'd and run on hostile
// input, proving the escaper the aria-label attribute sink relies on actually neutralises markup.

import assert from 'node:assert';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, 'index.html');
const BASE = '792631999ff2'; // approved base (origin/main tip this slice was cut from)

const html = fs.readFileSync(FILE, 'utf8');
let baseHtml = null;
try {
  baseHtml = execSync(`git show ${BASE}:xpizza-dispatch/index.html`, { cwd: __dirname, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.error('  ! could not load base blob for byte-identity guards:', e.message);
  process.exit(1);
}

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Isolate the picker render block (openPicker … closePicker) so structural asserts don't match stray text.
const openIdx = html.indexOf('function openPicker(');
const closeEnd = html.indexOf('function assignFailMsg(');
assert.ok(openIdx > -1 && closeEnd > openIdx, 'located openPicker…assignFailMsg region');
const pickerJs = html.slice(openIdx, closeEnd);

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE 1 — the overlay is an accessible dialog
// ─────────────────────────────────────────────────────────────────────────────
{
  const tag = html.match(/<div class="overlay-bg hidden" id="picker-overlay"[^>]*>/);
  assert.ok(tag, 'picker-overlay element present');
  assert.match(tag[0], /role="dialog"/, 'role="dialog"');
  assert.match(tag[0], /aria-modal="true"/, 'aria-modal="true"');
  assert.match(tag[0], /aria-labelledby="picker-title"/, 'aria-labelledby → picker-title');
  assert.match(html, /<div class="picker-title" id="picker-title">/, 'picker-title exists to label the dialog');
  ok('overlay is role=dialog, aria-modal, labelled by #picker-title');
}

// FEATURE 2 — focus is moved IN on open and RESTORED (to a re-resolved, visible target) on close
{
  assert.match(pickerJs, /pickerOpener\s*=\s*document\.activeElement/, 'captures opener at top of openPicker');
  // focus moves into the list (first row) or the cancel button on open
  assert.match(pickerJs, /querySelector\('\.picker-row'\)\s*\|\|\s*\$\('picker-cancel-btn'\)/, 'first-focusable = first row else cancel');
  assert.match(pickerJs, /firstFocusable\.focus\(/, 'focus() moved into dialog on open');
  // restore in closePicker goes through the stable-identity resolver (NOT a raw stale node)
  assert.match(pickerJs, /const returnOrderId = pickerOrderId;/, 'orderId captured before closePicker resets');
  assert.match(pickerJs, /pickerReturnFocusTarget\(opener, returnOrderId, document\)/, 'closePicker resolves a visible return target');
  assert.doesNotMatch(pickerJs, /if \(opener && typeof opener\.focus === 'function'\) opener\.focus\(\)/, 'no longer focuses the raw (possibly detached) opener node');
  assert.match(pickerJs, /pickerOpener\s*=\s*null/, 'opener reference cleared on close');
  ok('focus captured on open, moved into dialog, restored via re-resolved visible target on close');
}

// FEATURE 3 — reduced-motion: focus is non-scrolling under prefers-reduced-motion
{
  assert.match(pickerJs, /prefers-reduced-motion:\s*reduce/, 'reads prefers-reduced-motion');
  assert.match(pickerJs, /focus\(\{\s*preventScroll:\s*reduceMotion\s*\}\)/, 'focus preventScroll gated on reduced-motion');
  ok('reduced-motion → focus() uses preventScroll (no focus-scroll animation)');
}

// FEATURE 4 — rows are real <button>s carrying the data-* and an escaped aria-label
{
  assert.match(pickerJs, /<button type="button" class="picker-row /, 'rows render as <button type="button">');
  assert.doesNotMatch(pickerJs, /<div class="picker-row /, 'no <div class="picker-row"> remains');
  // data-* preserved
  assert.match(pickerJs, /data-driver-uid="\$\{uid\}"/, 'data-driver-uid preserved');
  assert.match(pickerJs, /data-full="1"/, 'data-full preserved');
  assert.match(pickerJs, /data-enroute="1"/, 'data-enroute preserved');
  assert.match(pickerJs, /data-unreachable="1"/, 'data-unreachable preserved');
  // aria-label is present and ESCAPED (attribute sink) — no raw ${…} in the attribute value
  assert.match(pickerJs, /aria-label="\$\{escapeHtml\(String\(ariaLabel\)\)\}"/, 'aria-label value wrapped in escapeHtml(String(...))');
  assert.match(pickerJs, /const ariaLabel = \[driver\.name/, 'aria-label composed from name·status·load·distance·reason');
  ok('rows are buttons; data-* preserved; aria-label present and escaped');
}

// FEATURE 5 — needs-confirm AMBER warning replaces fake-disabled; row stays interactive
{
  // template maps requireConfirm → needs-confirm (NOT disabled)
  assert.match(pickerJs, /requireConfirm \? 'needs-confirm' : ''/, 'requireConfirm rows get .needs-confirm');
  assert.doesNotMatch(pickerJs, /requireConfirm \? 'disabled'/, 'requireConfirm rows no longer get .disabled');
  // visible inline reason rendered for confirm rows, escaped
  assert.match(pickerJs, /class="confirm-reason">\$\{escapeHtml\(confirmReason\)\}/, 'inline confirm-reason rendered + escaped');
  assert.match(pickerJs, /requiere confirmación · lleno/, 'reason: lleno');
  assert.match(pickerJs, /requiere confirmación · en camino/, 'reason: en camino');
  assert.match(pickerJs, /requiere confirmación · sin notificaciones/, 'reason: sin notificaciones');
  // CSS: needs-confirm is amber; the disabled opacity/not-allowed treatment is GONE; nothing blocks the click
  assert.match(html, /\.picker-row\.needs-confirm\s*\{\s*background:\s*var\(--warn-soft\)/, 'needs-confirm amber CSS present');
  assert.doesNotMatch(html, /\.picker-row\.disabled\s*\{[^}]*opacity/, 'old .picker-row.disabled opacity rule removed');
  assert.doesNotMatch(html, /\.picker-row[^{]*\{[^}]*pointer-events:\s*none/, 'no pointer-events:none on picker rows');
  assert.doesNotMatch(html, /\.picker-row\.needs-confirm[^{]*\{[^}]*cursor:\s*not-allowed/, 'needs-confirm never cursor:not-allowed');
  // the row <button> must NEVER carry a `disabled` attribute (that would truly block the click + confirm override)
  const btnOpen = pickerJs.match(/<button type="button" class="picker-row[\s\S]*?>/);
  assert.ok(btnOpen, 'row button open-tag located');
  assert.doesNotMatch(btnOpen[0], /\sdisabled(\s|=|>)/, 'row button has no disabled attribute');
  ok('needs-confirm amber warning replaces fake-disabled; row stays clickable (no disabled attr)');
}

// FEATURE 6 — Esc + focus trap, guarded on pickerOpen, scoped to the overlay
{
  const kd = pickerJs.match(/\$\('picker-overlay'\)\.addEventListener\('keydown'[\s\S]*?\n\}\);/);
  assert.ok(kd, 'picker-overlay keydown handler present');
  const h = kd[0];
  assert.match(h, /if \(!pickerOpen\) return;/, 'Esc/trap branch guarded on pickerOpen');
  assert.match(h, /e\.key === 'Escape'[\s\S]*?closePicker\(\)/, 'Escape closes the picker');
  assert.match(h, /e\.stopPropagation\(\)/, 'Esc stops propagation so document Esc handlers do not also fire');
  assert.match(h, /e\.key === 'Tab'/, 'Tab handled (focus trap)');
  assert.match(h, /button:not\(\[disabled\]\)/, 'trap cycles over overlay buttons');
  ok('overlay keydown: pickerOpen-guarded Esc (stops propagation) + Tab focus trap');
}

// ─────────────────────────────────────────────────────────────────────────────
// NO-REGRESSION — assignment logic byte-identical to the approved base
// ─────────────────────────────────────────────────────────────────────────────
{
  const anchors = [
    ['CAS freeze',            'pickerFromDriver = allTasks[`${orderId}_delivery`]?.assigned_driver_id ?? null;'],
    ['requireConfirm policy', 'const requireConfirm = full || enRoute || unreachable;'],
    ['ordersByDriver skip terminal', "if (t.status === 'completed' || t.status === 'cancelled') return;"],
    ['distinct-driver set init', 'if (!ordersByDriver[t.assigned_driver_id]) ordersByDriver[t.assigned_driver_id] = new Set();'],
    ['distinct-order add',    'if (t.order_id) ordersByDriver[t.assigned_driver_id].add(t.order_id);'],
    ['orderCount = set.size',  'const orderCount = ordersByDriver[uid] ? ordersByDriver[uid].size : 0;'],
    ['full = count >= 2',     'const full = orderCount >= 2;'],
    ['confirm() full',        "if (!confirm('Este repartidor ya tiene 2 pedidos (al límite). ¿Asignar de todas formas?')) return;"],
    ['confirm() en-route',    "if (!confirm('Este repartidor ya salió a entregar (en camino). ¿Asignar de todas formas?')) return;"],
    ['confirm() unreachable', "if (!confirm('Este repartidor no tiene notificaciones activadas. ¿Asignar de todas formas?')) return;"],
    ['click → assignOrder',   'await assignOrder(orderId, row.dataset.driverUid);'],
    ['reassignOrder call',    'const res = await XPD.reassignOrder(orderId, driverId, pickerFromDriver);'],
    ['assignOrderToDriver',   'const res = await XPD.assignOrderToDriver(orderId, driverId);'],
    ['priority: at_restaurant',"if (d.status === 'at_restaurant') priority = 0;"],
    ['priority sort',         '.sort((a, b) => a.priority - b.priority);'],
    ['empty state',           "'<div class=\"panel-empty\">No hay drivers en turno</div>';"],
  ];
  for (const [name, s] of anchors) {
    assert.ok(baseHtml.includes(s), `[base sanity] base contains: ${name}`);
    assert.ok(html.includes(s),     `assignment-logic UNCHANGED: ${name}`);
  }
  ok(`assignment-logic sites byte-identical to base (${anchors.length} anchors)`);
}

// The click LISTENER that reads data-* and calls assignOrder must be verbatim (whole block).
{
  const block = `    $('picker-list').querySelectorAll('[data-driver-uid]').forEach(row => {
      row.addEventListener('click', async () => {
        if (row.dataset.full === '1') {
          if (!confirm('Este repartidor ya tiene 2 pedidos (al límite). ¿Asignar de todas formas?')) return;
        } else if (row.dataset.enroute === '1') {
          if (!confirm('Este repartidor ya salió a entregar (en camino). ¿Asignar de todas formas?')) return;
        } else if (row.dataset.unreachable === '1') {
          if (!confirm('Este repartidor no tiene notificaciones activadas. ¿Asignar de todas formas?')) return;
        }
        await assignOrder(orderId, row.dataset.driverUid);
      });
    });`;
  assert.ok(baseHtml.includes(block), '[base sanity] base has the click-listener block');
  assert.ok(html.includes(block), 'confirm()-override click listener is verbatim unchanged');
  ok('confirm()-override click listener block is byte-identical');
}

// ─────────────────────────────────────────────────────────────────────────────
// BEHAVIORAL (executable) — the escaper the aria-label sink relies on actually neutralises markup.
// Extract escapeHtml from the shipped file, run it on hostile input. Non-vacuous: a broken escaper is red.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = html.match(/function escapeHtml\(s\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'escapeHtml source located');
  // eslint-disable-next-line no-new-func
  const escapeHtml = new Function(`${m[0]}; return escapeHtml;`)();

  const hostileName = '<img src=x onerror=alert(1)>';
  const attrBreak = '" onmouseover="alert(1)';
  // The row builds aria-label = [name, …].join(' · ') then escapeHtml(String(aria)). Reproduce the sink:
  const ariaLabel = [hostileName, 'Disponible', 'sin pedidos', '1.0 km a base', ''].filter(Boolean).join(' · ');
  const escaped = escapeHtml(String(ariaLabel));
  assert.ok(!escaped.includes('<'), 'no raw < survives into aria-label');
  assert.ok(!escaped.includes('>'), 'no raw > survives into aria-label');
  assert.match(escaped, /&lt;img/, 'hostile markup rendered as text');

  const escapedAttr = escapeHtml(String(attrBreak));
  assert.ok(!escapedAttr.includes('"'), 'no raw double-quote survives (cannot break out of the attribute)');
  assert.match(escapedAttr, /&quot;/, 'quote entity-encoded');
  ok('escapeHtml (from source) neutralises hostile name in the aria-label attribute sink');
}

// ─────────────────────────────────────────────────────────────────────────────
// BEHAVIORAL (executable) — focus RESTORATION survives the board's re-render.
// The gate's real bug: the board re-renders on a ~5s timer → the opener node is DETACHED → restoring to the
// raw node is a no-op ("focus nowhere"). Extract pickerReturnFocusTarget and drive it with a fake DOM.
// ─────────────────────────────────────────────────────────────────────────────
{
  const m = html.match(/function pickerReturnFocusTarget\(opener, orderId, doc\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'pickerReturnFocusTarget source located');
  // eslint-disable-next-line no-new-func
  const resolve = new Function('CSS', `${m[0]}; return pickerReturnFocusTarget;`)(undefined);

  const el = (props) => ({ isConnected: true, offsetParent: {}, focus() {}, ...props });
  // A fake document keyed by a small selector → element map.
  const fakeDoc = (map, byId) => ({
    querySelector: (sel) => (sel in map ? map[sel] : null),
    getElementById: (id) => (byId && id in byId ? byId[id] : null),
  });

  // (a) THE BUG: opener detached by a re-render; a fresh trigger for the same order now exists → resolve the
  //     fresh trigger, NOT the detached opener, NOT nothing.
  {
    const detachedOpener = el({ isConnected: false, offsetParent: null });
    const freshTrigger = el({});
    const doc = fakeDoc({ '[data-assign-order="O1"]': freshTrigger });
    const r = resolve(detachedOpener, 'O1', doc);
    assert.notStrictEqual(r.el, detachedOpener, 'does NOT return the detached opener');
    assert.strictEqual(r.el, freshTrigger, 'returns the re-rendered visible trigger');
    assert.strictEqual(r.el.isConnected, true, 'return target is attached');
    assert.ok(r.el.offsetParent != null, 'return target is visible');
  }
  // (b) unreachable opener (detached) AND the order is entirely gone (assigned/cancelled) → fall back to the
  //     stable board landmark; NEVER null/nowhere while the landmark exists.
  {
    const detachedOpener = el({ isConnected: false, offsetParent: null });
    const landmark = el({});
    const doc = fakeDoc({}, { 'unassigned-group': landmark });
    const r = resolve(detachedOpener, 'GONE', doc);
    assert.strictEqual(r.el, landmark, 'falls back to #unassigned-group landmark');
    assert.strictEqual(r.temp, true, 'landmark flagged temp (needs tabindex to receive focus)');
  }
  // (b2) detail-modal reassign: opener is a HIDDEN button (offsetParent null but still connected) → rejected;
  //      re-query finds the visible reassign trigger.
  {
    const hiddenOpener = el({ offsetParent: null });   // inside a display:none modal
    const reassignTrigger = el({});
    const doc = fakeDoc({ '[data-reassign-order="O2"]': reassignTrigger });
    const r = resolve(hiddenOpener, 'O2', doc);
    assert.strictEqual(r.el, reassignTrigger, 'hidden opener rejected → visible reassign trigger used');
  }
  // (c) happy path: opener still attached+visible (no re-render) → keep it.
  {
    const opener = el({});
    const r = resolve(opener, 'O3', fakeDoc({}));
    assert.strictEqual(r.el, opener, 'attached+visible opener is preserved');
    assert.strictEqual(r.temp, false, 'real button never flagged temp');
  }
  ok('pickerReturnFocusTarget: detached/hidden opener → re-resolved visible trigger / landmark, never nowhere');
}

// BEHAVIORAL (executable) — Tab focus-trap wraps BOTH directions.
{
  const m = html.match(/function focusTrapTarget\(shiftKey, active, focusables\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'focusTrapTarget source located');
  // eslint-disable-next-line no-new-func
  const trap = new Function(`${m[0]}; return focusTrapTarget;`)();
  const a = 'A', b = 'B', c = 'C';
  const list = [a, b, c];
  assert.strictEqual(trap(false, c, list), a, 'forward Tab at LAST wraps → first');
  assert.strictEqual(trap(true, a, list), c, 'backward Shift-Tab at FIRST wraps → last');
  assert.strictEqual(trap(false, b, list), null, 'Tab in the middle → browser default (null)');
  assert.strictEqual(trap(true, b, list), null, 'Shift-Tab in the middle → browser default (null)');
  assert.strictEqual(trap(false, a, []), null, 'empty list → null');
  ok('focusTrapTarget: Tab AND Shift-Tab wrap at both ends; interior/empty → default');
}

console.log(`\ndispatch-picker-a11y: OK (${n} groups)`);
