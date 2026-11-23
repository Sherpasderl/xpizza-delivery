// The asm9 SBS defects (the SBS review's CLASSIFICATION-asm9, D1–D6), each pinned where the DOM can show it; the re-shoot of the
// frames is the next Chrome turn's. RED first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

// SBS DIR3 slot 11-22 (16b; OWNER «fix everywhere»): a row subtitle never leaves its last word alone on a line («Portón de metal
// / negro»). ONE helper (capp-text.js, shared by capp-home + capp-push) glues the last two words with a no-break space AFTER
// escaping; the CSS keeps balance + pretty. The census below makes every `.rowbtn .t` subtitle go through it.
test('ORPHAN-1 (16b): noOrphan glues the last two words with U+00A0 — on ESCAPED text, entities intact, never markup', () => {
  const T = require('./capp-text.js');
  assert.equal(T.noOrphan('Portón de metal negro'), 'Portón de metal\u00a0negro', '🔴 ORPHAN-1: the last word never stands alone');
  assert.equal(T.noOrphan('Casa &amp; Jardín'), 'Casa &amp;\u00a0Jardín', '🔴 ORPHAN-1: an escaped entity stays whole');
  assert.ok(!/&nbsp;|</.test(T.noOrphan('a b c')), 'ORPHAN-1: a character, never an entity or markup');
  assert.equal(T.noOrphan('Pedidos'), 'Pedidos', 'one word: unchanged');
  assert.equal(T.noOrphan(''), '', 'empty: unchanged');
  assert.equal(T.noOrphan('Frente al estacionamiento subterráneo'), 'Frente al estacionamiento\u00a0subterráneo', '🔴 ORPHAN-1 (Codex #260 P2-2): a long pair that FITS is glued too (no cutoff; the CSS breaks a pair wider than the line)');
  assert.equal(T.noOrphan('Portón de metal  negro'), 'Portón de metal\u00a0negro', '🔴 ORPHAN-1 (Codex #260 P2-1): a run of spaces before the last word collapses to ONE U+00A0');
  assert.equal(T.noOrphan('Portón de metal\t negro'), 'Portón de metal\u00a0negro', '🔴 ORPHAN-1 (Codex #260 P2-1): a tab in the run too');
});

test('ORPHAN-2 (16b, the real writer): the «Direcciones» row of the SBS frame renders «… metal\u00a0negro»', () => {
  const H = require('./capp-home.js');
  const d = dom(H.addressesHtml({ dir: { rows: [{ id: 'a1', label: 'Casa', detected: 'Col. Palmira, Calle 5', details: 'Portón de metal  negro' }], sel: 'a1' } }));   // Codex #260: two spaces typed
  const sub = d.querySelector('.rowbtn[data-id="a1"] .t > span');
  assert.equal(sub.textContent, 'Col. Palmira, Calle 5 · Portón de metal\u00a0negro', '🔴 ORPHAN-2: the address subtitle is glued');
  assert.ok(/\.rowbtn \.t span\{[^}]*text-wrap:balance;text-wrap:pretty/.test(CSS), '🔴 ORPHAN-2: balance, then pretty where the WebView has it');
  assert.ok(/\.rowbtn \.t span\{[^}]*overflow-wrap:break-word/.test(CSS), '🔴 ORPHAN-2 (Codex #260 P2-2): a glued pair wider than the line breaks inside the word, never overflows');
});

// CONSENT text is never glued (advisor 11-23): push's offers sub-line (PUSH_OFFERS_COPY_VERSION) and G7's email + WhatsApp consent
// line render byte-identical. Codex #260 P2-3: the exemptions are the two NAMED consent rows — the promos row's own
// `${COPY.promosSub}`, and push's row() ONLY at its call that passes COPY.offersSub (every other row() call passes noOrphan(…)).
test('ORPHAN-CENSUS (16b): EVERY `.rowbtn .t` subtitle in the app goes through noOrphan — a new row cannot skip it', () => {
  const files = readdirSync(HERE).filter((f) => f.endsWith('.js') && /class=\\?"rowbtn/.test(readFileSync(join(HERE, f), 'utf8')));
  assert.deepEqual(files.sort(), ['capp-home.js', 'capp-push.js'], 'ORPHAN-CENSUS: the files that draw a .rowbtn (a new one joins this census)');
  const CONSENT = { 'capp-push.js': ['${COPY.promosSub}</span>', '${sub}</span>'] };
  const skipped = [];
  let n = 0;
  for (const f of files) {
    const src = readFileSync(join(HERE, f), 'utf8');
    for (const m of src.matchAll(/<span class="t">/g)) {
      const opens = [...src.slice(0, m.index).matchAll(/<(?:button|div) class="([^"]*)"/g)];
      if (!opens.length || !/(^| )rowbtn( |$)/.test(opens[opens.length - 1][1])) continue;   // the row this .t sits in
      // the .t element itself: walk its span tags to the one that closes it; each span opened INSIDE it (any attributes) is a subtitle
      const tags = /<span\b[^>]*>|<\/span>/g; tags.lastIndex = m.index + m[0].length;
      for (let depth = 1, t; depth && (t = tags.exec(src));) {
        if (t[0] === '</span>') { depth--; continue; }
        depth++; n++;
        const e = src.slice(t.index + t[0].length);
        if (!e.startsWith('${noOrphan(') && !(CONSENT[f] || []).some((c) => e.startsWith(c))) skipped.push(`${f}: ${src.slice(t.index, t.index + 70)}`);
      }
    }
  }
  assert.ok(n >= 13, `premise: the census sees the subtitles (${n})`);
  assert.deepEqual(skipped, [], '🔴 ORPHAN-CENSUS: a .rowbtn subtitle that skips noOrphan');
  const push = readFileSync(join(HERE, 'capp-push.js'), 'utf8'), calls = [...push.matchAll(/\brow\('(\w+)', ([^,]+),/g)].map((c) => [c[1], c[2]]);
  assert.ok(calls.length >= 2, `premise: push's row() calls (${calls.length})`);
  assert.deepEqual(calls.filter(([, a]) => a === 'COPY.offersSub').map(([k]) => k), ['promociones'], 'ORPHAN-CENSUS: the ONE consent call of row() is the phone offers row');
  assert.deepEqual(calls.filter(([, a]) => a !== 'COPY.offersSub' && !a.startsWith('noOrphan(')), [], '🔴 ORPHAN-CENSUS: a non-consent row() call passes its subtitle unglued');
});

test('ORPHAN-CONSENT (advisor 11-23): consent text renders BYTE-IDENTICAL — never glued — while the other «Notificaciones» sub-lines are', () => {
  const P = require('./capp-push.js');
  const sub = (h, sel) => [...dom(h).querySelectorAll(`${sel} .t > span`)].map((x) => x.textContent);
  for (const vm of [{ app: true, granted: true, pedidos: true, promociones: false, promos: true, settled: true }, { app: true, denied: true, promos: false, settled: true }, { app: true, granted: true }]) {
    const subs = sub(P.screenHtml(vm), '.rowbtn');
    assert.ok(subs.includes(P.COPY.offersSub), '🔴 ORPHAN-CONSENT: the push-offers consent text, byte-identical');
    assert.ok(subs.includes(P.COPY.promosSub), '🔴 ORPHAN-CONSENT: the email + WhatsApp consent text, byte-identical');
    assert.ok(subs.includes('Cuando cambie el\u00a0estado') && subs.includes('Siempre activo: es como te\u00a0avisamos'), '🔴 ORPHAN-CONSENT: the non-consent sub-lines are glued (the census exempts push\'s row() — its orders caller glues)');
  }
});
