// PLAN-portal-fonts r1.1 §3.1 — the REAL-SDK origin trace that ratifies the portal's preconnect set (separate from §4's font harness).
// Run at hand-back (HEAVY, slotted; not in the npm chain):  node portal-origins.cdp.mjs [--write]      CHROME_BIN overrides; ORIGINS_REPEATS (3)
//   --capture-sdk   one-time, read-only: fetch the exact Firebase SDK files firebase.js imports (and their relative imports) into
//                   platform/perf/sdk/firebasejs/<ver>/ + sdk.pin.json (sha256 + bytes). No Chrome. Run only when the advisor allows.
// What runs is the real thing: index.html / aceptar.html, the REAL firebase.js / auth.js / aceptar-boot.js and the whole boot graph — NO
// module stub. Every https request is intercepted (CDP Fetch) and answered here: the SDK from the PINNED copy at its real URL, the auth
// hosts + the Functions origin from fixtures in their documented REST shapes, anything else fulfilled empty and REPORTED (a trace failure).
// Nothing leaves loopback. The persisted session is seeded into the SDK's own IndexedDB before boot (fresh / expired / none).
// Admission: an origin is preconnected iff a request to it STARTS before the page's useful-paint marker in T2 or T4, in every repeat.
// --write commits the record to xpizza-portal/perf/portal.origins.json (the portal-fonts.test.mjs guard then asserts the head against it).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { launch, serveDir, router, sleep } from './platform/perf/cdp-fonts.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SITE = 'xpizza-portal';
const read = (f) => fs.readFileSync(path.join(ROOT, SITE, f), 'utf8');
const FB = read('firebase.js');
const SDK_VER = /firebasejs\/([0-9.]+)\//.exec(FB)[1];
const API_KEY = /apiKey: '([^']+)'/.exec(FB)[1];   // the public web key the page ships; used as the persistence key, NEVER printed
const PROJECT = /projectId: '([^']+)'/.exec(FB)[1];
const FN_ORIGIN = new URL(/const BASE = '([^']+)'/.exec(read('api.js'))[1]).origin;
const SDK_DIR = path.join(ROOT, 'platform/perf/sdk/firebasejs', SDK_VER);
const SDK_PIN = path.join(SDK_DIR, 'sdk.pin.json');
const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VER}/`;
const REPEATS = Number(process.env.ORIGINS_REPEATS || 3);
if (!Number.isInteger(REPEATS) || REPEATS < 1) { console.error(`portal-origins.cdp: refused — ORIGINS_REPEATS must be an integer ≥ 1 (got ${JSON.stringify(process.env.ORIGINS_REPEATS)})`); process.exit(2); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ── one-time capture of the exact SDK files (read-only; like the fonts pin) ──
if (process.argv.includes('--capture-sdk')) {
  // ONLY the files the portal itself imports, every import at firebase.js's version (a mixed version would pin the wrong SDK)
  const imports = [...new Set(fs.readdirSync(path.join(ROOT, SITE)).filter((f) => f.endsWith('.js') || f.endsWith('.html'))
    .flatMap((f) => [...read(f).matchAll(/https:\/\/www\.gstatic\.com\/firebasejs\/([0-9.]+)\/([a-z-]+\.js)/g)].map((m) => `${m[1]} ${m[2]}`)))];
  const off = imports.filter((x) => !x.startsWith(`${SDK_VER} `));
  if (off.length) throw new Error(`capture: SDK imports not at firebase.js's ${SDK_VER}: ${off.join(', ')}`);
  fs.mkdirSync(SDK_DIR, { recursive: true });
  const want = imports.map((x) => x.split(' ')[1]);
  const files = []; const done = new Set();
  while (want.length) {
    const name = want.shift(); if (done.has(name)) continue; done.add(name);
    const res = await fetch(SDK_BASE + name); if (!res.ok) throw new Error(`capture: ${name} → ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(SDK_DIR, name), buf);
    files.push({ name, url: SDK_BASE + name, sha256: sha(buf), bytes: buf.length });
    for (const m of buf.toString('utf8').matchAll(/(?:from|import)\s*["']\.\/([a-z0-9-]+\.js)["']/g)) want.push(m[1]);   // relative chunks
    for (const m of buf.toString('utf8').matchAll(/["']https:\/\/www\.gstatic\.com\/firebasejs\/([0-9.]+)\/([a-z0-9-]+\.js)["']/g)) {   // absolute siblings
      if (m[1] !== SDK_VER) throw new Error(`capture: ${name} imports ${m[2]} at ${m[1]}, not ${SDK_VER}`); want.push(m[2]); }
  }
  // the license travels with the copy: each file's own leading license comment, verbatim, collected alongside
  // (a minified file the CDN serves WITHOUT a header is listed as such — it is the same Apache-2.0 package as the headed one)
  const notices = files.map((f) => { const head = (/^\s*(\/\*[\s\S]*?\*\/)/.exec(fs.readFileSync(path.join(SDK_DIR, f.name), 'utf8')) || [])[1];
    return head && /license/i.test(head) ? `== ${f.name} (${f.url})\n${head}\n` : `== ${f.name} (${f.url})\n(served without a license header; same package — the Firebase JS SDK, Apache License 2.0, as firebase-app.js's header in this file states)\n`; });
  if (!notices.some((n) => /Apache License/.test(n))) throw new Error('capture: no pinned file carries the SDK license header');
  fs.writeFileSync(path.join(SDK_DIR, 'LICENSE-HEADERS.txt'), `Firebase JS SDK ${SDK_VER} — the license headers of the pinned files, verbatim (the files themselves are unmodified).\n\n${notices.join('\n')}`);
  fs.writeFileSync(SDK_PIN, JSON.stringify({ version: SDK_VER, capturedAt: new Date().toISOString().slice(0, 10), source: 'the portal\'s own imports (firebase.js / auth.js / aceptar-boot.js) + their relative chunks', files }, null, 2) + '\n');
  console.log(`captured ${files.length} SDK file(s) for ${SDK_VER}: ${files.map((f) => `${f.name} ${f.sha256.slice(0, 10)} ${f.bytes}`).join(', ')}`);
  process.exit(0);
}

const PINNED = JSON.parse(fs.readFileSync(SDK_PIN, 'utf8'));
const SDK_BYTES = new Map(PINNED.files.map((f) => {
  const b = fs.readFileSync(path.join(SDK_DIR, f.name));
  if (sha(b) !== f.sha256 || b.length !== f.bytes) throw new Error(`pinned SDK ${f.name} does not match its pin`);
  return [f.url, b];
}));

// ── fixtures: a fixture JWT (decoded, never verified client-side), the documented REST shapes ──
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (uid, email, expSec) => { const now = Math.floor(Date.now() / 1000);
  return `${b64u({ alg: 'RS256', typ: 'JWT' })}.${b64u({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: uid, user_id: uid, email, email_verified: true, iat: now - 60, exp: expSec, auth_time: now - 3600, firebase: { sign_in_provider: 'password', identities: {} } })}.c2ln`; };
const USER = { uid: 'uOwnerV', email: 'duena@ejemplo.test' };
const lookupBody = (u) => ({ kind: 'identitytoolkit#GetAccountInfoResponse', users: [{ localId: u.uid, email: u.email, emailVerified: true, passwordHash: 'x', providerUserInfo: [{ providerId: 'password', federatedId: u.email, email: u.email, rawId: u.email }],
  passwordUpdatedAt: 1700000000000, validSince: '1700000000', lastLoginAt: String(Date.now() - 3600e3), createdAt: '1700000000000', lastRefreshAt: new Date().toISOString() }] });
const T0 = Date.now();
const MENU = { source: { restaurant_id: 'r_centro', schema_version: 1, items: [{ key: 'Margarita', price: 280, display: { name: 'Margarita', cat: 'cl', price: 280 } }], extras: [],
  structure: { schema_version: 2, item_order: ['Margarita'], categories: [{ id: 'cl', name: 'Clásicas' }] } }, sourceUpdateTime: 'T1', activeVersionId: 'v1', usesPlatformFactura: false, renderedCategories: ['cl'], restaurantName: 'Pizzería Del Valle' };
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.add_product', 'catalog.reset_draft', 'catalog.publish', 'catalog.fiscal_ack', 'stats.read', 'availability.set', 'device.pair', 'device.revoke', 'device.list', 'location.hours', 'location.prep', 'location.pause', 'team.invite', 'team.revoke', 'brand.settings'];
const E1 = { brands: [{ brand_id: 'marca_v', name: 'Pizzería Del Valle' }], membership_writes_enabled: true, branches: [{ rid: 'r_centro', brand_id: 'marca_v', role: 'owner', state: 'member', caps: OWNER_CAPS, name: 'Centro', identity_version: 2,
  editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50497128830' }, control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: 0 }] };
const PREVIEW = { state: 'open', brand_name: 'Pizzería Del Valle', branch_names: ['Centro'], inviter_name: 'Marcela Pineda' };
const INVITE_ID = 'inv_' + 'b'.repeat(24);   // INVITE_ID_RE /^[A-Za-z0-9_-]{22,64}$/ (aceptar.js:13)

const unexpected = [];
function decide(url, req) {
  const u = new URL(url); const j = (b) => ({ body: JSON.stringify(b) });
  if (u.origin === 'https://www.gstatic.com') { const b = SDK_BYTES.get(url.split('?')[0]); if (b) return { body: b, headers: { 'content-type': 'text/javascript' } }; unexpected.push(url); return { status: 404, body: '' }; }
  if (u.origin === 'https://securetoken.googleapis.com' && u.pathname === '/v1/token') {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return j({ access_token: jwt(USER.uid, USER.email, exp), expires_in: '3600', token_type: 'Bearer', refresh_token: 'rt-fixture-2', id_token: jwt(USER.uid, USER.email, exp), user_id: USER.uid, project_id: '1' });
  }
  if (u.origin === 'https://identitytoolkit.googleapis.com') {
    if (/accounts:lookup$/.test(u.pathname)) return j(lookupBody(USER));
    if (/accounts:signInWithEmailLink$/.test(u.pathname)) { let e = 'jorge@ejemplo.test'; try { e = JSON.parse(req.postData || '{}').email || e; } catch (_) {}
      return j({ kind: 'identitytoolkit#EmailLinkSigninResponse', idToken: jwt('uInv', e, Math.floor(Date.now() / 1000) + 3600), email: e, refreshToken: 'rt-inv', expiresIn: '3600', localId: 'uInv', isNewUser: false }); }
    unexpected.push(url); return { status: 400, body: JSON.stringify({ error: { message: 'FIXTURE_UNHANDLED' } }) };
  }
  if (u.origin === FN_ORIGIN) {
    const fn = u.pathname.slice(1);
    if (fn === 'getMyBranches') return j(E1);
    if (fn === 'getEditableCatalog') return j(MENU);
    if (fn === 'getBranchAvailability') return j({ branches: [] });
    if (fn === 'memberInvitePreview') return j(PREVIEW);
    if (fn === 'reportClientVersion') return j({ ok: true });
    return { status: 404, body: JSON.stringify({ error: 'not_found' }) };   // recorded by the trace like any request; never silently dropped
  }
  unexpected.push(url); return { status: 200, body: '' };
}

// ── the persisted session, written by the SDK's own schema (firebaseLocalStorageDb / firebaseLocalStorage / fbase_key) ──
const sessionRecord = (kind) => {
  const expMs = kind === 'fresh' ? Date.now() + 50 * 60e3 : Date.now() - 60e3;
  const at = jwt(USER.uid, USER.email, Math.floor(expMs / 1000));
  return { uid: USER.uid, email: USER.email, emailVerified: true, isAnonymous: false, displayName: null, photoURL: null, phoneNumber: null, tenantId: null,
    providerData: [{ providerId: 'password', uid: USER.email, displayName: null, email: USER.email, phoneNumber: null, photoURL: null }],
    stsTokenManager: { refreshToken: 'rt-fixture', accessToken: at, expirationTime: expMs }, createdAt: '1700000000000', lastLoginAt: String(Date.now() - 3600e3),
    apiKey: API_KEY, appName: '[DEFAULT]' };
};
const SEED = (rec) => `new Promise((ok, bad) => { const r = indexedDB.open('firebaseLocalStorageDb', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
  r.onerror = () => bad(String(r.error));
  r.onsuccess = () => { const db = r.result; const tx = db.transaction('firebaseLocalStorage', 'readwrite');
    tx.objectStore('firebaseLocalStorage').put({ fbase_key: ${JSON.stringify(`firebase:authUser:${API_KEY}:[DEFAULT]`)}, value: ${JSON.stringify(rec)} });
    tx.oncomplete = () => { db.close(); ok(true); }; tx.onerror = () => bad(String(tx.error)); }; })`;

// ── the useful-paint markers (document-start MutationObserver; performance.timeOrigin + now() when FIRST true) ──
const visible = `(e) => { if (!e) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return !e.hidden && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; }`;
const MARKERS = {
  login: `(() => { const v = ${visible}; const f = document.getElementById('loginform'); return v(f) && (f.innerText || '').trim().length > 0; })()`,
  editor: `(() => { const v = ${visible}; const row = document.querySelector('#detail .irow'); return v(row); })()`,
  invite: `(() => { const v = ${visible}; const e = document.getElementById('st-email'), l = document.getElementById('invite-lede'); return v(e) && !!l && l.textContent.trim().length > 0; })()`,
  wrongInvitePane: `(() => { const v = ${visible}; return ['st-invalid', 'st-error', 'st-busy', 'st-password'].filter((id) => v(document.getElementById(id))); })()`,
};
const MARK = (expr) => `(() => { window.__marker = null; const test = () => { try { return ${expr}; } catch (_) { return false; } };
  const hit = () => { if (window.__marker === null && test()) { window.__marker = performance.timeOrigin + performance.now(); mo.disconnect(); } };
  const mo = new MutationObserver(hit); mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener('DOMContentLoaded', hit); })();`;
const STATES = {
  T1: { page: 'index.html', session: null, marker: 'login', admits: false },
  T2: { page: 'index.html', session: 'fresh', marker: 'editor', admits: true },
  T3: { page: 'index.html', session: 'expired', marker: 'editor', admits: false },
  T4: { page: `aceptar.html?invite=${INVITE_ID}&mode=signIn&oobCode=fixture&apiKey=fixture&lang=es`, session: null, marker: 'invite', admits: true },
};

// Codex r1 P2-2 NEGATIVE CONTROL: a page exception thrown AFTER the marker (inside the recorded window) must fail the trace
const THROW_AFTER_MARKER = `(() => { const t = setInterval(() => { if (window.__marker) { clearInterval(t); setTimeout(() => { throw new Error('ORIGINS_CONTROL: thrown after the marker'); }, 200); } }, 20); })();`;
async function trace(name, { throwAfterMarker = false } = {}) {
  const st = STATES[name];
  const srv = await serveDir(ROOT);
  const cdp = await launch({ width: 1280, height: 900, dpr: 1 });   // a fresh profile per state ⇒ cold caches
  try {
    const reqs = []; const errs = [];
    cdp.on('Network.requestWillBeSent', (p) => { if (/^https:/.test(p.request.url)) reqs.push({ url: p.request.url, wall: p.wallTime * 1000, initiator: p.initiator && p.initiator.type, method: p.request.method }); });
    cdp.on('Runtime.exceptionThrown', (p) => errs.push(`exception: ${(p.exceptionDetails.exception && p.exceptionDetails.exception.description) || p.exceptionDetails.text}`.slice(0, 200)));
    await router(cdp, decide);
    if (st.session) {   // the seeding page: same origin, writes the record, closes its handle; then the entry page navigates
      await cdp.s('Page.navigate', { url: `${srv.base}/${SITE}/fonts/OFL.txt` });
      for (let i = 0; i < 200 && (await cdp.ev('document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(25);
      await cdp.ev(SEED(sessionRecord(st.session)));
    }
    await cdp.s('Page.addScriptToEvaluateOnNewDocument', { source: MARK(MARKERS[st.marker]) });
    if (throwAfterMarker) await cdp.s('Page.addScriptToEvaluateOnNewDocument', { source: THROW_AFTER_MARKER });
    const navWall = Date.now();
    await cdp.s('Page.navigate', { url: `${srv.base}/${SITE}/${st.page}` });
    let marker = null;
    for (let i = 0; i < 600 && !(marker = await cdp.ev('window.__marker').catch(() => null)); i++) await sleep(25);
    if (!marker) {
      const wrong = st.marker === 'invite' ? await cdp.ev(MARKERS.wrongInvitePane).catch(() => []) : [];
      throw new Error(`${name}: the useful-paint marker (${st.marker}) never became true in 15 s${wrong.length ? ` — the page showed ${wrong.join(', ')} instead` : ''}${errs.length ? `; ${errs.slice(0, 2).join(' | ')}` : ''}`);
    }
    await sleep(1500);   // keep recording past the marker: late-path requests are listed (not hinted)
    const timeOrigin = await cdp.ev('performance.timeOrigin');
    const firsts = new Map();
    for (const r of reqs) { const o = new URL(r.url).origin; if (!firsts.has(o)) firsts.set(o, r); }
    const origins = [...firsts.entries()].map(([origin, r]) => ({ origin, firstUrl: r.url.replace(/([?&]key=)[^&]+/, '$1<apiKey>'), startMs: Math.round(r.wall - timeOrigin), beforeMarker: r.wall < marker, initiator: r.initiator }))
      .sort((a, b) => a.startMs - b.startMs);
    return { state: name, markerMs: Math.round(marker - timeOrigin), navToMarkerMs: Math.round(marker - navWall), origins, errors: errs };
  } finally { cdp.close(); srv.close(); }
}

const runs = {};
for (let rep = 1; rep <= REPEATS; rep++) for (const name of Object.keys(STATES)) {
  const r = await trace(name);
  (runs[name] ||= []).push(r);
  console.log(`[${name} #${rep}] marker ${r.markerMs} ms · ${r.origins.map((o) => `${o.beforeMarker ? '<' : '>'} ${o.origin} @${o.startMs}`).join(' · ')}${r.errors.length ? ` · ${r.errors.length} page error(s)` : ''}`);
}
const fails = [];
// any page exception in any state × repeat fails the trace: the boot graph the preconnects are derived from must have run cleanly
const pageErrorFails = (byState) => Object.entries(byState).flatMap(([n, rs]) => rs.flatMap((r, i) => r.errors.map((e) => `${n} #${i + 1}: page ${e}`)));
fails.push(...pageErrorFails(runs));
{ const ctrl = await trace('T1', { throwAfterMarker: true });
  const seen = pageErrorFails({ T1: [ctrl] });
  const ok = seen.some((e) => /ORIGINS_CONTROL/.test(e));
  console.log(`${ok ? '✓' : '✗'} page-exception control: an exception thrown after the marker FAILS the trace (${seen.length} recorded${ok ? '' : ' — the check is blind'})`);
  if (!ok) fails.push('page-exception control: an exception thrown after the marker was NOT recorded — the page-error check is blind'); }
if (unexpected.length) fails.push(`unexpected request(s), fulfilled empty: ${[...new Set(unexpected.map((u) => u.replace(/([?&]key=)[^&]+/, '$1<apiKey>')))].join(', ')}`);
const early = (name) => runs[name].map((r) => new Set(r.origins.filter((o) => o.beforeMarker).map((o) => o.origin)));
for (const name of Object.keys(STATES)) {
  const sets = early(name).map((s) => JSON.stringify([...s].sort()));
  if (new Set(sets).size !== 1) fails.push(`${name}: the repeats disagree on the early set (${[...new Set(sets)].join(' vs ')})`);
}
const admitted = [...new Set(Object.keys(STATES).filter((n) => STATES[n].admits).flatMap((n) => [...early(n)[0]]))].sort();
const lateOnly = [...new Set(Object.values(runs).flat().flatMap((r) => r.origins.map((o) => o.origin)))].filter((o) => !admitted.includes(o)).sort();
const EXCLUDED = [/^https:\/\/fonts\.(googleapis|gstatic)\.com$/, /^https:\/\/storage\.googleapis\.com$/, /firebaseio\.com$/];
for (const o of admitted) if (EXCLUDED.some((re) => re.test(o))) fails.push(`an excluded origin was admitted: ${o}`);
const record = { plan: 'PLAN-portal-fonts r1.1 §3.1', sdkVersion: SDK_VER, sdkFiles: PINNED.files.map(({ name, sha256, bytes }) => ({ name, sha256, bytes })), repeats: REPEATS,
  admissionRule: 'a request to the origin starts before the useful-paint marker in T2 or T4, in every repeat', admitted, lateOnly,
  states: Object.fromEntries(Object.entries(runs).map(([n, rs]) => [n, { page: STATES[n].page.split('?')[0], session: STATES[n].session, marker: STATES[n].marker, runs: rs.map(({ state, ...r }) => r) }])) };
console.log(`\nadmitted: ${admitted.join(', ') || '(none)'}\nlate-path, not hinted: ${lateOnly.join(', ') || '(none)'}`);
if (fails.length) { for (const f of fails) console.log(`  ✗ ${f}`); console.log(`\nportal-origins.cdp: ${fails.length} FAILED (nothing written)`); process.exit(1); }
if (process.argv.includes('--write')) {
  fs.mkdirSync(path.join(ROOT, SITE, 'perf'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, SITE, 'perf', 'portal.origins.json'), JSON.stringify(record, null, 2) + '\n');
  console.log(`wrote ${SITE}/perf/portal.origins.json`);
}
console.log('\nportal-origins.cdp: OK');
