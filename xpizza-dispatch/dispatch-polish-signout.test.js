// xpizza-dispatch/dispatch-polish-signout.test.js
//
// Polish §3 (CTA audit #7) — sign-out used to drop the session on one click, no confirm. Relabel «Salir» →
// «Cerrar sesión» and route it through the generic styledConfirm (with the owner-approved copy + the busy
// «Cerrando sesión…» state), only signing out on confirm.
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// relabel
assert.match(html, /id="signout-btn"[^>]*>Cerrar sesión</, 'the account-menu item is relabelled «Cerrar sesión»');
assert.ok(!html.includes('>Salir</button>'), 'the old «Salir» label is gone');
ok('«Salir» → «Cerrar sesión» in the account menu');

// the sign-out handler confirms first, then signs out
const start = html.indexOf("$('signout-btn').addEventListener('click'");
assert.ok(start > -1, 'located the sign-out handler');
const region = html.slice(start, start + 900);
assert.ok(region.includes('await styledConfirm({'), 'sign-out goes through styledConfirm');
assert.ok(region.includes("title: '¿Cerrar sesión?'"), 'confirm title');
assert.ok(region.includes('Vas a salir de la Central en este dispositivo. Para volver a entrar vas a necesitar tu correo y contraseña.'), 'desktop confirm body (verbatim)');
assert.ok(region.includes("confirmLabel: 'Cerrar sesión'"), 'confirm button «Cerrar sesión»');
assert.ok(region.includes("busyLabel: 'Cerrando sesión…'"), 'busy label «Cerrando sesión…»');
// Codex #241 P3: the approved sub line «<email> · este dispositivo»
assert.ok(region.includes("$('topbar-user')?.textContent") && region.includes('· este dispositivo'),
  'the confirm sub shows the signed-in email + «este dispositivo»');
// the actual sign-out runs inside onConfirm (so a decline does nothing), before the handler ends
const oc = region.indexOf('onConfirm');
assert.ok(oc > -1 && region.indexOf('XPD.signOutUser()', oc) > -1 && region.indexOf('requestReload()', oc) > -1,
  'onConfirm signs out + requestReload (only on confirm)');
assert.ok(region.indexOf('await styledConfirm({') < region.indexOf('XPD.signOutUser()'),
  'the confirm runs BEFORE the sign-out');
ok('sign-out is confirmed through styledConfirm; onConfirm signs out + reloads');

console.log(`dispatch-polish-signout: OK (${n})`);
