'use strict';
// Portal 1B Task 2 — getPublicMenu OVER REAL HTTP, against a REAL Firestore.
// Run: PATH="/opt/homebrew/opt/openjdk/bin:$PATH" npm run test:public-menu
//
// 🔴 BRAND ISOLATION IS A CACHE-KEY PROPERTY, SO IT IS TESTED AS ONE. A mocked `Vary` assertion
// proves nothing about a CDN: Vary keys on REQUEST HEADERS, so a rid in the query string is invisible
// to it and one cache entry would serve both brands. What actually isolates them is the rid being in
// the URL PATH — which every cache in the chain already keys on — plus a VALIDATOR that is
// brand-specific, so a client holding brand A's etag can never be told "not modified" by brand B.
//
// Both of those are properties of real requests and real responses, so the handler is mounted on a
// real http server and driven with real fetch calls: real status codes, real headers, real
// conditional-request semantics. The one thing this does NOT do is run a CDN — what it proves is that
// the response carries everything a correct CDN needs and nothing that would mislead one. That
// boundary is stated rather than glossed.
const assert = require('assert');
const http = require('http');
const admin = require('firebase-admin');
const { buildPublishCandidate } = require('../tools/publish-version');

// 🔴 index.js OWNS THE APP. It calls initializeApp() at module load with the deployed databaseURL,
// so this test must let it rather than racing it — initializing first is "the default Firebase app
// already exists" on require. Requiring the real module first is also the more faithful wiring: what
// is exercised below is the endpoint as the deploy constructs it, not a re-creation of it.
//
// The emulators are reached through FIRESTORE_EMULATOR_HOST / FIREBASE_DATABASE_EMULATOR_HOST, which
// emulators:exec sets; the namespace comes from the URL index.js already declares.
const { getPublicMenu } = require('../index');
const db = admin.firestore();

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

// restaurant-config.isRoutingValid demands the whole routing record — anything less is "malformed"
// and the gate fails closed.
const identityFor = (rid, active) => ({
  name: rid, phone: '+50400000000', active,
  hub_lat: 14.1, hub_lng: -87.2, delivery_radius_km: 8, version: 1,
});

(async () => {
  const { publishVersion } = require('../catalog/catalog-publish');
  for (const rid of ['x_pizza', 'la_musa']) {
    const { input } = buildPublishCandidate(rid, { activeVersionId: null }, { source_sha: '1b-t2' });
    await publishVersion(db, rid, input, { expected: { activeVersionId: null } });
    // The identity the endpoint's isActive gate reads. The full ROUTING shape, because
    // restaurant-config validates it and treats a partial one as malformed — which fails closed to
    // "identity unavailable", i.e. a refusal for the right reason by accident. A fixture that trips a
    // different guard than the one under test is a green light nobody earned.
    await admin.database().ref(`restaurants/${rid}/identity`).set(identityFor(rid, true));
  }

  // The REAL exported handler, on a real socket.
  // Through EXPRESS, because that is what the deploy does: onRequest hands the function an Express
  // req/res, and the handler uses res.set/.status/.json. A raw ServerResponse has none of those, so a
  // test driving it directly would be testing a different object than production runs.
  const express = require('express');
  const app = express();
  app.all('*', (req, res) => getPublicMenu(req, res));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, headers = {}) => fetch(`${base}${path}`, { headers });

  // ── 1. A MENU, WITH ITS VALIDATOR ──────────────────────────────────────────────────────────────
  const seen = {};
  for (const rid of ['x_pizza', 'la_musa']) {
    const r = await get(`/menu/${rid}`);
    assert.strictEqual(r.status, 200, `${rid}: expected 200, got ${r.status}`);
    const body = await r.json();
    assert.strictEqual(body.rid, rid, `🔴 ${rid}: the body must name the restaurant that was ASKED for`);
    assert.ok(body.menu.dishes.length > 0 && body.menu.extras.length > 0, `${rid}: a whole menu`);
    assert.strictEqual(body.menu.seq, undefined, 'seq is not in the representation');
    assert.strictEqual(body.seq, undefined, '...at any level — it is not covered by the etag');
    assert.match(r.headers.get('etag') || '', /^"[0-9a-f]{64}"$/, `${rid}: a strong validator`);
    assert.strictEqual(r.headers.get('cache-control'), 'public, max-age=30, s-maxage=120');
    assert.match(r.headers.get('vary') || '', /Origin/, 'a cache must be told the response varies by origin');
    assert.match(r.headers.get('access-control-expose-headers') || '', /ETag/, 'the browser must be able to READ the validator it has to send back');
    seen[rid] = { etag: r.headers.get('etag'), body };
    ok(`${rid}: 200 with a whole menu (${body.menu.dishes.length} dishes, ${body.menu.extras.length} options), strong ETag, cacheable`);
  }

  // ── 2. BRAND ISOLATION, AS A CACHE WOULD EXPERIENCE IT ─────────────────────────────────────────
  {
    assert.notStrictEqual(seen.x_pizza.etag, seen.la_musa.etag, 'the two brands must not share a validator');
    assert.notDeepStrictEqual(seen.x_pizza.body.menu.dishes, seen.la_musa.body.menu.dishes, 'premise: the menus really differ');

    // 🔴 THE CROSS-BRAND CONDITIONAL REQUEST. This is the shape a shared cache key produces: a client
    // holding one brand's validator asks the other brand's URL. A 304 here means "you already have
    // this" — and the client would render X. Pizza's menu on La Musa's page. It must be a fresh 200.
    const cross = await get('/menu/la_musa', { 'If-None-Match': seen.x_pizza.etag });
    assert.strictEqual(cross.status, 200, '🔴 a cross-brand If-None-Match produced a 304 — one brand would render the other');
    assert.strictEqual((await cross.json()).rid, 'la_musa');

    // ...and the same URL with its OWN validator does revalidate, so the 200 above is not just "304
    // never happens".
    const same = await get('/menu/la_musa', { 'If-None-Match': seen.la_musa.etag });
    assert.strictEqual(same.status, 304, 'a matching validator must 304');
    assert.strictEqual(same.headers.get('etag'), seen.la_musa.etag, 'a 304 carries the validator');
    assert.strictEqual(same.headers.get('cache-control'), 'public, max-age=30, s-maxage=120',
      '🔴 a 304 must carry the same freshness as the 200 it stands in for, or the client revalidates forever');
    assert.strictEqual((await same.text()).length, 0, 'a 304 carries no body');

    // THE QUERY STRING IS NOT THE rid. A cache that ignores or reorders query parameters must not be
    // able to change which brand is served — which is exactly what Vary:rid or a ?rid= would allow.
    const spoof = await get('/menu/x_pizza?rid=la_musa&x=1');
    assert.strictEqual((await spoof.json()).rid, 'x_pizza', '🔴 the query string influenced which brand was served');
    assert.strictEqual(spoof.headers.get('etag'), seen.x_pizza.etag, '...and the validator is still x_pizza\'s');
    // and no header claims to key on the rid — that would be the unsafe design this replaced
    assert.ok(!/rid/i.test(spoof.headers.get('vary') || ''), '🔴 Vary must not claim to key on the rid; it cannot');
    // CONDITIONAL-REQUEST SPELLINGS. A client, a CDN and a proxy do not all send If-None-Match the
    // same way: a list of validators, a weak marker, or `*`. Reading only the exact-match case leaves
    // the rest to chance, and the two directions fail differently — too lenient serves a 304 for a
    // menu the client does not have (a blank page), too strict just costs a re-download.
    const E = seen.x_pizza.etag;
    for (const [label, header, want] of [
      ['the exact validator', E, 304],
      ['a LIST containing it', `"0000", ${E}, "ffff"`, 304],
      ['the WEAK form of it', `W/${E}`, 304],
      ['the wildcard', '*', 304],
      ['a list of others', '"0000", "ffff"', 200],
      ['one character different', `${E.slice(0, -2)}0"`, 200],
      ['an empty header', '', 200],
    ]) {
      const r = await get('/menu/x_pizza', header === '' ? {} : { 'If-None-Match': header });
      assert.strictEqual(r.status, want, `If-None-Match ${label}: expected ${want}, got ${r.status}`);
      if (want === 304) assert.strictEqual((await r.text()).length, 0, `${label}: a 304 carries no body`);
    }
    ok(`conditional requests: 7 If-None-Match spellings resolve correctly (list, weak, wildcard, near-miss)`);
  }
  {
    ok('brand isolation: distinct validators, a cross-brand If-None-Match is NOT a 304, a matching one is, and the query string cannot change the brand');
  }

  // ── 3. ERRORS ARE TYPED AND NEVER CACHED ───────────────────────────────────────────────────────
  {
    for (const [label, path] of [
      ['an unknown restaurant', '/menu/not_a_restaurant'],
      ['a malformed rid', '/menu/X%20Pizza!'],
      ['no rid at all', '/menu/'],
      ['a path that is not a menu', '/something/else'],
      ['a path with junk after the rid', '/menu/x_pizza/extra'],
    ]) {
      const r = await get(path);
      assert.strictEqual(r.status, 400, `${label}: expected 400, got ${r.status}`);
      assert.strictEqual(r.headers.get('cache-control'), 'no-store', `🔴 ${label}: a cached 400 outlives the fix`);
      assert.strictEqual(r.headers.get('etag'), null, `${label}: an error has no validator`);
      assert.strictEqual((await r.json()).error, 'public_menu_bad_rid', `${label}: typed`);
    }
    // an INACTIVE restaurant is a bad request too — known, but not serving
    await admin.database().ref('restaurants/la_musa/identity').set(identityFor('la_musa', false));
    const off = await get('/menu/la_musa');
    assert.strictEqual(off.status, 400, 'a restaurant that is not serving must not have its menu handed out');
    assert.strictEqual(off.headers.get('cache-control'), 'no-store');
    await admin.database().ref('restaurants/la_musa/identity').set(identityFor('la_musa', true));

    // a POST is refused without touching the catalog
    const post = await fetch(`${base}/menu/x_pizza`, { method: 'POST' });
    assert.strictEqual(post.status, 405);
    assert.strictEqual(post.headers.get('cache-control'), 'no-store');
    assert.strictEqual(post.headers.get('etag'), null, '🔴 a 405 must carry no validator either');
    ok('errors: 6 bad-request shapes + an inactive restaurant + a POST, each typed, each no-store, none carrying a validator');
  }

  // ── 4. AN UNSERVABLE CATALOG IS A RETRYABLE 503, NOT A 4xx ─────────────────────────────────────
  {
    // 🔴 THE CLASSIFICATION IS THE POINT. A transient catalog outage cached as a 4xx keeps a
    // restaurant dark after it recovers, and tells the client not to retry. Broken by stripping an
    // option's display record from the live version — the 1A reader refuses it whole.
    const vid = (await db.collection('restaurants').doc('x_pizza').collection('meta').doc('active_version').get()).data().version;
    const d = (await db.collection('restaurants').doc('x_pizza').collection('versions').doc(vid).collection('extras').get()).docs[0];
    const original = d.data();
    await d.ref.set({ key: original.key, price: original.price });

    const r = await get('/menu/x_pizza');
    assert.strictEqual(r.status, 503, `🔴 an unservable catalog must be a retryable 503, got ${r.status}`);
    assert.strictEqual(r.headers.get('cache-control'), 'no-store', '🔴 a cached 503 keeps the restaurant dark after it recovers');
    const body = await r.json();
    assert.strictEqual(body.error, 'public_menu_unavailable');
    assert.strictEqual(body.retryable, true, 'the client is told it is worth trying again');
    assert.strictEqual(body.menu, undefined, '🔴 a failure must carry no partial menu');
    // 🔴 AND NO VALIDATOR. A 503 that slipped back to res.json() would carry a payload-hash ETag —
    // a cache-validity claim about an OUTAGE. no-store makes it inert, but the two protections are
    // independent and only one of them was asserted for this status.
    assert.strictEqual(r.headers.get('etag'), null, '🔴 a 503 must carry no validator');

    await d.ref.set(original);                                   // and it recovers
    const back = await get('/menu/x_pizza');
    assert.strictEqual(back.status, 200, 'the same URL serves again once the catalog is whole');
    assert.strictEqual(back.headers.get('etag'), seen.x_pizza.etag, 'and the validator is unchanged — the menu never actually differed');
    ok('an unservable catalog is 503 + no-store + retryable with no partial menu, and the same URL recovers to the same validator');
  }

  // ── 5. CORS IS SCOPED ──────────────────────────────────────────────────────────────────────────
  {
    const allowed = await get('/menu/x_pizza', { Origin: 'https://orders.xpizza.hn' });
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'https://orders.xpizza.hn', 'a form origin may read the menu');
    const stranger = await get('/menu/x_pizza', { Origin: 'https://evil.example' });
    assert.notStrictEqual(stranger.headers.get('access-control-allow-origin'), 'https://evil.example', '🔴 an arbitrary origin was allowed to read');
    // the portal and account lists are NOT widened by this endpoint existing
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8');
    assert.ok(/const PUBLIC_MENU_ORIGINS = \[/.test(src), 'the endpoint has its own origin list');
    assert.ok(/cors: PUBLIC_MENU_ORIGINS/.test(src), '...and uses it');
    assert.ok(!/cors: ACCOUNT_ORIGINS[\s\S]{0,200}getPublicMenu/.test(src), 'it does not borrow the account list');
    ok('CORS: a form origin may read, a stranger may not, and neither ACCOUNT_ORIGINS nor PORTAL_ORIGINS was widened');
  }

  server.close();
  console.log(`public-menu(emulator): OK (${n})`);
  process.exit(0);
})().catch((e) => { console.error('PUBLIC MENU FAILED:', (e && e.stack) || e); process.exit(1); });
