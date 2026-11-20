// xpizza-dispatch/dispatch-idle-overlay-coverage.test.js
//
// CTA audit #1b / Codex #227 P2-2 — SherpaClient.idleAdapter must NOT let an auto-update reload fire while
// a modal dialog is open. Its open-overlay selector list is hand-maintained, so a NEW modal overlay can be
// forgotten (the styled-confirm was). This guard derives the requirement from the canonical OVERLAYS
// registry: EVERY modal (focus-trapping) overlay must have a matching selector in the idleAdapter list, so
// the next overlay can't silently miss the reload guard.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// The canonical OVERLAYS registry: parse each entry's name, modal flag, and the element id its open() reads.
const regBlock = html.slice(html.indexOf('const OVERLAYS = ['), html.indexOf('const anyModalOpen ='));
const entries = [...regBlock.matchAll(/name:\s*'([^']+)',[^\n]*?modal:\s*(true|false)[^\n]*?\$\('([^']+)'\)/g)]
  .map((m) => ({ name: m[1], modal: m[2] === 'true', id: m[3] }));
assert.ok(entries.length >= 9, `parsed the OVERLAYS entries (${entries.length})`);
assert.ok(entries.some((e) => e.name === 'styled-confirm'), 'styled-confirm is present in OVERLAYS');

// The idleAdapter's open-overlay selector list, from the registerAdapter call.
const idle = (html.match(/idleAdapter\(\{\s*overlays:\s*\[([^\]]*)\]/) || [])[1];
assert.ok(idle, 'located the idleAdapter overlays list');

// Every MODAL overlay (the focus-trapping dialogs) must be covered by a selector referencing its id.
const modalIds = entries.filter((e) => e.modal).map((e) => e.id);
const missing = modalIds.filter((id) => !idle.includes('#' + id));
assert.deepEqual(missing, [], `every modal OVERLAYS overlay is guarded in idleAdapter; missing: ${missing.join(', ')}`);
assert.ok(idle.includes('#styled-confirm-overlay'), 'the styled-confirm overlay is in the idle reload guard (P2-2)');
ok(`idleAdapter covers all ${modalIds.length} modal overlays (no reload can fire through an open dialog)`);

console.log(`dispatch-idle-overlay-coverage: OK (${n})`);
