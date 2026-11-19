// The asm9 SBS defects (the SBS review's CLASSIFICATION-asm9, D1–D6), each pinned where the DOM can show it; the re-shoot of the
// frames is the next Chrome turn's. RED first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = join(HERE, '..');
const require = createRequire(import.meta.url);
const { JSDOM } = createRequire(join(ROOT, 'xpizza-functions/x.js'))('jsdom');
const CSS = readFileSync(join(HERE, 'capp.css'), 'utf8');
const dom = (html) => new JSDOM(`<!doctype html><body>${html}</body>`).window.document;

test('D3 (C-2, 16b/16c): the comment hint is NOT the global bordered `.opt` box — it sits beside «Comentario» as plain hint text', () => {
  const R = require('./capp-rate.js');
  const d = dom(R.sheetHtml({ storeName: 'X. Pizza', num: 4821, dishes: [{ id: 'd1', name: 'Margherita' }], delivery: true, value: null, initial: null, editable: true }));
  const hint = [...d.querySelectorAll('label.lbl span')].find((s) => /opcional, lo lee el restaurante/.test(s.textContent));
  assert.ok(hint, 'premise: the hint beside the label');
  assert.equal(d.querySelectorAll('.rate .opt').length, 0, '🔴 D3: no element of the rate sheet carries the global `.opt` (a 64 px bordered option box)');
  assert.ok(/\.opt\{[^}]*border:/.test(CSS), 'premise: `.opt` IS the bordered option box');
});

test('D6 (robustness / 16b): a logo that FAILS to load becomes the initials plate — never the broken-image glyph + overflowing alt text', () => {
  const H = require('./capp-home.js');
  assert.equal(typeof H.logoFallback, 'function', '🔴 D6: the ONE fallback (installed once by the shell)');
  const d = dom('<div class="avatar"><img src="x.png" alt="X Pizza" data-initials="XP"></div><span class="logo"><img src="y.png" alt="" data-initials="LM"></span><img class="other" src="z.png">');
  H.logoFallback(d);
  for (const img of [...d.querySelectorAll('img[data-initials]')]) img.dispatchEvent(new d.defaultView.Event('error'));
  const [av, lg] = [d.querySelector('.avatar'), d.querySelector('.logo')];
  assert.ok(av.classList.contains('txt') && av.textContent === 'XP' && !av.querySelector('img'), '🔴 D6: the store avatar ⇒ «XP» plate');
  assert.ok(lg.classList.contains('txt') && lg.textContent === 'LM' && !lg.querySelector('img'), '🔴 D6: the card chip ⇒ «LM» plate');
  assert.equal(av.getAttribute('aria-hidden'), 'true', 'the plate is decorative (the name is beside it)');
  assert.ok(d.querySelector('img.other'), 'an unrelated image is never touched');
  const src = readFileSync(join(HERE, 'capp-ui.js'), 'utf8') + readFileSync(join(HERE, 'capp-home.js'), 'utf8');
  // every logo image (store avatar, card chip, the checkout's chip — LF-1, the offers SBS 11-15) carries its initials
  const logos = [...src.matchAll(/<img src="\$\{esc\((?:cfg|r)\.logo\)\}" alt="[^"]*"( data-initials=)?/g)];
  assert.equal(logos.length, 3, 'premise: the three logo images');
  assert.deepEqual(logos.filter((m) => !m[1]).map((m) => m[0]), [], '🔴 D6: EVERY logo image carries its initials');
  assert.ok(/CappHome\.logoFallback\(doc\)/.test(readFileSync(join(HERE, 'capp-shell-ui.js'), 'utf8')), '🔴 D6: the shell installs it');
});

test('D2 (C-6c desk, 16b) + Codex P2: «Envío desde L 45» stays on ONE line (f2a) and the cells NEVER overflow the tools column — when they do not fit beside the Delivery/Pickup toggle they move below it, full width', () => {
  const row = CSS.match(/\.app\.desk \.sinfo \.toolrow\{[^}]*\}/)[0], cells = CSS.match(/\.app\.desk \.cells\{[^}]*\}/)[0], b = CSS.match(/\.app\.desk \.cells b\{[^}]*\}/)[0];
  assert.ok(/white-space:nowrap/.test(b), '🔴 D2: the bold line never breaks');
  assert.ok(/flex-wrap:wrap/.test(row), '🔴 P2: the tools row wraps (the cells go below the toggle instead of overflowing)');
  assert.ok(/min-width:fit-content/.test(cells) && /flex:1 1 auto/.test(cells), '🔴 P2: the cells box is never narrower than its content, and fills its line');
  assert.ok(!/flex:1 0 auto/.test(cells), '🔴 P2: no non-shrinking box forced beside the toggle');
});

test('Codex P3: logoFallback returns its cleanup and the shell\'s destroy() removes it — mounting twice leaves ONE listener', () => {
  const H = require('./capp-home.js');
  const d = dom('<div class="avatar"><img src="x.png" data-initials="XP"></div>');
  let n = 0; const add = d.addEventListener.bind(d), rem = d.removeEventListener.bind(d);
  d.addEventListener = (t, f, o) => { if (t === 'error') n++; return add(t, f, o); }; d.removeEventListener = (t, f, o) => { if (t === 'error') n--; return rem(t, f, o); };
  const off = H.logoFallback(d);
  assert.equal(typeof off, 'function', '🔴 P3: logoFallback returns its cleanup'); assert.equal(n, 1);
  off(); assert.equal(n, 0, '🔴 P3: the cleanup removes the listener');
  d.querySelector('img').dispatchEvent(new d.defaultView.Event('error'));
  assert.ok(d.querySelector('img'), 'removed ⇒ inert');
  assert.ok(/logoOff\(\)/.test(readFileSync(join(HERE, 'capp-shell-ui.js'), 'utf8')), '🔴 P3: the shell\'s destroy() calls it');
});

// slot-owed 11-18 (rule 16b, advisor GO 1–4 + 10): text-fit defects the SBS showed at 390 and 1440, light and dark — CSS only.
// The DOM cannot measure a wrap; these pin the rules, and the SBS fit probe (orphan count 0) is the gate at the next slot.
const CSS_NC = CSS.replace(/\/\*[\s\S]*?\*\//g, '');   // comments stripped (a trailing comment would join the next selector)
const ruleBody = (sel) => { const m = [...CSS_NC.matchAll(/(?<=^|[{}])\s*([^{}@]+)\{([^{}]*)\}/g)].filter((x) => x[1].split(',').map((s) => s.trim()).includes(sel)); return m.map((x) => x[2]).join(';'); };
const wraps = (sel) => /(^|;)\s*text-wrap\s*:\s*(balance|pretty)\b/.test(ruleBody(sel));

test('slot-owed 11-18 (16b): the WhatsApp number in «Ingresá el código» never breaks at its hyphen («+504 9612-» / «3344.»)', () => {
  const src = readFileSync(join(HERE, 'capp-signup.js'), 'utf8') + readFileSync(join(HERE, 'capp-ui.js'), 'utf8');
  assert.equal([...src.matchAll(/<p class="sub">Te lo enviamos por WhatsApp al <b>\$\{esc\(/g)].length, 2, 'premise: both code sheets put the number in a <b> of .sg .sub');
  assert.ok(/(^|;)\s*white-space\s*:\s*nowrap\b/.test(ruleBody('.sg .sub b')), '🔴 TF-PHONE: `.sg .sub b` is white-space:nowrap');
});

test('slot-owed 11-18 (16b): no orphaned last word — the sign-in subtitle («vez.»), the desk guest line («tarjeta.»), the desk dish cards («Chili» / «sauce»)', () => {
  for (const sel of ['.sg .sub', '.app.desk .guestline', '.app.desk .icard .nm', '.app.desk .icard .ds', '.fld .note']) assert.ok(wraps(sel), `🔴 TF-ORPHAN: \`${sel}\` balances its lines (text-wrap)`);
});

// slot 11-18 (Chrome, R11-store-desk-1440): `text-wrap: pretty` is NOT applied to the 2-line CLAMPED description (a -webkit-box) — «…fresh
// / mozzarella» still orphaned; the clamped box takes `balance`. The phone checkout's field hint «…sobre este / pedido.» (OF-disc-390) is a
// .fld .note — balanced too (advisor 11-18: in scope). The Chrome proof is the SBS fit probe at the next slot.
test('slot 11-18 (16b, Chrome-proven): the clamped desk dish description BALANCES (pretty is ignored on a -webkit-box); the field hint balances', () => {
  assert.ok(/(^|;)\s*text-wrap\s*:\s*balance\b/.test(ruleBody('.app.desk .icard .ds')), '🔴 TF-CLAMP: `.app.desk .icard .ds` is text-wrap:balance (pretty left «mozzarella» alone in Chrome)');
  assert.ok(/(^|;)\s*text-wrap\s*:\s*balance\b/.test(ruleBody('.fld .note')), '🔴 TF-NOTE: `.fld .note` is text-wrap:balance («pedido.» alone at 390)');
});

test('slot-owed 11-18 (advisor GO 10): the centred desktop modal shows no drag handle (a phone-sheet affordance)', () => {
  assert.ok(/(^|;)\s*display\s*:\s*none\b/.test(ruleBody('.app.desk .sheet .grab')), '🔴 TF-GRAB: `.app.desk .sheet .grab` is display:none');
  assert.ok(!/display\s*:\s*none/.test(ruleBody('.grab')), 'the phone sheet keeps its handle');
});
