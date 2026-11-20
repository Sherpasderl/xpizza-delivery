import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Polish §3 (CTA audit #7) — mobile sign-out dropped the session on one tap. Add a confirm STEP inside the
// Ajustes sheet: «Cerrar sesión» opens a pushed confirm sheet; the actual sign-out runs only on its «Cerrar
// sesión» button; «Cancelar»/back returns to Ajustes. signOutUser is auth (no DB write) — read-only intact.

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');

test('§3: the confirm sheet exists with the title, mobile body and the two actions', () => {
  const start = html.indexOf('function openSignoutConfirm(');
  assert.ok(start > -1, 'openSignoutConfirm is defined');
  const fnSrc = html.slice(start, html.indexOf('\n}', start) + 2);
  assert.match(fnSrc, /¿Cerrar sesión\?/, 'confirm title');
  assert.ok(fnSrc.includes('Vas a salir de la Central en este teléfono. Para volver a entrar vas a necesitar tu correo y contraseña.'), 'mobile confirm body (verbatim)');
  assert.match(fnSrc, /data-signout-commit="1"[^>]*>Cerrar sesión</, 'the confirm «Cerrar sesión» button carries data-signout-commit');
  assert.match(fnSrc, /data-settings="1"[^>]*>Cancelar</, 'a «Cancelar» returns to Ajustes');
});

test('§3: tapping «Cerrar sesión» in Ajustes OPENS the confirm (does not sign out directly)', () => {
  // the Ajustes button still carries data-signout; its handler now opens the confirm sheet.
  assert.match(html, /data-signout="1"[^>]*>Cerrar sesión</, 'Ajustes keeps the «Cerrar sesión» entry (data-signout)');
  assert.match(html, /if \(ds\.signout\)\{[^}]*openSignoutConfirm\(\)/, 'ds.signout opens the confirm sheet');
  // the real sign-out moved to data-signout-commit.
  assert.match(html, /if \(ds\.signoutCommit\)\{[\s\S]*?XPD\.signOutUser\(\)/, 'ds.signoutCommit performs the sign-out');
  assert.match(html, /if \(ds\.settings\)\{[^}]*openSettings\(\)/, 'ds.settings returns to Ajustes');
});

test('§3: the new delegation attributes are wired', () => {
  const list = html.slice(html.indexOf("e.target.closest?.('["), html.indexOf("');", html.indexOf("e.target.closest?.('[")));
  for (const a of ['[data-signout]', '[data-signout-commit]', '[data-settings]'])
    assert.ok(list.includes(a), `delegation includes ${a}`);
});

test('§3: the direct one-tap sign-out from Ajustes is gone', () => {
  // ds.signout must NOT call signOutUser directly any more (that moved behind the confirm).
  const sig = html.slice(html.indexOf('if (ds.signout){'), html.indexOf('if (ds.signoutCommit)'));
  assert.ok(!sig.includes('signOutUser'), 'ds.signout no longer signs out directly');
});
