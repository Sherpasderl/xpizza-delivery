// xpizza-dispatch/dispatch-config-screen-removed.test.js
//
// Polish §2 (CTA audit #6) — the first-run config screen (#screen-config + «Guardar y entrar») was fully
// built but UNREACHABLE (showScreen was only ever called with 'login'/'main') and the save button had no
// handler (config is a committed constant). Owner approved option A: REMOVE it. This guard asserts the dead
// screen, its button, inputs and copy are gone, that showScreen no longer references a 'config' screen (so
// $('screen-config') can't throw), and that the LOGIN screen is untouched.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

for (const s of ['id="screen-config"', 'id="config-save-btn"', 'id="firebase-config-input"', 'id="maps-key-input"',
  'Configuración inicial', 'Guardar y entrar', 'Pega la configuración de Firebase'])
  assert.ok(!html.includes(s), `removed: ${s}`);
ok('the dead config screen, its save button, inputs and copy are gone');

// showScreen must no longer try to toggle a 'config' screen (it would throw on a null element).
const ssStart = html.indexOf('function showScreen(');
const ss = html.slice(ssStart, html.indexOf('\n}', ssStart) + 2);
assert.ok(ssStart > -1 && ss, 'located showScreen');
assert.ok(!ss.includes("'config'"), "showScreen no longer references a 'config' screen");
assert.match(ss, /\[\s*'login',\s*'main'\s*\]/, 'showScreen iterates only login + main');
ok('showScreen toggles only the login and main screens');

// the config-form-only CSS rule is gone, but login still works (no collateral damage).
assert.ok(!html.includes('.config-form'), 'config-form CSS removed');
assert.ok(html.includes('.login-form'), 'login-form CSS preserved');
assert.ok(html.includes('id="login-btn"') && html.includes('id="screen-login"'), 'the login screen is intact');
ok('login screen + its form CSS preserved; no collateral damage');

console.log(`dispatch-config-screen-removed: OK (${n})`);
