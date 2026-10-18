// H1b T7 — the structural guards (PLAN-H1b T7): copy exact to the prototype/boards (+ the approved additions in copy.js), no
// restaurant/brand literal, every interactive element a real <button>/<input> with a label, and the vendored files' checksums.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { COPY, BOARD, ADVISOR } from './copy.js';
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
  ...Object.values(BOARD), ...Object.values(ADVISOR), C1_NO_LOCATIONS, C2_BROWSER_NOTE];
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

// A small JS string-literal tokenizer (codex H1b r1 P2-14): comments skipped, '…' "…" and `…${…}…` (nested) collected, regex
// literals skipped — a URL inside a template literal or a quote inside a regex no longer derails it.
export function stringLiterals(src) {
  const out = []; let i = 0; let prev = '';
  const isRegexStart = () => /^$|[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || /\b(return|typeof|case|in|of)$/.test(prev);
  function readString(q) {                            // i at the opening quote
    let buf = ''; i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { buf += src[i + 1] === undefined ? '' : src[i + 1]; i += 2; continue; }
      if (c === q) { i++; return buf; }
      if (q === '`' && c === '$' && src[i + 1] === '{') {
        buf += '\u0000'; i += 2; let depth = 1;
        while (i < src.length && depth > 0) {
          const d = src[i];
          if (d === "'" || d === '"' || d === '`') { out.push(readString(d)); continue; }
          if (d === '{') depth++; else if (d === '}') depth--;
          i++;
        }
        continue;
      }
      buf += c; i++;
    }
    return buf;
  }
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { out.push(readString(c)); prev = 'x'; continue; }
    if (c === '/' && isRegexStart()) {
      i++; let cls = false;
      while (i < src.length) { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; i++; }
      i++; while (/[a-z]/i.test(src[i] || '')) i++; prev = 'x'; continue;
    }
    if (!/\s/.test(c)) prev = (/[\w$]/.test(c) ? (prev + c).slice(-8) : c);
    i++;
  }
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

test('the literal scanner sees double quotes, template pieces, and ignores comments and regexes (P2-14)', () => {
  const lits = stringLiterals(`const a = "Texto nunca aprobado"; // 'comentario'\nconst b = \`x \${'adentro'} y\`; const r = /["']/g; /* "no" */ const c = 'fin';`);
  assert.deepEqual(lits, ['Texto nunca aprobado', 'adentro', 'x \u0000 y', 'fin']);
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

test('the app imports Firebase ONLY from vendor/ (no CDN at runtime); the one remote script is Maps, only when a key is configured', () => {
  const src = read('./app.js');
  const urls = [...src.matchAll(/https?:\/\/[^\s'"`$]+/g)].map((m) => m[0]);
  assert.deepEqual([...new Set(urls)].sort(), ['https://maps.googleapis.com/maps/api/js?key=', 'https://wa.me/'], 'only the Maps loader and the WhatsApp deep link');
  assert.match(src, /if \(!MAPS_KEY \|\| mapsRequested/, 'Maps loads only behind MAPS_KEY');
  for (const m of src.matchAll(/from '([^']+)'/g)) assert.ok(m[1].startsWith('./'), m[1]);
});

test('codex H1b r1 P1-2: the human who pairs signs in on a SEPARATE in-memory Auth app; the device identity keeps the persistent default app', () => {
  const src = read('./app.js');
  assert.match(src, /const humanAuth = initializeAuth\(humanApp, \{ persistence: inMemoryPersistence \}\);/);
  assert.match(src, /signInHuman: \(e, p\) => signInWithEmailAndPassword\(humanAuth, e, p\)/, 'human email/password only on the in-memory app');
  assert.ok(!/signInWithEmailAndPassword\(auth\b/.test(src), 'never on the persistent device app');
  assert.match(src, /signInWithToken: async \(tk\) => \(await signInWithCustomToken\(auth, tk\)\)\.user/, 'the device custom token on the default (persistent) app');
  assert.match(src, /startPairing\(\{ auth: pairingAuth, call: humanCall, store \}/, 'pairing callables run as the in-memory human');
});
