// Portal 2b-2b — DOES app.js ACTUALLY LOAD? Run: node --test xpizza-portal/app-loads.test.mjs
//
// 🔴🔴 This test exists because app.js shipped with a load-time ReferenceError and every single one of
// the 102 other tests passed.
//
// The bug: a top-level `PUBBTN.addEventListener(...)` written EIGHT LINES ABOVE `const PUBBTN = …`.
// `const` sits in the temporal dead zone until its own declaration, so module evaluation threw
// "Cannot access 'PUBBTN' before initialization" and aborted — taking the publish listener, the
// captures, and every later top-level statement with it. The portal was dead on every page load.
//
// Nothing caught it because node never EXECUTES app.js: the other suites read it as TEXT through
// codeOf() and match patterns. A structural guard can prove a line is written; it cannot prove the
// module runs. Grepping for `const PUBBTN` passes on the broken order just as happily as on the fixed
// one — the ONLY thing that distinguishes them is evaluation.
//
// That is the third runtime-only defect in this slice (the detached button, the stringified-null
// footer, and this), and the first that was fatal to the whole page.
//
// app.js cannot be imported directly: it pulls in auth.js → firebase.js → a CDN URL node cannot fetch.
// So the source is rewritten to import a local stub for that ONE module and nothing else, written
// beside the originals so every other relative import resolves to the real file. What executes here is
// the real app.js logic.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));

// Only the ids app.js touches while evaluating, plus the ones its handlers reach for.
const IDS = ['switcher', 'switchmenu', 'discard', 'review', 'pubback', 'pubbtn', 'scrim', 'mbody',
  'revSub', 'revFoot', 'revTitle', 'drawer', 'rail', 'detail', 'rbar', 'rbtxt', 'shopname', 'shopsub',
  'whoami', 'avatar', 'logout', 'detailempty'];

function installDom() {
  const mk = (tag, id) => {
    const n = {
      tag, id, children: [], attrs: {}, listeners: {}, _class: '', dataset: {}, style: {},
      disabled: false, title: '', value: '', checked: false, textContent: '',
      get className() { return n._class; },
      set className(v) { n._class = v; },
      classList: {
        add: (c) => { n._class = `${n._class} ${c}`.trim(); },
        remove: (c) => { n._class = n._class.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle: (c, on) => { if (on) n.classList.add(c); else n.classList.remove(c); },
        contains: (c) => n._class.split(/\s+/).includes(c),
      },
      append: (...cs) => n.children.push(...cs),
      replaceChildren: (...cs) => { n.children = [...cs]; },
      setAttribute: (k, v) => { n.attrs[k] = v; },
      removeAttribute: (k) => { delete n.attrs[k]; },
      addEventListener: (ev, fn) => { (n.listeners[ev] = n.listeners[ev] || []).push(fn); },
      // REAL descendant queries and focus. The previous shim returned no descendants and modelled no
      // focus, so it could not see whether the drawer's inputs were disabled or blurred — which is
      // precisely what the inert-ownership fixes are about. A shim that cannot observe the thing under
      // test makes every assertion about it vacuous.
      querySelectorAll: (sel) => {
        const want = String(sel).split(',').map((x) => x.trim());
        const out = [];
        (function walkDown(node) {
          for (const c of node.children || []) {
            if (want.includes(c.tag) || want.some((w) => w.startsWith('.') && String(c._class).split(/\s+/).includes(w.slice(1)))) out.push(c);
            walkDown(c);
          }
        })(n);
        return out;
      },
      querySelector: (sel) => n.querySelectorAll(sel)[0] || null,
      contains: (el) => { let found = false; (function walkDown(node) { for (const c of node.children || []) { if (c === el) found = true; walkDown(c); } })(n); return found; },
      closest: () => null,
      focus: () => { globalThis.document.activeElement = n; },
      blur: () => { if (globalThis.document.activeElement === n) globalThis.document.activeElement = null; },
    };
    return n;
  };
  const byId = new Map(IDS.map((id) => [id, mk('div', id)]));
  globalThis.document = {
    _byId: byId,
    getElementById: (id) => byId.get(id) || null,
    createElement: (t) => mk(t, null),
    createElementNS: (_ns, t) => mk(t, null),
    querySelector: () => null,
    querySelectorAll: () => [],
    // A REAL listener registry, not a no-op. app.js's document-level wiring — portal:auth,
    // portal:signed-in, portal:restaurant — is exactly the surface these interleaving tests drive, and
    // a shim that swallowed listeners would make every one of them pass without running anything.
    _listeners: {},
    addEventListener: (ev, fn) => { (globalThis.document._listeners[ev] = globalThis.document._listeners[ev] || []).push(fn); },
    dispatchEvent: (evt) => { for (const fn of (globalThis.document._listeners[evt.type] || [])) fn(evt); return true; },
    documentElement: mk('html', null),
    activeElement: null,
  };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
  globalThis.CSS = { escape: (s) => String(s) };
  return byId;
}

// Rewrite ONLY the CDN-bound import; everything else resolves to the real module.
async function loadAppModule(sourceTransform = (s) => s) {
  const stub = join(DIR, '__auth-stub.test.mjs');
  const tmp = join(DIR, `__app-under-test.${Date.now()}.mjs`);
  writeFileSync(stub, 'export const token = async () => "TK-test";\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const src = sourceTransform(readFileSync(join(DIR, 'app.js'), 'utf8'))
    .replace(/from '\.\/auth\.js'/g, "from './__auth-stub.test.mjs'");
  writeFileSync(tmp, src);
  try {
    return await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`);
  } finally {
    try { unlinkSync(tmp); } catch (_) { /* best effort */ }
    try { unlinkSync(stub); } catch (_) { /* best effort */ }
  }
}

test('🔴 app.js EVALUATES — no load-time ReferenceError', async () => {
  installDom();
  let mod, threw = null;
  try { mod = await loadAppModule(); } catch (e) { threw = e; }
  assert.strictEqual(threw, null,
    `app.js threw during module evaluation, which kills the whole portal on every page load: ${threw && threw.message}`);
  assert.ok(mod, 'the module produced exports');
  assert.strictEqual(typeof mod.loadMenu, 'function', 'and its exports are reachable, so evaluation ran to the end');
});

test('🔴 the publish listener is REGISTERED, not merely written', async () => {
  const byId = installDom();
  await loadAppModule();
  const pubbtn = byId.get('pubbtn');
  assert.ok(pubbtn.listeners.click && pubbtn.listeners.click.length === 1,
    '#pubbtn has exactly one click listener — the whole publish path hangs off it');
  // and the other top-level wiring that a mid-module throw would have taken with it
  for (const id of ['review', 'discard', 'pubback', 'switcher']) {
    assert.ok(byId.get(id).listeners.click && byId.get(id).listeners.click.length >= 1,
      `#${id} is wired — a module that aborted partway would leave this empty`);
  }
});

test('the test itself FAILS on the ordering that shipped', async () => {
  // The point of an executable check. Reintroduce the exact defect — move the captures BELOW their
  // top-level use — and require this harness to notice. A guard that greps for `const PUBBTN` passes
  // on both orderings; only evaluation tells them apart.
  installDom();
  const broken = (src) => {
    const decl = "const PUBBTN = $('pubbtn');\nconst PUBBACK = $('pubback');\n";
    assert.ok(src.includes(decl), 'the captures are where this test expects them');
    return src.replace(decl, '') + `\n${decl}`;   // declared after every use, as it shipped
  };
  let threw = null;
  try { await loadAppModule(broken); } catch (e) { threw = e; }
  assert.ok(threw, 'the broken ordering must throw');
  assert.ok(/before initialization|is not defined/.test(threw.message),
    `...with a temporal-dead-zone error, got: ${threw.message}`);
});

test('every capture is declared before every top-level use', async () => {
  // The general form, checked on the real file rather than on a rewritten copy: for each captured
  // const, no TOP-LEVEL statement above it may reference it. Indented lines are function bodies,
  // which only run after evaluation completes.
  // Comments STRIPPED. The comment explaining this very hazard names PUBBTN, and an unstripped scan
  // matched that prose and reported the fixed file as broken. A guard that reads its own
  // documentation as evidence proves nothing — third time in this slice.
  const lines = readFileSync(join(DIR, 'app.js'), 'utf8').split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/\s\/\/.*$/, ''));
  const decls = new Map();
  lines.forEach((l, i) => {
    const m = l.match(/^const ([A-Z][A-Z0-9_]*) =/);
    if (m) decls.set(m[1], i);
  });
  assert.ok(decls.size >= 2, `non-vacuity: the scan must find the captures (${[...decls.keys()]})`);
  for (const [name, declLine] of decls) {
    lines.forEach((l, i) => {
      if (i >= declLine) return;
      if (!l || /^\s/.test(l)) return;                     // indented → inside a function body
      assert.ok(!new RegExp(`(?<![\\w$])${name}(?![\\w$])`).test(l),
        `${name} is used at top level on line ${i + 1} but declared on line ${declLine + 1} — a temporal-dead-zone throw at module load`);
    });
  }
});

// ── ASYNC INTERLEAVING ───────────────────────────────────────────────────────────────────────────
// The structural guards can see that a generation check is WRITTEN; they cannot see whether a stale
// continuation is actually dropped. These launch a real operation, change the world mid-flight, then
// let the stale one settle — the async sibling of the load-execution test above.
//
// The app module is driven for real; only auth and fetch are stubbed.
function deferred() { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; }

function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const fn = String(url).split('/').pop().split('?')[0];
    calls.push({ fn, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return handler(fn, calls.length);
  };
  return calls;
}
const SOURCE = () => ({
  restaurant_id: 'x_pizza', schema_version: 1,
  items: [{ key: 'Pizza', price: 299, display: { id: 1, cat: 'c', name: 'Pizza', price: 299 } }],
  extras: [], structure: { schema_version: 2, item_order: ['Pizza'], categories: [{ id: 'c' }] },
});
const okJson = (body) => ({ ok: true, status: 200, json: async () => body });

test('🔴 a load that settles AFTER a tenant switch does not paint the tenant you left', async () => {
  const byId = installDom();
  const slow = deferred();
  installFetch((fn, n) => (fn === 'getEditableCatalog' && n === 1
    ? slow.promise                                  // x_pizza: never settles until we say so
    : okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })));
  const app = await loadAppModule();

  const first = app.loadMenu('x_pizza');            // in flight
  const second = app.loadMenu('la_musa');           // the merchant switches; this one wins
  await second;
  const fiscalAfterSwitch = app.state.usesPlatformFactura;

  slow.resolve(okJson({ source: SOURCE(), sourceUpdateTime: 'T1', activeVersionId: 'v1', usesPlatformFactura: true }));
  await first;
  assert.strictEqual(app.state.usesPlatformFactura, fiscalAfterSwitch,
    '🔴 the stale response did NOT overwrite the current tenant’s fiscal capability');
  assert.strictEqual(app.state.usesPlatformFactura, false, 'which is la_musa’s, the tenant actually selected');
});

test('🔴 a load that FAILS after a tenant switch does not erase the current tenant', async () => {
  // The failure path is the one that shipped uncovered: it cleared groups and the rail BEFORE
  // checking the generation, so a slow error from the tenant you left blanked the one you are on.
  const byId = installDom();
  const slow = deferred();
  installFetch((fn, n) => (n === 1 ? slow.promise
    : okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })));
  const app = await loadAppModule();

  const first = app.loadMenu('x_pizza');
  await app.loadMenu('la_musa');
  const groupsAfterSwitch = app.state.groups.length;
  assert.ok(groupsAfterSwitch > 0, 'premise: la_musa rendered something');

  slow.reject(Object.assign(new Error('store_unavailable'), { code: 'store_unavailable', status: 503, kind: 'Unavailable' }));
  await first;
  assert.strictEqual(app.state.groups.length, groupsAfterSwitch,
    '🔴 the stale FAILURE left the current tenant’s menu alone');
});

test('🔴 an auth change mid-flight drops the continuation and the acknowledgement', async () => {
  const byId = installDom();
  const slow = deferred();
  installFetch((fn, n) => (fn === 'getEditableCatalog' && n === 1 ? slow.promise : okJson({})));
  const app = await loadAppModule();

  const load = app.loadMenu('x_pizza');
  // owner A signs out, owner B signs in, while that load is still on the wire
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'A' } }));
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  slow.resolve(okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: true }));
  await load;

  assert.strictEqual(app.state.review, null, 'no review survived the auth change');
  assert.strictEqual(app.state.usesPlatformFactura, false,
    '🔴 the stale load did not repopulate a fiscal capability for the new person');
  assert.strictEqual(app.state.uid, 'B', 'and the session is the new one');
});

// ── DRAWER OWNERSHIP, EXECUTABLY ─────────────────────────────────────────────────────────────────
test('🔴 the drawer is inert for the whole SAVE, and a skipped publish does not unlock it', async () => {
  // Two defects the structural guards could not see, because they can only check that a call is
  // written — not who owns the lock when several attempts overlap.
  const byId = installDom();
  const slowSave = deferred();
  let n = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: true });
    if (fn === 'editCatalog') { n += 1; return n === 1 ? slowSave.promise : okJson({ token: 'ET', updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [], largeChangeSet: [] } }); }
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  const drawer = byId.get('drawer');
  app.openDrawer('Pizza');
  assert.ok(drawer.querySelectorAll('input').length > 0, 'premise: the drawer really has an editable field');
  assert.ok(!drawer.querySelectorAll('input')[0].disabled, 'and it is editable before anything is in flight');

  // start the save; it stays on the wire
  const saving = byId.get('review').listeners.click[0]();
  await Promise.resolve();
  assert.ok('inert' in drawer.attrs, '🔴 the drawer is inert while the save is on the wire');
  assert.ok(drawer.querySelectorAll('input').every((i) => i.disabled),
    '...and its inputs are disabled, not merely translated off-screen where a keyboard still reaches them');

  slowSave.resolve(okJson({ token: 'ET', updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [], largeChangeSet: [] } }));
  await saving;
  // 🔴 STILL INERT. The review owns the draft for the whole ATTESTATION, not just the save: a merchant
  // must not be able to edit the underlying document while signing for a snapshot of it.
  assert.ok('inert' in drawer.attrs, 'the drawer stays inert through the attestation');
  assert.ok(drawer.querySelectorAll('input').every((i) => i.disabled), '...with its fields still disabled');

  // released only by an EXPLICIT return to editing
  byId.get('pubback').listeners.click[0]();
  assert.ok(!('inert' in drawer.attrs), 'and released when the merchant goes back to editing');
});

test('🔴 a re-entrant review is REFUSED, not admitted and then collided with', async () => {
  // Admission control. Letting review B proceed on a null ticket was the defect: it bumped the
  // generation and sent its own editCatalog while save A still held the lock, and A's release then
  // un-inerted the drawer with B still pending. Nothing to reconcile if B never starts.
  const byId = installDom();
  const slowSave = deferred();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') { saves += 1; return saves === 1 ? slowSave.promise : okJson({ token: 'ET2', updateTime: 'T3', diff: { added: [], removed: [], renamed: [], changed: [], largeChangeSet: [] } }); }
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  const first = byId.get('review').listeners.click[0]();
  await Promise.resolve();
  assert.strictEqual(saves, 1, 'premise: the first save is on the wire');

  await byId.get('review').listeners.click[0]();       // re-entry while A holds the lock
  assert.strictEqual(saves, 1, '🔴 the re-entrant review sent NOTHING — it was refused at admission');

  slowSave.resolve(okJson({ token: 'ET', updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [], largeChangeSet: [] } }));
  await first;
  assert.ok('inert' in byId.get('drawer').attrs, 'and the first review still owns the draft');
});

test('🔴 a stale publish’s cleanup does not paint over the new world', async () => {
  const byId = installDom();
  const slowPub = deferred();
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') return okJson({ token: 'ET', updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [{ key: 'Pizza', surface: 'item', field: 'price', old: 299, new: 310 }], largeChangeSet: [] } });
    return slowPub.promise;
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();          // opens the review; non-fiscal so no ack needed
  const publishing = byId.get('pubbtn').listeners.click[0]();
  await Promise.resolve();
  const drawer = byId.get('drawer');
  assert.ok('inert' in drawer.attrs, 'the publish owns the draft while it is on the wire');

  // the world moves on mid-flight
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  slowPub.resolve(okJson({ versionId: 'v9' }));
  await publishing;

  assert.strictEqual(app.state.review, null, 'the stale publish did not repopulate a review');
  assert.strictEqual(byId.get('pubbtn').dataset.busy, undefined, 'and left no busy indicator behind');
});

test('🔴 loadRestaurants that settles after an auth change does not replace the new session', async () => {
  // The last settle-path outside the spine. A's restaurant lookup returning after auth flipped to B
  // would replace B's selection AND dispatch a loadMenu for A's restaurant — invalidating B's own
  // load in the process.
  const byId = installDom();
  const slow = deferred();
  installFetch((fn) => (fn === 'getMyRestaurants' ? slow.promise : okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })));
  const app = await loadAppModule();

  const looking = app.loadRestaurants();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  const ridAfterAuthChange = app.state.currentRid;

  slow.resolve(okJson({ restaurants: [{ rid: 'x_pizza', name: 'X. Pizza' }] }));
  await looking;
  assert.strictEqual(app.state.currentRid, ridAfterAuthChange,
    '🔴 the stale lookup did not select a restaurant for the new session');
  assert.strictEqual((app.state.restaurants || []).length, 0, 'nor repopulate the list it belongs to');
});

test('🔴 a publish SKIPPED as in-flight does not unlock the drawer under the live one', async () => {
  // Ownership, not a boolean. The second attempt is refused before the network — but it still runs its
  // own finally, and a shared flag would let it release the editing lock while the FIRST request is
  // still outstanding, re-opening the draft mid-publish.
  const byId = installDom();
  const slowPub = deferred();
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') return okJson({ token: 'ET', updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [{ key: 'Pizza', surface: 'item', field: 'price', old: 299, new: 310 }], largeChangeSet: [] } });
    return slowPub.promise;
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();

  const drawer = byId.get('drawer');
  const first = byId.get('pubbtn').listeners.click[0]();      // on the wire
  await Promise.resolve();
  assert.ok('inert' in drawer.attrs, 'premise: the first publish owns the draft');

  const second = byId.get('pubbtn').listeners.click[0]();     // refused as in_flight
  await second;
  assert.ok('inert' in drawer.attrs,
    '🔴 STILL inert — the skipped attempt never held the lock, so it must not release it');

  slowPub.resolve(okJson({ versionId: 'v1' }));
  await first;
  assert.ok(!('inert' in drawer.attrs), 'and the holder releases it when IT settles');
});

test('🔴 cleanup happens AT invalidation, not merely after the stale op completes', async () => {
  // The distinction the gate drew: asserting only "after the stale op settles, the UI is clean" also
  // passes on an UNCONDITIONAL cleanup — the very thing being removed. So assert the moment: the world
  // ends, and the UI is already right BEFORE anything settles.
  const byId = installDom();
  const slowPub = deferred();
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') return okJson({ token: 'ET', updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [{ key: 'Pizza', surface: 'item', field: 'price', old: 299, new: 310 }], largeChangeSet: [] } });
    return slowPub.promise;
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();
  const publishing = byId.get('pubbtn').listeners.click[0]();
  await Promise.resolve();
  assert.strictEqual(byId.get('pubbtn').dataset.busy, '1', 'premise: the spinner is up while the request is on the wire');

  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  // 🔴 IMMEDIATELY — before the stale publish settles
  assert.strictEqual(byId.get('pubbtn').dataset.busy, undefined, 'the spinner is cleared AT invalidation');
  assert.ok(!('inert' in byId.get('drawer').attrs), '...and the draft is released at the same moment');

  slowPub.resolve(okJson({ versionId: 'v9' }));
  await publishing;
  assert.strictEqual(byId.get('pubbtn').dataset.busy, undefined, 'and the stale settle did not put it back');
});

test('🔴 a stale publish settling cannot disturb UI the NEW world already owns', async () => {
  // Establish observable B-owned state FIRST, then let A settle into it.
  //
  // B cannot own a spinner while A is on the wire — the overlap lock refuses a second request, by
  // design — so what B owns is the DRAFT: its own review holds the edit lock. That is the bit A's
  // settle must not touch.
  const byId = installDom();
  const slowA = deferred();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') return okJson({ token: `ET${++saves}`, updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [{ key: 'Pizza', surface: 'item', field: 'price', old: 299, new: 310 }], largeChangeSet: [] } });
    return slowA.promise;
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();
  const a = byId.get('pubbtn').listeners.click[0]();          // publish A, on the wire
  await Promise.resolve();

  // the world ends and a NEW review takes ownership
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();
  const bToken = app.state.review && app.state.review.editToken;
  const bInert = 'inert' in byId.get('drawer').attrs;
  assert.ok(bToken, 'premise: B owns a review');
  assert.ok(bInert, 'premise: B owns the draft');

  slowA.resolve(okJson({ versionId: 'vA' }));                 // A settles INTO B's world
  await a;
  assert.strictEqual(app.state.review && app.state.review.editToken, bToken,
    '🔴 A did not replace the review B owns');
  assert.strictEqual('inert' in byId.get('drawer').attrs, bInert, '...nor release the draft B holds');
  assert.strictEqual(byId.get('pubbtn').dataset.busy, undefined, '...nor leave a spinner B is not waiting on');
});

test('the drawer’s fields are blurred when the draft is taken', async () => {
  const byId = installDom();
  installFetch(() => okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false }));
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  app.openDrawer('Pizza');
  const input = byId.get('drawer').querySelectorAll('input')[0];
  input.focus();
  assert.strictEqual(document.activeElement, input, 'premise: the field really holds focus');

  // TAKING the draft — opening a review — is what must move focus out. A panel that is inert but still
  // holds focus keeps receiving keystrokes, which is the whole failure `inert` is meant to prevent.
  await byId.get('review').listeners.click[0]();
  assert.ok('inert' in byId.get('drawer').attrs, 'premise: the review took the draft');
  assert.notStrictEqual(document.activeElement, input, 'focus left the field the merchant no longer owns');
  assert.ok(input.disabled, '...and the field itself is disabled');
});
