// H1b T7 — the structural guards (PLAN-H1b T7): copy exact to the prototype/boards (+ the approved additions in copy.js), no
// restaurant/brand literal, every interactive element a real <button>/<input> with a label, and the vendored files' checksums.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { COPY, BOARD, ADVISOR, KIOSK } from './copy.js';
import { C1_NO_LOCATIONS } from './setup.js';
import { C2_BROWSER_NOTE } from './bridge.js';

const here = (p) => new URL(p, import.meta.url);
const read = (p) => fs.readFileSync(here(p), 'utf8');
const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const norm = (s) => decode(s).replace(/\s+/g, ' ').trim();

// the spec corpus: every board and the prototype, tags stripped (their markup text AND their script strings)
const specText = (f) => {
  const src = read(`./spec/${f}`);
  const scripts = [...src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join(' \n ');   // JS strings, raw
  const markup = src.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ');
  return `${norm(markup)} \n ${norm(scripts)}`;
};
const corpus = fs.readdirSync(here('./spec/')).filter((f) => f.endsWith('.html')).map(specText).join(' \n ');
const approved = [...Object.values(COPY).filter((v) => typeof v === 'string'), COPY.reconnected(1), 'Conexión restablecida ·', 'acciones enviadas',
  ...Object.values(BOARD), ...Object.values(ADVISOR), ...Object.values(KIOSK), C1_NO_LOCATIONS, C2_BROWSER_NOTE];
const known = (s) => corpus.includes(s) || approved.some((a) => a.includes(s));

const template = (() => { const h = read('./index.html'); return h.slice(h.indexOf('<template id="screen">') + 22, h.indexOf('</template>')); })();

test('copy: every text node of the screen template is prototype / board text or approved', () => {
  const texts = template.replace(/<sc-[^>]*>|<\/sc-[^>]*>/g, ' ').replace(/<svg[\s\S]*?<\/svg>/g, ' ').replace(/<[^>]+>/g, '\n')
    .split('\n').map((s) => norm(s.replace(/\{\{[^}]*\}\}/g, '\u0000'))).filter((s) => /[A-Za-zÁÉÍÓÚáéíóúñ]/.test(s));
  const parts = texts.flatMap((s) => s.split('\u0000').map((x) => x.trim()).filter((x) => /[A-Za-zÁÉÍÓÚáéíóúñ]{2}/.test(x)));
  const unknown = parts.filter((p) => !known(p));
  assert.deepEqual(unknown, []);
  assert.ok(parts.length > 60, `the template carries the prototype's copy (${parts.length} fragments)`);
});

// codex H1b r2 P2-6: the string literals come from a REAL parser (acorn, already a dependency of xpizza-functions) — no hand
// tokenizer to fool with regex-literal contexts or escapes. String values arrive DECODED ("\n" is a newline), template literals give
// their cooked quasis with \u0000 at each ${…}.
import { createRequire } from 'node:module';
const acorn = createRequire(new URL('../xpizza-functions/package.json', import.meta.url))('acorn');
export function stringLiterals(src) {
  const out = [];
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === 'Literal' && typeof n.value === 'string') out.push(n.value);
    if (n.type === 'TemplateLiteral') out.push(n.quasis.map((q) => (q.value.cooked == null ? q.value.raw : q.value.cooked)).join('\u0000'));
    for (const [k, v] of Object.entries(n)) if (k !== 'type' && v && typeof v === 'object') walk(v);
  }(ast));
  return out;
}

test('copy: every Spanish string literal the modules can show is prototype / board text or approved', () => {
  // never shown on the device: the device LABEL sent to merchantPairDevice (shown in the portal), a programmer-error throw
  const TECH = new Set(['Equipo de la sucursal', 'is not a queued action']);
  const files = ['model.js', 'view.js', 'app.js', 'api.js', 'setup.js', 'bridge.js', 'copy.js', 'morph.js'];
  const unknown = [];
  for (const f of files) {
    for (const raw of stringLiterals(read(`./${f}`))) {
      if (!/[a-záéíóúñ]{3,}\s+[a-záéíóúñ]{2,}/i.test(raw) && !/[«»¿¡áéíóúñ·…]/.test(raw)) continue;   // looks like a phrase
      for (const piece of raw.split('\u0000').map((x) => norm(x)).filter((x) => /[A-Za-záéíóúñ]{3}/.test(x))) {
        if (TECH.has(piece) || known(piece) || /^[a-z_]+$/.test(piece)) continue;
        unknown.push(`${f}: ${piece}`);
      }
    }
  }
  assert.deepEqual(unknown, []);
});

test('the literal scanner is a real parser: double quotes, template pieces, decoded escapes; regex contexts and comments cannot hide a string (r1 P2-14, r2 P2-6)', () => {
  const lits = stringLiterals(`const a = "Texto nunca aprobado"; // 'comentario'\nconst b = \`x \${'adentro'} y\`; const r = /["']/g; /* "no" */ const c = 'fin';`);
  assert.deepEqual(lits.sort(), ['Texto nunca aprobado', 'adentro', 'fin', 'x \u0000 y'].sort());
  // codex r2 reproductions: a regex STATEMENT after ')' and escaped newlines
  const tricky = stringLiterals(`if (x) /["']/g.test(x); toast("Texto nunca aprobado"); toast("Texto\\nnunca\\naprobado");`);
  assert.ok(tricky.includes('Texto nunca aprobado'), 'the string after a regex statement is seen');
  assert.ok(tricky.includes('Texto\nnunca\naprobado'), 'escapes are decoded — the phrase detector sees real whitespace');
});

test('no restaurant / brand literal in any shipped file (spec copies, vendor and the platform config excepted)', () => {
  const LIT = [/fonda\s*mirador/i, /x_pizza/i, /xpizza/i, /la_musa/i, /la musa/i, /los próceres/i, /circunvalación/i, /altara/i, /carlos/i];
  const files = fs.readdirSync(here('./')).filter((f) => /\.(js|html|css)$/.test(f) && !f.endsWith('.test.js') && f !== 'config.js');
  const hits = [];
  for (const f of files) for (const re of LIT) if (re.test(read(`./${f}`))) hits.push(`${f}: ${re}`);
  assert.deepEqual(hits, []);
});

test('every interactive element is a real <button> (or an input with a label); no inline handler', () => {
  const clickable = [...template.matchAll(/<(\w+)[^>]*onClick=/gi)].map((m) => m[1].toLowerCase());
  assert.ok(clickable.length > 40);
  assert.deepEqual([...new Set(clickable)], ['button']);
  for (const m of template.matchAll(/<input\b[^>]*>/g)) {
    const tag = m[0]; const id = (tag.match(/\bid="([^"]+)"/) || [])[1];
    assert.ok(/aria-label="/.test(tag) || (id && template.includes(`for="${id}"`)), `labelled: ${tag}`);
  }
  assert.ok(!/\son(?!Click)[a-z]+=/i.test(template), 'no other inline handlers');
  for (const m of template.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)) {
    const inner = m[1].replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '').trim();
    assert.ok(inner || /aria-label="/.test(m[0]), `a button with a name: ${m[0].slice(0, 80)}`);
  }
});

test('vendor + font checksums: SHA256SUMS verified (a mismatch is red)', () => {
  for (const dir of ['vendor', 'fonts']) {
    const lines = read(`./${dir}/SHA256SUMS`).trim().split('\n');
    assert.ok(lines.length >= 1);
    for (const l of lines) {
      const [hash, file] = l.trim().split(/\s+/);
      const got = crypto.createHash('sha256').update(fs.readFileSync(here(`./${dir}/${file}`))).digest('hex');
      assert.equal(got, hash, `${dir}/${file}`);
    }
  }
  const sums = read('./vendor/SHA256SUMS');
  for (const f of ['firebase-app.js', 'firebase-auth.js', 'firebase-database.js', 'firebase-functions.js']) assert.ok(sums.includes(f), f);
  for (const f of ['firebase-auth.js', 'firebase-database.js', 'firebase-functions.js']) assert.ok(!/gstatic\.com/.test(read(`./vendor/${f}`)), `${f} loads nothing remote`);
});

// OWNER DECISION 2026-10-19 (kiosk k9, PLAN-H1c-kiosk-addendum §4): the handheld runs in lock task, so NO path may leave the app —
// the WhatsApp action was removed (option c; the restaurant contacts the customer through Despacho). Every shipped source (raw
// text, comments included — stricter) is scanned for any way to open another app, the browser or Settings.
test('kiosk k9: no external-launch path — no wa.me / window.open / location navigation / intent: / tel: / mailto: / target=_blank', () => {
  const files = fs.readdirSync(here('./')).filter((f) => /\.(js|html)$/.test(f) && !/\.test\.js$|^test-/.test(f));
  assert.ok(files.includes('app.js') && files.includes('index.html') && files.includes('view.js'), 'non-vacuity: the shipped sources are scanned');
  const forbidden = [/wa\.me/i, /api\.whatsapp/i, /whatsapp:/i, /window\.open\s*\(/, /\blocation\.(href|assign|replace)\b/, /\bintent:/, /\btel:/, /\bmailto:/, /target\s*=\s*["']_blank/, /\bsms:/];
  for (const f of files) {
    const src = read(`./${f}`);
    for (const re of forbidden) assert.ok(!re.test(src), `🔴 ${f} contains an external-launch path (${re}) — kiosk k9 forbids leaving the app`);
  }
  // sensitivity: the scan catches the removed action's exact shape
  assert.ok(forbidden.some((re) => re.test("window.open(`https://wa.me/${p}`, '_blank')")), 'non-vacuity: the old WhatsApp launch would be caught');
});

test('the app imports Firebase ONLY from vendor/ (no CDN at runtime); the one remote script is Maps, only when a key is configured', () => {
  const src = read('./app.js');
  const urls = [...src.matchAll(/https?:\/\/[^\s'"`$]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(urls)].sort(), ['https://maps.googleapis.com/maps/api/js?key='], 'only the Maps loader (loaded INSIDE the WebView)');
  assert.match(src, /if \(!MAPS_KEY \|\| mapsRequested/, 'Maps loads only behind MAPS_KEY');
  for (const m of src.matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('./'), m[1]);
});

test('codex H1b r1 P1-2: the human who pairs signs in on a SEPARATE in-memory Auth app; the device identity keeps the persistent default app', () => {
  const src = read('./app.js');
  assert.match(src, /const humanAuth = initializeAuth\(humanApp, \{ persistence: inMemoryPersistence \}\);/);
  assert.match(src, /signInHuman: \(e, p\) => signInWithEmailAndPassword\(humanAuth, e, p\)/, 'human email/password only on the in-memory app');
  assert.ok(!/signInWithEmailAndPassword\(auth\b/.test(src), 'never on the persistent device app');
  assert.match(src, /signInWithToken: async \(tk, uid\) => \{ authWatch\.expect\(uid\); return \(await signInWithCustomToken\(auth, tk\)\)\.user; \}/, 'the device custom token on the default (persistent) app, the watch armed first');
  assert.match(src, /startPairing\(\{ auth: pairingAuth, call: humanCall, store \}/, 'pairing callables run as the in-memory human');
});
