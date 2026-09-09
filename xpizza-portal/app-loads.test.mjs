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
import { pendingChanges, createDraft as makeDraft } from './editor.js';

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

// What the merchant's own editor believes is outstanding. Zero after a reload of a SAVED draft — which
// is the whole reason #7-B exists — so tests that turn on that state assert it as a premise.
const pendingCountOf = (app) => pendingChanges(app.state.draft).length;

// Two items, so a listener retained from one drawer can be fired while another is open — the
// mis-target the drawerKey read at dispatch time made possible.
const TWO_ITEMS = () => {
  const s = WITH_EXTRA();
  s.items.push({ key: 'Other', price: 150, display: { id: 2, cat: 'c', name: 'Other', price: 150 } });
  s.structure.item_order = ['Pizza', 'Other'];
  return s;
};

// SOURCE has no extras, so its drawer renders no option rows — and an option row is the only field
// whose handler captures its key. Tests about retained listeners need this one.
const WITH_EXTRA = () => {
  const s = SOURCE();
  s.extras = [{ key: 'Queso', price: 20, display: { id: 9, cat: 'Salsas', name: 'Queso', price: 20 } }];
  s.structure.extras_by_category = { c: ['Salsas'] };
  return s;
};

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
    if (fn === 'getEditableCatalog') return okJson({ source: WITH_EXTRA(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: true });
    if (fn === 'editCatalog') { n += 1; return n === 1 ? slowSave.promise : okJson({ token: 'ET', updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [], largeChangeSet: [] } }); }
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  const drawer = byId.get('drawer');
  app.openDrawer('Pizza');
  assert.ok(drawer.querySelectorAll('input').length > 0, 'premise: the drawer really has an editable field');
  assert.ok(!drawer.querySelectorAll('input')[0].disabled, 'and it is editable before anything is in flight');

  // 🔴 RETAIN AN OPTION'S INPUT, NOT THE ITEM'S. The item field's handler reads state.drawerKey AT FIRE
  // TIME, and closing the drawer nulls it — so firing it late hit setItemPrice(draft, null) and was a
  // no-op for the unknown-key reason, whether or not the boundary existed. It proved nothing: deleting
  // canEdit from setPrice left this test green.
  //
  // The option field CAPTURED o.key when it was built, so it stays a live weapon pointed at a real row
  // for as long as anything holds it. That is the listener the boundary has to stop.
  drawer.querySelectorAll('.mgmain')[0].listeners.click[0]();      // open the group so its rows render
  const optInput = drawer.querySelectorAll('input')
    .find((i) => (i.attrs['aria-label'] || '').startsWith('Precio de '));
  assert.ok(optInput, 'premise: an option price field, whose handler closed over a real key');
  const retainedInput = drawer.querySelectorAll('input')[0];
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
  // NOT `.every(i => i.disabled)` on the emptied subtree — that is vacuously true once closeDrawer has
  // removed the children, and it was. Assert the property that actually matters: a reference retained
  // from BEFORE the review cannot mutate the draft, whatever the DOM now contains.
  const priceBefore = app.state.draft && app.state.draft.state.items[0].price;
  retainedInput.value = '999';
  retainedInput.listeners.input[0]();
  assert.strictEqual(app.state.draft.state.items[0].price, priceBefore,
    'a RETAINED listener cannot move a price while the review owns the draft');

  // THE DISCRIMINATING ONE: a captured key, so nothing but the boundary can refuse it.
  const extraBefore = app.state.draft.state.extras[0].price;
  optInput.value = '777';
  optInput.listeners.input[0]();
  assert.strictEqual(app.state.draft.state.extras[0].price, extraBefore,
    '🔴 a retained OPTION listener, holding a valid key, cannot move a price mid-attestation');

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

  // 🔴 A REFUSED DUPLICATE FIRST. This press sends nothing, and the assertions below only mean
  // anything if it also SURRENDERS nothing: it rides the same reusable ticket as the live request, so
  // an implementation keyed on the ticket lets this press clear the live one's wire ownership and the
  // ender that follows then finds the lock free. Without this line the test passes on that bug.
  await byId.get('pubbtn').listeners.click[0]();
  assert.strictEqual(byId.get('pubbtn').dataset.busy, '1', 'the refused press disturbed nothing it does not own');

  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  // 🔴 IMMEDIATELY — before the stale publish settles
  assert.strictEqual(byId.get('pubbtn').dataset.busy, undefined, 'the spinner is cleared AT invalidation');
  // 🔴 THE DRAFT IS NOT RELEASED HERE, and this line used to assert the opposite. The UI world has
  // ended, but the PUBLISH HAS NOT — it is on the wire, and ending a world does not un-send it. The
  // spinner is UI and goes; the write lock is admission and stays with the request that holds it.
  // Releasing it here is exactly what let a second write be admitted alongside an outstanding one.
  assert.ok('inert' in byId.get('drawer').attrs, 'but the draft stays owned — its publish is still outstanding');

  slowPub.resolve(okJson({ versionId: 'v9' }));
  await publishing;
  assert.strictEqual(byId.get('pubbtn').dataset.busy, undefined, 'and the stale settle did not put it back');
  assert.ok(!('inert' in byId.get('drawer').attrs),
    '🔴 the ticket comes back when its REQUEST settles — the one moment it is free to');
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
  // ...and a duplicate press that is refused. It must leave A's ownership of the wire untouched, or
  // everything asserted after the ender is asserted against a lock that was already handed away.
  await byId.get('pubbtn').listeners.click[0]();

  // The world ends and B loads. B then tries to review — and CANNOT, which is the point: the scenario
  // this test was originally written to survive is now unreachable by construction. A's publish is
  // still outstanding, so no second write is admitted, whoever is asking.
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  await app.loadMenu('x_pizza');
  const savesBefore = saves;
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(saves, savesBefore,
    '🔴 B is refused while A’s publish is on the wire — admission outlives the world that opened it');
  assert.strictEqual(app.state.review, null, 'so B holds no review to be disturbed');

  slowA.resolve(okJson({ versionId: 'vA' }));                 // A settles into a world that has ended
  await a;
  assert.strictEqual(app.state.review, null, '🔴 A’s settle created nothing in B’s world');
  assert.strictEqual(byId.get('pubbtn').dataset.busy, undefined, '...nor left a spinner B is not waiting on');

  // ...and now that A has settled, B gets its turn. The lock was held, not lost.
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(saves, savesBefore + 1, '🔴 B can review once the outstanding write has settled');
  assert.ok('inert' in byId.get('drawer').attrs, 'and B owns the draft, cleanly');
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

test('🔴 recovery panels can re-enter — a FAILED operation does not keep the draft', async () => {
  // Admission control over-corrected: a failed save kept the lock, so Reintentar / Revisar de nuevo /
  // Volver a la revisión all hit a held lock and returned immediately. The Task-7 recovery panels were
  // dead. The distinction is SETTLED vs IN-FLIGHT.
  const byId = installDom();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') {
      saves += 1;
      if (saves === 1) return { ok: false, status: 503, json: async () => ({ error: 'store_unavailable' }) };
      return okJson({ token: 'ET2', updateTime: 'T3', diff: { added: [], removed: [], renamed: [], changed: [], largeChangeSet: [] } });
    }
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  await byId.get('review').listeners.click[0]();
  assert.strictEqual(saves, 1, 'premise: the save was attempted and failed');
  assert.ok(!('inert' in byId.get('drawer').attrs), '🔴 the failed save handed the draft back');

  // the panel's action re-enters the review
  const btn = byId.get('mbody').querySelectorAll('button')[0];
  assert.ok(btn, 'the outcome panel offers an action');
  await btn.listeners.click[0]();
  assert.strictEqual(saves, 2, '🔴 the recovery transition really re-entered — a held lock made this dead');
});

test('🔴 a publish refused as in-flight claims no spinner of its own', async () => {
  // B pressing publish while A is on the wire used to overwrite publishGen before run() returned
  // in_flight, so B's spinner showed and B's button disabled with no B request behind it — stuck until
  // A settled.
  const byId = installDom();
  const slowA = deferred();
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') return okJson({ token: 'ET', updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [{ key: 'Pizza', surface: 'item', field: 'price', old: 299, new: 310 }], largeChangeSet: [] } });
    return slowA.promise;
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();

  const a = byId.get('pubbtn').listeners.click[0]();
  await Promise.resolve();
  const busyDuringA = byId.get('pubbtn').dataset.busy;
  const genDuringA = app.state.publishGen;
  assert.strictEqual(busyDuringA, '1', 'premise: A owns the spinner');

  await byId.get('pubbtn').listeners.click[0]();      // refused as in-flight
  assert.strictEqual(app.state.publishGen, genDuringA, '🔴 the skipped press claimed no world of its own');
  assert.strictEqual(byId.get('pubbtn').dataset.busy, busyDuringA, '...and did not disturb A’s spinner');
  assert.strictEqual(byId.get('pubbtn').disabled, true, '...while the button stays disabled for A’s request');

  slowA.resolve(okJson({ versionId: 'vA' }));
  await a;
  assert.strictEqual(byId.get('pubbtn').dataset.busy, undefined, 'and clears once the real request settles');
});

test('🔴 a restaurant-lookup FAILURE after B takes over does not disturb B', async () => {
  const byId = installDom();
  const slow = deferred();
  installFetch((fn) => (fn === 'getMyRestaurants' ? slow.promise
    : okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })));
  const app = await loadAppModule();

  const looking = app.loadRestaurants();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  await app.loadMenu('x_pizza');
  const bGroups = app.state.groups.length;
  assert.ok(bGroups > 0, 'premise: B has a menu on screen');
  // What the failure path would actually destroy is the DOM — showEmpty() empties the rail and replaces
  // the detail. It never touches state.groups, so asserting the count alone passed on the broken code:
  // removing the generation check left this test green while the screen went blank.
  const rails = byId.get('rail').querySelectorAll('.railitem').length;
  assert.ok(rails > 0, 'premise: B’s rail is painted');
  assert.strictEqual(byId.get('detail').querySelectorAll('.nm')[0].textContent, 'Pizza', 'premise: and B’s dish is on screen');

  slow.reject(Object.assign(new Error('store_unavailable'), { code: 'store_unavailable', status: 503 }));
  await looking;
  assert.strictEqual(app.state.groups.length, bGroups, 'the stale lookup failure left B’s menu alone');
  assert.strictEqual(byId.get('rail').querySelectorAll('.railitem').length, rails, '🔴 B’s rail is still painted');
  assert.strictEqual(byId.get('detail').querySelectorAll('.nm')[0].textContent, 'Pizza',
    '🔴 and B’s dish is still on screen — not replaced by the stale tenant’s error panel');
});

test('🔴 a failed PUBLISH hands editing back so its recovery panel can re-enter', async () => {
  // The save-failure path releases in its own finally; the PUBLISH path does not, so without
  // showOutcome handing the draft back, "Volver a la revisión" and "Revisar de nuevo" hit a held lock
  // and do nothing — the same dead-panel bug, one operation over.
  const byId = installDom();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') { saves += 1; return okJson({ token: `ET${saves}`, updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [{ key: 'Pizza', surface: 'item', field: 'price', old: 299, new: 310 }], largeChangeSet: [] } }); }
    return { ok: false, status: 409, json: async () => ({ error: 'edit_superseded' }) };
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(saves, 1, 'premise: the review opened');

  await byId.get('pubbtn').listeners.click[0]();       // publish fails with edit_superseded
  assert.ok(!('inert' in byId.get('drawer').attrs), '🔴 the failed publish handed the draft back');

  // "Revisar de nuevo" must re-enter openReviewFlow, which needs the lock
  const action = byId.get('mbody').querySelectorAll('button')[0];
  assert.ok(action, 'the panel offers its action');
  await action.listeners.click[0]();
  assert.strictEqual(saves, 2, '🔴 the re-review really re-entered — a held lock made this dead');
});

test('🔴 a skipped publish in a NEW world does not light a spinner it is not waiting on', async () => {
  // The admission-timing defect, in the world where it is observable: A is still on the wire from a
  // world the merchant has left, so this world is waiting on nothing. A press refused as in-flight
  // must claim no world — otherwise the spinner lights with no request behind it and stays lit until
  // someone else's request finishes.
  const byId = installDom();
  const slowA = deferred();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') { saves += 1; return okJson({ token: `ET${saves}`, updateTime: 'T2', diff: { added: [], removed: [], renamed: [], changed: [{ key: 'Pizza', surface: 'item', field: 'price', old: 299, new: 310 }], largeChangeSet: [] } }); }
    return slowA.promise;
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();
  const a = byId.get('pubbtn').listeners.click[0]();        // A on the wire
  await Promise.resolve();

  // the world ends; this world waits on nothing
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  assert.strictEqual(byId.get('pubbtn').dataset.busy, undefined, 'premise: the new world shows no spinner');
  assert.strictEqual(app.state.publishGen, null, 'premise: and is waiting on nothing');

  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();
  await byId.get('pubbtn').listeners.click[0]();            // refused: A still holds the wire
  assert.strictEqual(app.state.publishGen, null,
    '🔴 the refused press claimed no world — it has no request of its own');
  assert.strictEqual(byId.get('pubbtn').dataset.busy, undefined,
    '🔴 so no spinner lit, and none can be stuck until A finishes');

  slowA.resolve(okJson({ versionId: 'vA' }));
  await a;
});

// ── THE SHARED-STATE CALLBACK GUARD, EXECUTABLY ──────────────────────────────────────────────────
// canEdit closed the DRAFT writers. These three close the other class: callbacks and handlers that
// write shared state which is not the draft. Each fires a retained or ill-timed handler and asserts it
// changed nothing.

const CHANGED_DIFF = { added: [], removed: [], renamed: [], changed: [{ key: 'Pizza', surface: 'item', field: 'price', old: 299, new: 310 }], largeChangeSet: [] };

test('🔴 review A’s acknowledgement checkbox cannot acknowledge review B', async () => {
  // The forgery: the callback wrote through the GLOBAL state.review, so A's retained checkbox
  // acknowledged whatever review happened to be open. On a fiscal merchant that is a forged SAR
  // attestation — the merchant is recorded as having signed for a set of changes they never saw.
  const byId = installDom();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: true });
    if (fn === 'editCatalog') { saves += 1; return okJson({ token: `ET${saves}`, updateTime: 'T2', diff: CHANGED_DIFF }); }
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  await byId.get('review').listeners.click[0]();
  const aBoxes = byId.get('mbody').querySelectorAll('input').filter((i) => i.type === 'checkbox');
  assert.ok(aBoxes.length > 0, 'premise: review A rendered an attestation to sign');
  const aCheckbox = aBoxes[0];                       // the reference a page could still hold

  byId.get('pubback').listeners.click[0]();          // A is closed
  await byId.get('review').listeners.click[0]();     // B opens — a different review, a different token
  assert.strictEqual(saves, 2, 'premise: B is a genuinely new review');
  assert.strictEqual(app.state.review.acknowledged, false, 'premise: B is unsigned');

  aCheckbox.checked = true;
  aCheckbox.listeners.change[0]();
  assert.strictEqual(app.state.review.acknowledged, false,
    '🔴 A’s checkbox acknowledged NOTHING — an attestation belongs to the review it was rendered for');
  assert.strictEqual(byId.get('pubbtn').disabled, true, '...so B’s publish is still gated on a real signature');
});

test('🔴 a publish press with nothing to publish does not swallow the edit lock', async () => {
  // It acquired the lock, asked the publisher, got `not_ready`, and returned without releasing —
  // canEdit() false forever. The portal became read-only, and no review could ever open again.
  const byId = installDom();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') { saves += 1; return okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF }); }
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  assert.ok(app.state.draft.canEdit(), 'premise: the draft starts editable');

  await byId.get('pubbtn').listeners.click[0]();     // no review exists; the press is meaningless
  assert.strictEqual(app.state.draft.canEdit(), true,
    '🔴 the meaningless press took no ownership — the draft is still editable');

  await byId.get('review').listeners.click[0]();     // and the portal still works
  assert.strictEqual(saves, 1, '🔴 a review can still open — the lock was never leaked');
});

test('🔴 a review cannot be closed while its own publish is on the wire', async () => {
  // Closing released the lock mid-publish, so the merchant could edit and start a SAVE against a
  // baseline the pending publish was about to move. Not a double publish — a corrupted baseline.
  const byId = installDom();
  const slowPub = deferred();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') { saves += 1; return okJson({ token: `ET${saves}`, updateTime: 'T2', diff: CHANGED_DIFF }); }
    return slowPub.promise;
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();

  const publishing = byId.get('pubbtn').listeners.click[0]();
  await Promise.resolve();
  assert.ok(app.state.review, 'premise: the publish is on the wire');

  byId.get('pubback').listeners.click[0]();          // "Volver a editar", pressed mid-flight
  assert.ok(app.state.review, '🔴 the review did not close under its own in-flight publish');
  assert.ok('inert' in byId.get('drawer').attrs, '🔴 and editing is still refused — the draft stays owned');
  assert.strictEqual(saves, 1, 'premise: no save slipped in');

  slowPub.resolve(okJson({ versionId: 'v1' }));
  await publishing;
  assert.ok(!('inert' in byId.get('drawer').attrs), 'and once it settles, editing comes back');
});

test('🔴 A’s checkbox cannot acknowledge a LATER review that happens to carry the same token', async () => {
  // Why the guard captures the GENERATION and not just the review identity. The edit token is derived
  // from the draft and its updateTime, so re-opening a review over an unchanged draft can legitimately
  // return the SAME token — and then "is this still my review?" answers yes for a review that belongs
  // to a different session entirely. The generation is what knows the world ended.
  const byId = installDom();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: true });
    if (fn === 'editCatalog') { saves += 1; return okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF }); }  // the SAME token, every time
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  await byId.get('review').listeners.click[0]();
  const aCheckbox = byId.get('mbody').querySelectorAll('input').filter((i) => i.type === 'checkbox')[0];
  const aToken = app.state.review.editToken;

  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'OTHER' } }));   // a different person
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(app.state.review.editToken, aToken, 'premise: the tokens really are identical');
  assert.strictEqual(app.state.review.acknowledged, false, 'premise: the new session has signed nothing');

  aCheckbox.checked = true;
  aCheckbox.listeners.change[0]();
  assert.strictEqual(app.state.review.acknowledged, false,
    '🔴 the previous session’s checkbox signed nothing — the token matched, the WORLD did not');
});

test('🔴 a meaningless publish press takes no ownership at the instant it is pressed', async () => {
  // Not "the lock came back" — it never should have been taken. Releasing it afterwards leaves a window
  // across the await in which the draft is locked for a request that was never sent, and a save started
  // in that window is refused for no reason the merchant can see.
  const byId = installDom();
  installFetch((fn) => (fn === 'getEditableCatalog'
    ? okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })
    : okJson({ versionId: 'v1' })));
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  const pressed = byId.get('pubbtn').listeners.click[0]();     // deliberately NOT awaited
  assert.strictEqual(app.state.draft.canEdit(), true,
    '🔴 synchronously after the press, the draft is STILL editable — nothing was acquired');
  await pressed;
  assert.strictEqual(app.state.draft.canEdit(), true, 'and it stays that way once the press unwinds');
});

test('🔴 a publish refused at the attestation gate hands its ticket back', async () => {
  // The press that gets furthest before being refused: a real review, with a real attestation, that
  // simply has not been signed. It clears the pre-check and IS admitted to the lock — so this is the
  // path where a ticket genuinely gets acquired and must genuinely be returned.
  const byId = installDom();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: true });
    if (fn === 'editCatalog') { saves += 1; return okJson({ token: `ET${saves}`, updateTime: 'T2', diff: CHANGED_DIFF }); }
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(app.state.review.acknowledged, false, 'premise: unsigned, so the gate will refuse it');

  const review = app.state.review;
  byId.get('pubback').listeners.click[0]();          // back to editing; the review hands the ticket back
  assert.ok(app.state.draft.canEdit(), 'premise: editing is available again');

  // Put the review back WITHOUT its lock — the shape showOutcome leaves behind: a review still on
  // screen, its ticket already returned because the operation has settled. A press here is the only
  // one that both clears the pre-check AND gets refused, so it is the only one that acquires a ticket
  // it must give back. Reconstructed rather than driven, because reaching it through the UI needs a
  // failure panel to lose its acknowledgement — but the handler must survive it either way.
  app.state.review = review;
  await byId.get('pubbtn').listeners.click[0]();     // a retained press against the now-unsigned review
  assert.strictEqual(app.state.draft.canEdit(), true,
    '🔴 the refused publish returned the ticket it took — the draft is editable, not frozen');
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(saves, 2, '🔴 and a fresh review can still open');
});

// ── #7-B — A SAVED DRAFT IS REACHABLE ────────────────────────────────────────────────────────────
// editCatalog PERSISTS the draft, and getEditableCatalog returns the saved draft — not the live menu.
// So after a reload, orig === state === the saved source and pendingCount is 0, while the merchant's
// unpublished work is sitting on the server. The bar keyed off pendingCount, so #review never appeared
// and that work was unreachable: a dead end on the merchant's own saved edits.
//
// B surfaces the entry whenever a draft exists and lets the SERVER answer what is unpublished, which is
// the only thing that actually knows. It rides openReviewFlow unchanged — same admission control, same
// generation stamp, same reviewBound attestation.

test('🔴 a reloaded saved draft can still reach the review at pendingCount 0', async () => {
  const byId = installDom();
  installFetch((fn) => (fn === 'getEditableCatalog'
    ? okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })
    : okJson({ versionId: 'v1' })));
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  assert.strictEqual(pendingCountOf(app), 0, 'premise: nothing has been typed this session');
  assert.ok(byId.get('rbar').classList.contains('show'),
    '🔴 the review bar is reachable — a draft exists, and only the server knows if it is published');
  assert.strictEqual(byId.get('review').disabled, false, '...and the way forward is not disabled');

  // 🔴 AND IT CLAIMS NOTHING. The client is holding the draft, not the live version — it cannot know
  // whether anything is unpublished. "0 cambios sin publicar" would be an assertion it has no standing
  // to make, and it would be WRONG in precisely the reloaded-saved-draft case B exists to rescue.
  const txt = byId.get('rbtxt').textContent;
  assert.doesNotMatch(txt, /\d+\s+cambios?\s+sin publicar/,
    '🔴 the bar states no count it cannot know — it invites the question instead of answering it');
  assert.match(txt, /Revisá/, 'and what it says is an invitation to look');
  assert.ok(byId.get('discard').classList.contains('hidden'),
    'and Descartar is gone — nothing was typed, so there is nothing to throw away');
});

test('🔴 the review at pendingCount 0 shows the SERVER’s unpublished delta', async () => {
  // The whole point of B: the merchant typed nothing this session, but the saved draft is 310 against a
  // live menu of 299. Locally that difference is invisible. The server's diff is what surfaces it.
  const byId = installDom();
  const calls = installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') return okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF });
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  assert.strictEqual(pendingCountOf(app), 0, 'premise: no local edits');
  // The shim calls listeners directly, so this test would pass on a bar nobody can see. Assert the
  // merchant can actually GET here before asserting what they find.
  assert.ok(byId.get('rbar').classList.contains('show'), 'premise: and the entry is on screen to press');
  assert.strictEqual(byId.get('review').disabled, false, '...and pressable');

  await byId.get('review').listeners.click[0]();
  const save = calls.find((c) => c.fn === 'editCatalog');
  assert.ok(save && save.body && save.body.source, 'the saved draft really was submitted for a diff');
  assert.ok(app.state.review, '🔴 a review exists for work this session never typed');
  const names = byId.get('mbody').querySelectorAll('.pname').map((n) => n.textContent);
  assert.ok(names.includes('Pizza'), '🔴 and the unpublished change is on screen, named');
  assert.strictEqual(byId.get('pubbtn').disabled, false, '...and publishable, which it was not before B');
});

test('🔴 a draft that truly equals live says so, and refuses to publish nothing', async () => {
  // The honest other half. B makes the entry always reachable, so "there is nothing here" became a
  // reachable answer and must be a TRUTHFUL one — not an empty panel, and not a publish.
  //
  // 🔴 Fiscal merchant on purpose: publishing an empty diff would mint a version and record a SAR
  // attestation for zero changes. A signature for nothing is the same forgery class as signing for
  // someone else's changes, so the gate refuses before any signature is collected.
  const byId = installDom();
  const EMPTY = { added: [], removed: [], renamed: [], changed: [], largeChangeSet: [] };
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: true });
    if (fn === 'editCatalog') return okJson({ token: 'ET', updateTime: 'T2', diff: EMPTY });
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  await byId.get('review').listeners.click[0]();
  const text = byId.get('mbody').querySelectorAll('.empty').map((n) => n.textContent).join(' ');
  assert.match(text, /No hay cambios sin publicar/, '🔴 it says plainly that there is nothing to publish');
  assert.strictEqual(byId.get('mbody').querySelectorAll('input').filter((i) => i.type === 'checkbox').length, 0,
    '🔴 and collects NO attestation — there is nothing to attest to');
  assert.strictEqual(byId.get('pubbtn').disabled, true,
    '🔴 and publish is refused: a no-op version flip with a signature attached is not a publish');
});

test('🔴 the review entry survives being used — open, close, and it is live again', async () => {
  // Found while building #7-B, and it is why B needs it. openReviewFlow disabled #review and NOTHING
  // re-enabled it: not closeReview, not syncUi — only refreshBar, which runs on a repaint or a
  // keystroke. So open-then-close left the entry dead until the merchant typed something.
  //
  // Before B the bar was hidden at count 0 and this was hard to reach. B makes the bar permanent, which
  // would have shipped a PERMANENTLY VISIBLE DEAD BUTTON on exactly the reloaded-saved-draft screen the
  // whole change exists to rescue: nothing to type, so nothing to bring it back.
  //
  // The shim calls listeners directly, so `disabled` does not stop it here — a browser would. That is
  // the gap this asserts against, and why the assertion is on the PROPERTY, not on the effect.
  const byId = installDom();
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') return okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF });
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  assert.strictEqual(byId.get('review').disabled, false, 'premise: the entry starts live');

  await byId.get('review').listeners.click[0]();
  assert.strictEqual(byId.get('review').disabled, true, 'while the review owns the draft, the entry is refused');

  byId.get('pubback').listeners.click[0]();          // close it; the review hands the draft back
  assert.strictEqual(byId.get('review').disabled, false,
    '🔴 and the entry is LIVE again — a merchant with nothing left to type can still get back in');
});

test('🔴 signing out takes the review entry with it', async () => {
  // "Whoever ends a world cleans its UI" — the principle that closed the stranded spinner, one control
  // over. The auth handler called invalidateReview() (which repaints) and THEN nulled the draft, so the
  // last paint of the old world ran while the draft still existed: bar up, entry live, draft gone.
  // Pressing it calls draftSource(null).
  //
  // Pre-B the bar only ever appeared for a DIRTY draft, so this needed unpublished edits to reach. B
  // puts the bar up for every loaded draft, which makes it the ordinary case.
  const byId = installDom();
  installFetch((fn) => (fn === 'getEditableCatalog'
    ? okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })
    : okJson({ versionId: 'v1' })));
  const app = await loadAppModule();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'A' } }));
  await app.loadMenu('x_pizza');
  assert.ok(byId.get('rbar').classList.contains('show'), 'premise: A can reach the review');

  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));   // a different person
  assert.strictEqual(app.state.draft, null, 'premise: B does not inherit A’s draft');
  assert.ok(!byId.get('rbar').classList.contains('show'),
    '🔴 and the review bar went with it — no entry to a draft that no longer exists');
  assert.strictEqual(byId.get('review').disabled, true, '🔴 and the entry itself is refused');
});

// ── PROVENANCE: A LISTENER BELONGS TO THE WORLD THAT CREATED IT ──────────────────────────────────
// canEdit answers OWNERSHIP — is editing allowed right now. It cannot answer PROVENANCE — does this
// particular callback belong to the draft, review and generation that are current. A retained listener
// firing while editing is legitimately allowed passes canEdit and still writes into the wrong world.

test('🔴 a retained drawer input writes ITS OWN dish, never whichever drawer is open now', async () => {
  // The item price field read state.drawerKey at DISPATCH time. Open Pizza, keep a reference, open
  // Other, fire the old listener: it looked up "the open drawer" and found Other. A price typed for one
  // dish landed on a different one, with both drawers legitimately editable, so canEdit saw nothing
  // wrong — it was not an ownership failure, it was a targeting failure.
  const byId = installDom();
  installFetch(() => okJson({ source: TWO_ITEMS(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false }));
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  app.openDrawer('Pizza');
  const pizzaInput = byId.get('drawer').querySelectorAll('input')[0];
  app.openDrawer('Other');                           // the merchant moves on
  const rowOf = (k) => app.state.draft.state.items.find((i) => i.key === k);
  assert.strictEqual(rowOf('Other').price, 150, 'premise: Other is untouched');

  pizzaInput.value = '888';
  pizzaInput.listeners.input[0]();
  assert.strictEqual(rowOf('Other').price, 150,
    '🔴 the retained listener did NOT reprice the dish that happens to be open');
  assert.strictEqual(rowOf('Pizza').price, 888, 'it wrote the dish it was created for, or nothing at all');
});

test('🔴 a drawer input retained across a sign-in cannot price the new session’s menu', async () => {
  // The option field already captured its key, so it always hit the right ROW — in the wrong DRAFT.
  // After a different person signs in and their menu loads, the retained listener finds a fresh draft
  // with no lock on it: canEdit says yes, and 777 lands on someone else's menu.
  const byId = installDom();
  installFetch(() => okJson({ source: WITH_EXTRA(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false }));
  const app = await loadAppModule();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'A' } }));
  await app.loadMenu('x_pizza');

  app.openDrawer('Pizza');
  byId.get('drawer').querySelectorAll('.mgmain')[0].listeners.click[0]();
  const optInput = byId.get('drawer').querySelectorAll('input')
    .find((i) => (i.attrs['aria-label'] || '').startsWith('Precio de '));
  assert.ok(optInput, 'premise: A has an option field open');

  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  await app.loadMenu('x_pizza');                     // B's menu, a brand new draft
  assert.ok(app.state.draft.canEdit(), 'premise: B is editing freely — no lock refuses this');
  const before = app.state.draft.state.extras[0].price;

  optInput.value = '777';
  optInput.listeners.input[0]();
  assert.strictEqual(app.state.draft.state.extras[0].price, before,
    '🔴 A’s field cannot price B’s menu — it belongs to a draft that no longer exists');
});

test('🔴 a retained recovery control cannot re-enter from a world that has ended', async () => {
  // The failure panel's buttons drive real transitions — reload the draft, re-review, retry. Retained
  // and fired later they re-enter those transitions from a dead world: a stale RELOAD calls loadMenu,
  // which invalidates and RELEASES the edit lock — while a publish it knows nothing about is pending.
  const byId = installDom();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') { saves += 1; return okJson({ token: `ET${saves}`, updateTime: 'T2', diff: CHANGED_DIFF }); }
    // stale_edit, so the panel offers RELOAD. That one matters most: REREVIEW and RETRY re-enter
    // openReviewFlow, which is admission-controlled and already refuses a second entry — but RELOAD
    // calls loadMenu, which INVALIDATES unconditionally and clears the lock holder. It is the one
    // recovery control that can hand away a draft somebody else is holding.
    return { ok: false, status: 409, json: async () => ({ error: 'stale_edit' }) };
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  // A real boot sets this through loadRestaurants/switchTo; loadMenu alone does not, and RELOAD reads
  // it. Without it loadMenu(null) returns at its first line and the stale control looks harmless for a
  // reason that has nothing to do with provenance.
  app.state.currentRid = 'x_pizza';
  await byId.get('review').listeners.click[0]();
  await byId.get('pubbtn').listeners.click[0]();     // fails; the recovery panel appears
  const staleAction = byId.get('mbody').querySelectorAll('button')[0];
  assert.ok(staleAction, 'premise: the panel offers a recovery action');

  await byId.get('review').listeners.click[0]();     // a NEW review begins; the old world is over
  const savesNow = saves;
  const lockedTo = app.state.reviewLock;
  assert.ok(lockedTo !== null, 'premise: the new review owns the draft');

  await staleAction.listeners.click[0]();            // the retained control fires
  assert.strictEqual(saves, savesNow, '🔴 the stale control started nothing');
  assert.strictEqual(app.state.reviewLock, lockedTo, '🔴 and did not hand away the live review’s draft');
  assert.ok(!app.state.draft.canEdit(), '🔴 the live review still owns the draft it was given');
});


test('🔴 binding a price field to its generation does not leave it dead after a review', async () => {
  // The cost of generation-binding, paid for deliberately. openReviewFlow BUMPS the generation, so
  // every field built before it is refused from then on — correct while the review is open, and a dead
  // control the moment it closes, because closeReview repainted nothing. That is the same dead-control
  // shape as the #review button, one layer down, and it would have been introduced BY the fix.
  //
  // Whoever ends a world repaints it: closeReview rebuilds from the draft, so the fields come back
  // belonging to the world that now exists.
  const byId = installDom();
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: TWO_ITEMS(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') return okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF });
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  await byId.get('review').listeners.click[0]();     // bumps the generation
  byId.get('pubback').listeners.click[0]();          // and closes again

  app.openDrawer('Pizza');
  const input = byId.get('drawer').querySelectorAll('input')[0];
  input.value = '444';
  input.listeners.input[0]();
  assert.strictEqual(app.state.draft.state.items.find((i) => i.key === 'Pizza').price, 444,
    '🔴 a field opened AFTER the review still edits — binding refuses stale worlds, not the current one');
});

test('🔴 an INLINE price cell retained across a sign-in cannot price the new session’s menu', async () => {
  // The drawer fields were the obvious retained surface, so they were the ones the last rounds looked
  // at. The inline cells in the list are the same hazard and were passed `onPrice` as a bare module
  // reference — one function, shared by every cell ever rendered, belonging to no world at all. Binding
  // the drawer fields and not this would have left the biggest editing surface on the screen unbound.
  const byId = installDom();
  installFetch(() => okJson({ source: TWO_ITEMS(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false }));
  const app = await loadAppModule();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'A' } }));
  await app.loadMenu('x_pizza');

  const cell = byId.get('detail').querySelectorAll('.price')
    .flatMap((c) => c.querySelectorAll('input'))[0];
  assert.ok(cell, 'premise: A has an editable inline price cell');

  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));
  await app.loadMenu('x_pizza');                     // B's menu, a brand new draft
  assert.ok(app.state.draft.canEdit(), 'premise: B is editing freely — ownership refuses nothing here');
  const before = app.state.draft.state.items.map((i) => i.price);

  cell.value = '555';
  cell.listeners.input[0]();
  assert.deepStrictEqual(app.state.draft.state.items.map((i) => i.price), before,
    '🔴 A’s cell cannot price B’s menu');
});

// ── THE THREE CAPTURES, PROVEN ONE AT A TIME ─────────────────────────────────────────────────────
// The existing forgery tests move more than one thing at once — opening a second review changes the
// token AND bumps the generation, so either check alone would pass them. A wrapper whose clauses are
// never tested individually is a wrapper that can lose one in a refactor and stay green. Each test
// below moves exactly ONE capture and holds the other two still.

const openedReview = async (byId, app) => {
  await byId.get('review').listeners.click[0]();
  const cb = byId.get('mbody').querySelectorAll('input').filter((i) => i.type === 'checkbox')[0];
  assert.ok(cb, 'premise: an attestation to sign');
  return cb;
};
const fiscalFetch = (tok = 'ET') => installFetch((fn) => {
  if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: true });
  if (fn === 'editCatalog') return okJson({ token: tok, updateTime: 'T2', diff: CHANGED_DIFF });
  return okJson({ versionId: 'v1' });
});

test('🔴 capture 2 of 3: the REVIEW TOKEN alone, generation and draft held still', async () => {
  const byId = installDom();
  fiscalFetch();
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  const cb = await openedReview(byId, app);

  const gen = app.state.publishGen;                  // nothing below touches the generation
  const draft = app.state.draft;
  // A different review, arrived at without ending the world — the case a token check exists for, and
  // the only way to reach it in isolation.
  app.state.review = { ...app.state.review, editToken: 'ET-DIFFERENT', acknowledged: false };

  cb.checked = true;
  cb.listeners.change[0]();
  assert.strictEqual(app.state.review.acknowledged, false,
    '🔴 the token alone refused it — this checkbox was rendered for a different review');
  assert.strictEqual(app.state.draft, draft, 'and nothing else moved');
  assert.strictEqual(app.state.publishGen, gen, 'the generation never changed, so it proved nothing here');
});

test('🔴 capture 3 of 3: the DRAFT alone, generation and token held still', async () => {
  const byId = installDom();
  installFetch(() => okJson({ source: WITH_EXTRA(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false }));
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  const cell = byId.get('detail').querySelectorAll('.price').flatMap((c) => c.querySelectorAll('input'))[0];
  assert.ok(cell, 'premise: an editable inline cell');
  const genBefore = app.state.publishGen;

  // A replacement draft, swapped in without a reload — same generation, same (absent) review. In the
  // app a new draft always arrives with a bump; that coupling is exactly what would hide the loss of
  // this clause, so it is broken here on purpose.
  const fresh = makeDraft(WITH_EXTRA());
  app.state.draft = fresh;
  assert.ok(fresh.canEdit(), 'premise: the new draft is editable — ownership refuses nothing');

  cell.value = '666';
  cell.listeners.input[0]();
  assert.strictEqual(fresh.state.items[0].price, 299,
    '🔴 the draft identity alone refused it — this cell was rendered against a draft that is gone');
  assert.strictEqual(app.state.publishGen, genBefore, 'the generation never changed, so it proved nothing here');
});

const inlineCell = (byId) => byId.get('detail').querySelectorAll('.price').flatMap((c) => c.querySelectorAll('input'))[0];

test('🔴 inline cells come back after a review closes — binding must not strand them', async () => {
  // The drawer survived this because openDrawer rebuilds its own fields. The inline cells are built by
  // paint() and nothing repaints them when a review closes, so generation-binding would have killed
  // every price cell on the page after one visit to the review — the worst dead control in the slice,
  // introduced by the fix for the previous one.
  const byId = installDom();
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: TWO_ITEMS(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') return okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF });
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  await byId.get('review').listeners.click[0]();
  byId.get('pubback').listeners.click[0]();

  const cell = inlineCell(byId);                     // read AFTER the close, as a merchant would
  cell.value = '321';
  cell.listeners.input[0]();
  assert.strictEqual(app.state.draft.state.items[0].price, 321,
    '🔴 the page is editable again after a review — the world that ended repainted the one that follows');
});

test('🔴 capture 1 of 3: the GENERATION alone, draft and review held still', async () => {
  // A re-authentication for the SAME person: the identity has not changed, so the draft is kept and no
  // review is open — draft identity and token are both unmoved. Only the generation says the previous
  // world is over, and a reference retained across it must still be refused. This is the one path where
  // that clause is the only thing standing there.
  const byId = installDom();
  installFetch(() => okJson({ source: TWO_ITEMS(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false }));
  const app = await loadAppModule();
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'A' } }));
  await app.loadMenu('x_pizza');

  const stale = inlineCell(byId);
  const draft = app.state.draft;
  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'A' } }));   // same person, new session
  assert.strictEqual(app.state.draft, draft, 'premise: the draft was kept — identity cannot refuse this');
  assert.strictEqual(app.state.review, null, 'premise: no review is open — the token cannot refuse it either');

  stale.value = '999';
  stale.listeners.input[0]();
  assert.strictEqual(draft.state.items[0].price, 299,
    '🔴 the generation alone refused it — the reference predates the current session');

  // ...and the merchant is not stranded: the ender repainted, so the live cells work.
  const fresh = inlineCell(byId);
  fresh.value = '777';
  fresh.listeners.input[0]();
  assert.strictEqual(app.state.draft.state.items[0].price, 777, 'the rebuilt cell edits normally');
});

// ── SERVER-WRITE ADMISSION ACROSS WORLD-TRANSITIONS ──────────────────────────────────────────────
// The third leg. The generation spine stops a stale answer from PAINTING; bound() stops a stale
// listener from WRITING LOCALLY. Neither governs what is allowed to leave the browser. A world ending
// does not un-send a request that is already on the wire — but the enders released the edit lock as
// though it did, so the next operation was admitted alongside an outstanding one.

test('🔴 a tenant switch does not release a lock whose editCatalog is still on the wire', async () => {
  const byId = installDom();
  const slowSave = deferred();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') { saves += 1; return saves === 1 ? slowSave.promise : okJson({ token: 'ET2', updateTime: 'T3', diff: CHANGED_DIFF }); }
    return okJson({ versionId: 'v1' });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');

  const saving = byId.get('review').listeners.click[0]();     // editCatalog goes out and stays out
  await Promise.resolve();
  assert.strictEqual(saves, 1, 'premise: a write is on the wire');

  await app.loadMenu('la_musa');                              // the merchant switches tenants
  await byId.get('review').listeners.click[0]();              // and tries to review the new one
  assert.strictEqual(saves, 1,
    '🔴 no second write was admitted — the first one is still outstanding, and a world ending does not un-send it');

  slowSave.resolve(okJson({ token: 'ET1', updateTime: 'T2', diff: CHANGED_DIFF }));
  await saving;
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(saves, 2, '🔴 and once it settles, admission is available again');
});

test('🔴 a review cannot be opened while the tenant’s draft is still loading', async () => {
  // The money case. During a switch the OLD draft is still in memory and the NEW rid is already
  // current, so a review admitted here sends one tenant's rid with the other tenant's source — a write
  // that is internally consistent, passes every client check, and prices the wrong restaurant.
  const byId = installDom();
  const slowLoad = deferred();
  let n = 0, sent = null;
  const calls = installFetch((fn) => {
    if (fn === 'getEditableCatalog') { n += 1; return n === 1
      ? okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })
      : slowLoad.promise; }
    return okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  app.state.currentRid = 'x_pizza';

  const switching = app.loadMenu('la_musa');                  // in flight; la_musa is now current
  app.state.currentRid = 'la_musa';
  await Promise.resolve();

  await byId.get('review').listeners.click[0]();
  assert.strictEqual(calls.filter((c) => c.fn === 'editCatalog').length, 0,
    '🔴 nothing was written while the draft on screen belonged to the tenant being left');

  slowLoad.resolve(okJson({ source: SOURCE(), sourceUpdateTime: 'T9', activeVersionId: 'v9', usesPlatformFactura: false }));
  await switching;
  await byId.get('review').listeners.click[0]();
  const save = calls.find((c) => c.fn === 'editCatalog');
  assert.ok(save, '🔴 and once the draft is in, the review works normally');
  assert.strictEqual(save.body.restaurantId, 'la_musa', 'writing the tenant it actually loaded');
  assert.strictEqual(save.body.baseSourceUpdateTime, 'T9', '🔴 against THAT tenant’s CAS baseline, not the one left behind');
});

test('🔴 the write names the tenant the DRAFT was loaded for, even before a tenant is selected', async () => {
  // A real state, not a contrived one: state.currentRid is set by loadRestaurants/switchTo, so between
  // a direct load and that handshake the draft exists and no tenant is "selected". Reading
  // state.currentRid for the write would name nothing at all; the draft always knows what it is.
  const byId = installDom();
  const calls = installFetch((fn) => (fn === 'getEditableCatalog'
    ? okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })
    : okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF })));
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  assert.strictEqual(app.state.currentRid, null, 'premise: no tenant selected yet');

  await byId.get('review').listeners.click[0]();
  const save = calls.find((c) => c.fn === 'editCatalog');
  assert.ok(save, 'premise: the review was admitted');
  assert.strictEqual(save.body.restaurantId, 'x_pizza',
    '🔴 the write names the rid the source was LOADED for, never the selection');
});

test('🔴 a draft belonging to another tenant is refused admission outright', async () => {
  // Defence in depth against the two falling out of step for ANY reason. Reconstructed rather than
  // driven — a normal switch clears the draft, so the pairing cannot legitimately diverge — but this
  // is the check that makes "a review can never carry B's rid with A's source" true by inspection
  // rather than by tracing every path that sets them.
  const byId = installDom();
  const calls = installFetch((fn) => (fn === 'getEditableCatalog'
    ? okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })
    : okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF })));
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  assert.strictEqual(app.state.draftRid, 'x_pizza', 'premise: the draft knows whose it is');

  app.state.currentRid = 'la_musa';                  // selection and draft out of step
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(calls.filter((c) => c.fn === 'editCatalog').length, 0,
    '🔴 refused — the draft on screen is not this tenant’s, so nothing may be written for either');
});

test('🔴 a review is refused after a load FAILED, with no draft to write', async () => {
  // menuLoading is false here — the load settled — so this is the case only the draft-readiness check
  // refuses. The two admission clauses are deliberately redundant (a transition clears the draft AND
  // raises the flag), and this is the path that tells them apart.
  const byId = installDom();
  const calls = installFetch((fn) => {
    if (fn === 'getEditableCatalog') return Promise.reject(Object.assign(new Error('store_unavailable'), { code: 'store_unavailable', status: 503 }));
    return okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF });
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  assert.strictEqual(app.state.draft, null, 'premise: the load failed, so there is no draft');
  assert.strictEqual(app.state.menuLoading, false, 'premise: and it is NOT still loading — it settled');

  await byId.get('review').listeners.click[0]();
  assert.strictEqual(calls.filter((c) => c.fn === 'editCatalog').length, 0,
    'nothing was written — there is no document to write');
  // 🔴 REFUSED, not ATTEMPTED-AND-FAILED. Without the readiness check the flow takes the lock, calls
  // draftSource(null), throws, and lands in the failure panel — no write leaves either way, so
  // "no editCatalog" alone proved nothing. What separates them is whether the merchant is shown an
  // error for an operation they could not have started.
  assert.ok(!byId.get('scrim').classList.contains('show'),
    '🔴 no failure panel — the press was refused at admission, not crashed through');
  assert.strictEqual(byId.get('review').disabled, true, 'and the entry says so');
  assert.strictEqual(app.state.reviewLock, null, '🔴 and it took no ownership on the way');
});

test('🔴 the explicit loading flag refuses admission on its own', async () => {
  // Constructed. A transition clears the draft AND raises this flag, so in the running app the two
  // always agree and either would refuse alone — which is exactly why this clause could be deleted
  // without a single test noticing. It is pinned here as its own contract: "a load is outstanding"
  // refuses a write by itself, whatever else happens to be true.
  const byId = installDom();
  const calls = installFetch((fn) => (fn === 'getEditableCatalog'
    ? okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false })
    : okJson({ token: 'ET', updateTime: 'T2', diff: CHANGED_DIFF })));
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  assert.ok(app.state.draft && app.state.draftRid, 'premise: a perfectly good draft is loaded');

  app.state.menuLoading = true;                      // ...and a load is outstanding
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(calls.filter((c) => c.fn === 'editCatalog').length, 0,
    '🔴 refused on the flag alone — the document is about to be replaced');
});

test('🔴 a REFUSED duplicate publish does not hand away the live publish’s wire ownership', async () => {
  // The hole ticket-identity leaves. runPublish reuses the review's ticket, so a second press —
  // refused by the publisher as already in flight — called beginWrite and then endWrite with the SAME
  // ticket the live request holds, clearing its wire ownership. The lock then looked free to the next
  // ender, and everything the previous round built on top of it came undone.
  //
  // Ownership of the wire belongs to a REQUEST, not to a ticket, and a request that was never admitted
  // owns nothing to give back.
  const byId = installDom();
  const slowPub = deferred();
  let saves = 0;
  installFetch((fn) => {
    if (fn === 'getEditableCatalog') return okJson({ source: SOURCE(), sourceUpdateTime: 'T', activeVersionId: 'v', usesPlatformFactura: false });
    if (fn === 'editCatalog') { saves += 1; return okJson({ token: `ET${saves}`, updateTime: 'T2', diff: CHANGED_DIFF }); }
    return slowPub.promise;
  });
  const app = await loadAppModule();
  await app.loadMenu('x_pizza');
  await byId.get('review').listeners.click[0]();

  const publishing = byId.get('pubbtn').listeners.click[0]();   // admitted; on the wire
  await Promise.resolve();
  await byId.get('pubbtn').listeners.click[0]();                // REFUSED as in-flight — owns nothing
  assert.strictEqual(saves, 1, 'premise: the duplicate sent nothing');

  document.dispatchEvent(new CustomEvent('portal:auth', { detail: { uid: 'B' } }));   // an ender
  await app.loadMenu('x_pizza');
  const savesBefore = saves;
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(saves, savesBefore,
    '🔴 no second write was admitted — the live publish still owns the wire, whatever the duplicate did');
  assert.ok('inert' in byId.get('drawer').attrs, '🔴 and the lock did not leak away with the refused press');

  slowPub.resolve(okJson({ versionId: 'v1' }));
  await publishing;
  await byId.get('review').listeners.click[0]();
  assert.strictEqual(saves, savesBefore + 1, 'and once the real request settles, admission returns');
});
