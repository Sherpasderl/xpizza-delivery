// xpizza-dispatch/dispatch-polish-deadends.test.js
//
// Polish §4 (CTA audit #8) — desktop dead-ends.
//  §4a: the «Mensaje in-app (Fase 2)» driver button only toasted «… disponible en Fase 2» — a dead-end for
//       an unbuilt feature. Owner: REMOVE it (enhance, don't rework). The driver row keeps Llamar + ⋯.
//  §4c: #roster-collapse hid the Repartidores panel AND its own re-open control (only the non-obvious topbar
//       toggle brought it back). Add a persistent re-open tab on the board's right edge, shown ONLY while the
//       panel is collapsed, wired to togRail('right-open').
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// §4a — the dead message button + its handler + copy are gone; Llamar + ⋯ remain.
{
  assert.ok(!html.includes('data-msg-driver'), 'the msg-driver button is removed');
  assert.ok(!html.includes('Fase 2') && !html.includes('disponible en Fase 2'), 'the «Fase 2» copy is gone');
  const dacts = html.slice(html.indexOf('<div class="dacts">'), html.indexOf('</div>', html.indexOf('<div class="dacts">')));
  assert.ok(dacts.includes('data-call-driver') && dacts.includes('data-more-driver'), 'the driver row keeps Llamar + ⋯');
  ok('§4a: the «Fase 2» driver button + handler + copy removed; Llamar and ⋯ kept');
}

// §4c — the persistent re-open tab.
{
  assert.ok(html.includes('id="i-expand-l"'), 'the expand-left icon is defined');
  assert.match(html, /\.reopen-tab\s*\{[^}]*position:\s*absolute[^}]*\}/, '.reopen-tab is an absolutely-positioned edge tab');
  assert.match(html, /\.reopen-tab\s*\{[^}]*display:\s*none/, '.reopen-tab is hidden by default');
  assert.match(html, /\.app:not\(\.right-open\)\s*\.reopen-tab\s*\{\s*display:\s*flex/, 'the re-open tab shows ONLY while the panel is collapsed');
  assert.match(html, /\.app\s*\{[^}]*position:\s*relative/, '.app is the positioning anchor');
  // markup: button with the Mostrar Repartidores affordance + a live count
  const btn = html.slice(html.indexOf('id="roster-reopen"') - 40, html.indexOf('id="roster-reopen"') + 260);
  assert.ok(/class="reopen-tab"/.test(btn) && btn.includes('Mostrar Repartidores') && btn.includes('id="reopen-roster-n"'),
    'the re-open tab button has the label/aria and a count element');
  // wiring: click re-opens the panel; the count mirrors the on-shift roster count
  assert.match(html, /\$\('roster-reopen'\)\?\.addEventListener\('click',\s*\(\)\s*=>\s*togRail\('right-open'\)\)/, 'the re-open tab re-opens the right panel');
  assert.match(html, /\$\('reopen-roster-n'\)[^\n]*textContent\s*=\s*String\(live\.length\)/, 'the re-open tab count mirrors the on-shift roster count');
  ok('§4c: a persistent re-open tab (collapsed-only) re-opens the Repartidores panel and shows the live count');
}

console.log(`dispatch-polish-deadends: OK (${n})`);
