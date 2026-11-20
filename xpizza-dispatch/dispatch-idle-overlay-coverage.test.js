// xpizza-dispatch/dispatch-idle-overlay-coverage.test.js
//
// CTA audit #1b / Codex #227 P2-2 — SherpaClient.idleAdapter must NOT let an auto-update reload fire while a
// modal dialog is open. Its open-overlay selector list is hand-maintained, so a NEW modal overlay can be
// forgotten (styled-confirm was). This guard derives the requirement from the canonical OVERLAYS registry:
// EVERY modal (focus-trapping) overlay must have a matching selector in the idleAdapter list.
//
// Codex #228 P3: EVALUATE the OVERLAYS array literal (as the other slice tests do) rather than regex it — a
// regex that excludes newlines silently skips a multi-line registry entry. We also assert the evaluated
// entry count equals the source `name:` count, so no entry can be dropped unparsed.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// Extract and EVALUATE the OVERLAYS array literal. Each entry's open() calls $('<id>') once; a recording $
// stub lets us read the element id each overlay guards. (No DOM — the predicate's return value is ignored.)
const litStart = html.indexOf('const OVERLAYS = [') + 'const OVERLAYS = '.length;
const litEnd = html.indexOf('\n];', litStart) + 2;
assert.ok(litStart > 0 && litEnd > litStart, 'located the OVERLAYS array literal');
const literal = html.slice(litStart, litEnd);
let lastId = null;
const $ = (id) => { lastId = id; return { hidden: true, classList: { contains: () => false } }; };
const OVERLAYS = new Function('$', `return ${literal};`)($);
assert.ok(Array.isArray(OVERLAYS) && OVERLAYS.length >= 9, `evaluated the OVERLAYS array (${OVERLAYS.length} entries)`);

// Count guard: every source entry (one `name:` each) must survive into the evaluated array — no silent skip.
const sourceNames = (literal.match(/name:\s*'[^']+'/g) || []).length;
assert.equal(OVERLAYS.length, sourceNames, `every source OVERLAYS entry is evaluated (${OVERLAYS.length} === ${sourceNames})`);

const entries = OVERLAYS.map((o) => { lastId = null; try { o.open(); } catch (_) {} return { name: o.name, modal: o.modal === true, id: lastId }; });
assert.ok(entries.every((e) => typeof e.id === 'string' && e.id), 'read the guarded element id of every overlay');
assert.ok(entries.some((e) => e.name === 'styled-confirm'), 'styled-confirm is present in OVERLAYS');

// The idleAdapter's open-overlay selector list — extract the array literal up to `] })` (a selector like
// `#surface-flyout:not([hidden])` contains a `]`, so stop on the array's real close, not the first `]`).
const idleAt = html.indexOf('idleAdapter({ overlays: [');
const idleMatch = html.slice(idleAt).match(/overlays:\s*(\[[\s\S]*?\])\s*\}\)/);
assert.ok(idleAt > -1 && idleMatch, 'located the idleAdapter overlays list');
const idleList = new Function(`return ${idleMatch[1]};`)();
assert.ok(Array.isArray(idleList) && idleList.length > 0, 'evaluated the idle overlays list');
const idleStr = idleList.join(' ');

// Every MODAL overlay (the focus-trapping dialogs) must be covered by a selector referencing its id.
const modal = entries.filter((e) => e.modal);
const missing = modal.filter((e) => !idleStr.includes('#' + e.id));
assert.deepEqual(missing, [], `every modal OVERLAYS overlay is guarded in idleAdapter; missing: ${missing.map((e) => e.name).join(', ')}`);
assert.ok(idleStr.includes('#styled-confirm-overlay'), 'the styled-confirm overlay is in the idle reload guard (P2-2)');
ok(`idleAdapter covers all ${modal.length} modal overlays (evaluated from the registry; multi-line entries counted)`);

console.log(`dispatch-idle-overlay-coverage: OK (${n})`);
