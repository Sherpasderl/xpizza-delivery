// PLAN-public-menu-display T1 — a section's display NAME, end to end in the REAL editor (owner-approved mockup «Cambiar nombre
// de sección», 2026-10-25: R1–R6). Real headless Chrome over the shipped index.html + styles.css + modules, driven through the
// DevTools protocol (the dependency-free runner of xpizza-handheld/test-browser.mjs; CHROME_BIN overrides the binary). Only
// auth and the network are stubbed; the in-page mock RECORDS every editCatalog / publishEdited body, so the assertions are
// about what actually leaves the browser. No browser → the suite FAILS (never skips). Synthetic third brand: marca_s.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// the three modules that reach the Firebase CDN, replaced; every other file is the shipped one
const STUBS = {
  'firebase.js': 'export const auth = null;\n',
  'invite-mail.js': 'export const sendInviteLink = async () => {};\n',
  'auth.js': 'export const login = async () => {}; export const logout = async () => {}; export const authErrorMessage = () => "";\nexport const token = async () => "TK"; export const watchAuth = (cb) => { setTimeout(() => cb({ uid: "uCatName01", email: "dueno@marca-s.test" }), 20); };\n',
};

let server, chrome, ws, base, profile;
let id = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
function chromeBin() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  for (const d of (fs.existsSync(cache) ? fs.readdirSync(cache) : []).filter((x) => x.startsWith('chromium_headless_shell-')).sort().reverse()) {
    for (const sub of fs.readdirSync(path.join(cache, d))) { const p = path.join(cache, d, sub, 'chrome-headless-shell'); if (fs.existsSync(p)) return p; }
  }
  return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}
before(async () => {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    if (STUBS[rel] !== undefined) { res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }); res.end(STUBS[rel]); return; }
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const bin = chromeBin();
  assert.ok(fs.existsSync(bin), `🔴 no headless Chrome at ${bin} (set CHROME_BIN): the real-render checks cannot run`);
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-catname-'));
  chrome = spawn(bin, ['--headless=new', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((resolve) => { let buf = ''; chrome.stderr.on('data', (d) => { buf += d; const mm = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (mm) resolve(mm[1]); }); });
  ws = new WebSocket(wsUrl); await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('error', () => {});   // a socket error at teardown is not a test result
  ws.addEventListener('message', (e) => { const mm = JSON.parse(e.data); if (mm.id && pending.has(mm.id)) { const p = pending.get(mm.id); pending.delete(mm.id); if (mm.error) p.reject(new Error(mm.error.message)); else p.resolve(mm.result); } });
});
after(async () => {
  pending.clear();
  try { ws && ws.close(); } catch (_) { /* closing */ }
  if (chrome) { const gone = new Promise((r) => chrome.once('exit', r)); chrome.kill(); await gone; }   // the child this suite spawned, by its handle
  if (server) server.close();
  if (profile) fs.rmSync(profile, { recursive: true, force: true });
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function openPage(url, mock, width = 1280) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: mock }, sessionId);
  await send('Page.navigate', { url }, sessionId);
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  };
  const close = () => send('Target.closeTarget', { targetId });
  const reload = () => send('Page.reload', {}, sessionId);
  return { ev, close, reload };
}

const MENU_MOCK = (opts) => `(() => {
  const O = ${JSON.stringify(opts)};
  const CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'stats.read', 'availability.set', 'location.prep', 'location.pause', 'location.hours'];
  const E1 = { brands: [{ brand_id: 'marca_s', name: 'Marca S' }], branches: [{ rid: 'r_s', brand_id: 'marca_s', role: 'owner', state: 'member', caps: CAPS, name: 'Centro',
    identity_version: 2, editable: { prep_default_min: 20 }, readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' },
    control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null }] };
  const cat = (id, name) => (O.named ? { id, name } : { id });
  const LIVE0 = { restaurant_id: 'r_s', schema_version: 1, extras: [],
    items: [{ key: 'k_uno', price: 100, display: { id: 'k_uno', cat: 'uno', name: 'Plato Uno', price: 100 } }, { key: 'k_dos', price: 200, display: { id: 'k_dos', cat: 'dos', name: 'Plato Dos', price: 200 } }],
    structure: { schema_version: 2, item_order: ['k_uno', 'k_dos'], categories: [cat('uno', 'Primera'), cat('dos', 'Segunda')] } };
  // the store survives a RELOAD (sessionStorage): the published menu and the saved draft, as the server holds them
  const S = JSON.parse(sessionStorage.getItem('catname-mock') || 'null') || { live: LIVE0, saved: null, sent: { editCatalog: [], publishEdited: [], catalogRequestPublish: [] } };
  const keep = () => sessionStorage.setItem('catname-mock', JSON.stringify(S));
  Object.defineProperty(window, '__sent', { get: () => S.sent });
  const nm = (c) => (c && c.name !== undefined ? c.name : null);
  const pending = (src) => {   // the server's pendingRenames / pendingOther for a saved draft vs the published menu
    const renames = src.structure.categories.map((c, i) => ({ id: c.id, from: nm(S.live.structure.categories[i]), to: nm(c) })).filter((r) => r.from !== r.to);
    const other = src.items.some((it) => { const l = S.live.items.find((x) => x.key === it.key); return !l || l.price !== it.price; });
    return { ...(renames.length ? { pendingRenames: renames } : {}), ...(other ? { pendingOther: true } : {}) };
  };
  const json = (b, st) => Promise.resolve(new Response(JSON.stringify(b), { status: st || 200, headers: { 'Content-Type': 'application/json' } }));
  window.fetch = (url, init) => {
    const u = new URL(String(url), location.href), fn = u.pathname.split('/').pop();
    const body = init && init.body ? JSON.parse(init.body) : {};
    if (fn === 'getMyBranches') return json(E1);
    if (fn === 'getEditableCatalog') { const src = S.saved || S.live;
      return json({ source: JSON.parse(JSON.stringify(src)), sourceUpdateTime: 'T1', activeVersionId: 'v1', usesPlatformFactura: O.fiscal === true, renderedCategories: ['uno', 'dos'],
        publish_via_request: O.via === true, ...(S.saved ? pending(S.saved) : {}) }); }
    if (fn === 'getBranchAvailability') return json({ branches: [] });
    if (fn === 'editCatalog') {
      S.sent.editCatalog.push(body); keep();
      if (O.refuse) return json({ error: 'rename_not_alone', field: 'categories' }, 400);
      const changed = [];
      for (const lc of S.live.structure.categories) { const dc = body.source.structure.categories.find((c) => c.id === lc.id); const o = nm(lc), n = nm(dc); if (o !== n) changed.push({ key: lc.id, surface: 'category', field: 'name', old: o, new: n }); }
      for (const it of body.source.items) { const l = S.live.items.find((x) => x.key === it.key); if (l && l.price !== it.price) changed.push({ key: it.key, surface: 'item', field: 'price', old: l.price, new: it.price }); }
      S.saved = body.source; keep();
      return json({ source: body.source, diff: { changed, added: [], removed: [], renamed: [], largeChangeSet: [] }, token: 'tok', updateTime: 'T2' });
    }
    if (fn === 'catalogRequestPublish') { S.sent.catalogRequestPublish.push(body); keep(); return json({ ok: true }); }
    if (fn === 'publishEdited') { S.sent.publishEdited.push(body); S.live = JSON.parse(JSON.stringify(S.saved)); S.saved = null; keep(); return json({ ok: true, versionId: 'v2' }); }
    return json({ error: 'not_found' }, 404);
  };
})();`;
async function openMenu(opts, width = 1280) {
  const p = await openPage(`${base}/index.html?fresh=${Math.random().toString(36).slice(2)}`, `if (!sessionStorage.getItem('catname-page')) { sessionStorage.removeItem('catname-mock'); sessionStorage.setItem('catname-page', '1'); }
${MENU_MOCK(opts)}`, width);
  for (let i = 0; i < 80 && !(await p.ev("!!document.querySelector('#rail .railitem') && !document.getElementById('app').classList.contains('hidden')")); i++) await wait(100);
  await wait(300);
  return p;
}
const $q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const typeIn = (sel, v) => `(() => { const i = ${$q(sel)}; i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`;
const clickOn = (sel) => `${$q(sel)}.click()`;
const txt = (sel) => `(${$q(sel)} || {}).textContent || null`;

test('REAL Chrome: rename one section — the price hold (R3), the inline edit (R2), the name hold (R3b), review (R5a), receipt (R6)', async () => {
  const p = await openMenu({ named: true });
  try {
    assert.equal(await p.ev(`${$q('#detail .secren')}.disabled`), false, 'R1: «Cambiar nombre» beside the title');
    // R3 — a typed price turns the rename control off at once, with its reason; undoing it turns it back on
    await p.ev(typeIn('#detail .price input', '150'));
    assert.equal(await p.ev(`${$q('#detail .secren')}.disabled`), true, '🔴 a rename cannot join a price change');
    assert.match(await p.ev(txt('#detail > .secnote')), /Hay cambios de precio sin publicar\. Un cambio de nombre se publica solo/);
    await p.ev(typeIn('#detail .price input', '100'));
    assert.equal(await p.ev(`${$q('#detail .secren')}.disabled`), false, 'and back on once nothing is pending');
    assert.equal(await p.ev(`!!${$q('#detail > .secnote')}`), false);
    // R2 — the inline edit: empty refuses with «Escribí un nombre»
    await p.ev(clickOn('#detail .secren')); await wait(150);
    assert.equal(await p.ev(`${$q('.secin')}.value`), 'Primera');
    await p.ev(typeIn('.secin', '   '));
    assert.equal(await p.ev(`${$q('.secact .btn.accent')}.disabled`), true);
    assert.equal(await p.ev(txt('.secerr')), 'Escribí un nombre');
    await p.ev(typeIn('.secin', 'Primera de la casa'));
    assert.equal(await p.ev(txt('.seccnt')), '18/40');
    await p.ev(clickOn('.secact .btn.accent')); await wait(150);
    // R3b — the name holds prices and «Agregar producto»; the bar says what is pending
    assert.equal(await p.ev(txt('#rail .railitem.on b')), 'Primera de la casa');
    assert.equal(await p.ev(`[...document.querySelectorAll('#detail .price input')].every((i) => i.disabled)`), true, '🔴 prices off while a name waits');
    assert.equal(await p.ev(`${$q('#detail .dright .btn')}.disabled`), true, '«Agregar producto» off');
    assert.match(await p.ev(txt('#detail > .secnote')), /Hay un cambio de nombre esperando publicarse/);
    assert.equal(await p.ev(txt('#rbtxt')), '1 cambio sin publicar · nombre de sección');
    // R5a — what leaves the browser: the name, and nothing else
    await p.ev(clickOn('#review')); await wait(400);
    const sent = await p.ev('window.__sent.editCatalog[0]');
    assert.deepEqual(sent.source.structure.categories, [{ id: 'uno', name: 'Primera de la casa' }, { id: 'dos', name: 'Segunda' }]);
    assert.deepEqual(sent.source.items.map((i) => i.price), [100, 200], 'no price rode along');
    assert.match(await p.ev(txt('#mbody .mgroup')), /Secciones/);
    assert.equal(await p.ev(`${$q('#pubbtn')}.disabled`), false, 'no fiscal flag: nothing to sign');
    // R6
    await p.ev(clickOn('#pubbtn')); await wait(600);
    assert.equal(await p.ev('window.__sent.publishEdited.length'), 1);
    assert.match(await p.ev(txt('#mbody .receipt')), /«Primera» ahora se llama «Primera de la casa»\. El menú publicado ya lleva el nuevo nombre\./);
  } finally { await p.close(); }
});

test('REAL Chrome: no section named yet (R1c) → name them ALL at once (R2b) → the fiscal seal (R5b) needs «Autorizo»', async () => {
  const p = await openMenu({ named: false, fiscal: true });
  try {
    assert.equal(await p.ev(`${$q('#seccall')}.classList.contains('hidden')`), false, 'R1c: the callout');
    assert.equal(await p.ev(`!!${$q('#detail .secren')}`), false, 'no per-section control: one name alone would be refused');
    assert.equal(await p.ev(txt('#rail .railitem.on b')), 'uno', 'the rail shows the id');
    await p.ev(clickOn('#seccall .btn')); await wait(150);
    assert.equal(await p.ev(`${$q('#namescrim')}.classList.contains('show')`), true);
    await p.ev(typeIn('#namemodal .secnm:nth-of-type(1) input', 'Primera'));
    assert.equal(await p.ev(`${$q('#namemodal .btn.accent')}.disabled`), true, '🔴 all-or-nothing: one name of two cannot be saved');
    assert.equal(await p.ev(txt('#namemodal .secmfnote')), 'Falta 1 nombre');
    await p.ev(typeIn('#namemodal .secnm:nth-of-type(2) input', 'Segunda'));
    await p.ev(clickOn('#namemodal .btn.accent')); await wait(200);
    assert.equal(await p.ev(`${$q('#seccall')}.classList.contains('hidden')`), true);
    assert.equal(await p.ev(txt('#rbtxt')), '2 cambios sin publicar · nombres de sección');
    await p.ev(clickOn('#review')); await wait(400);
    assert.deepEqual((await p.ev('window.__sent.editCatalog[0]')).source.structure.categories, [{ id: 'uno', name: 'Primera' }, { id: 'dos', name: 'Segunda' }]);
    assert.match(await p.ev(txt('#mbody .seal')), /Esta publicación requiere tu autorización como propietario/);
    assert.equal(await p.ev(`${$q('#pubbtn')}.disabled`), true, '🔴 the fiscal brand signs for a rename too');
    await p.ev(`(() => { const c = ${$q('#mbody .seal input[type=checkbox]')}; c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    assert.equal(await p.ev(`${$q('#pubbtn')}.disabled`), false);
    await p.ev(clickOn('#pubbtn')); await wait(600);
    assert.equal((await p.ev('window.__sent.publishEdited[0]')).fiscalAck, true);
    assert.match(await p.ev(txt('#mbody .receipt')), /Tus secciones ya tienen nombre: Primera y Segunda\./);
  } finally { await p.close(); }
});

test('REAL Chrome: the server refuses rename_not_alone on save → the approved panel (R4), not the generic one', async () => {
  const p = await openMenu({ named: true, refuse: true });
  try {
    await p.ev(clickOn('#detail .secren')); await wait(150);
    await p.ev(typeIn('.secin', 'Otra'));
    await p.ev(clickOn('.secact .btn.accent')); await wait(150);
    await p.ev(clickOn('#review')); await wait(400);
    assert.equal(await p.ev(txt('#mbody .conflict h3')), 'Un cambio de nombre se publica solo');
    assert.match(await p.ev(txt('#mbody .conflict p')), /Volvé al menú publicado, cambiá solo el nombre y publicalo; el resto hacelo después\./);
    assert.equal(await p.ev(txt('#mbody .conflict .btn')), 'Volver al menú publicado');
  } finally { await p.close(); }
});

test('REAL Chrome + styles.css: on a phone the review row wraps — the name keeps the row, the value drops under it', async () => {
  const p = await openMenu({ named: true }, 390);
  try {
    await p.ev(clickOn('#detail .secren')); await wait(150);
    await p.ev(typeIn('.secin', 'Primera B'));   // a SHORT name: without the rule it would squeeze onto one line
    await p.ev(clickOn('.secact .btn.accent')); await wait(150);
    await p.ev(clickOn('#review')); await wait(400);
    const geo = await p.ev(`(() => { const m = ${$q('#mbody .prow .pmain')}, v = ${$q('#mbody .prow .pval')}; const a = m.getBoundingClientRect(), b = v.getBoundingClientRect(); return { mw: a.width, rowW: m.parentElement.getBoundingClientRect().width, below: b.top >= a.bottom - 1 }; })()`);
    assert.ok(geo.below, '🔴 the value sits under the name on a phone');
    assert.ok(geo.mw > geo.rowW * 0.8, 'the name takes the row');
  } finally { await p.close(); }
});

// ── Codex r1 — the lifecycle: the exclusion holds against the PUBLISHED menu, and a pending name is never lost ─────────────
const ready = async (p) => { for (let i = 0; i < 80 && !(await p.ev("!!document.querySelector('#rail .railitem') && !document.getElementById('app').classList.contains('hidden')")); i++) await wait(100); await wait(300); };
const enterRename = async (p, v) => {
  await p.ev(clickOn('#detail .secren')); await wait(150);
  await p.ev(typeIn('.secin', v));
  await p.ev(`${$q('.secin')}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`); await wait(200);
};
// a price write that IGNORES the disabled state (a programmatic dispatch reaches a disabled input's listeners)
const forcePrice = (sel, v) => `(() => { const i = ${$q(sel)}; if (!i) return 'none'; i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input', { bubbles: true })); return i.disabled; })()`;
const lastBody = (fn) => `window.__sent.${fn}[window.__sent.${fn}.length - 1]`;

test('REAL Chrome (Codex r1 #2): a drawer open BEFORE an Enter-rename cannot carry a price into the same save', async () => {
  const p = await openMenu({ named: true });
  try {
    await p.ev(clickOn('#detail .rowchev')); await wait(200);
    assert.equal(await p.ev(`${$q('#drawer')}.classList.contains('show')`), true, 'non-vacuity: the drawer is open');
    await enterRename(p, 'Primera de la casa');
    assert.equal(await p.ev(`[...document.querySelectorAll('#drawer input')].every((i) => i.disabled)`), true, 'the open drawer locks');
    await p.ev(forcePrice('#drawer .fld.pr input', '777'));   // the state boundary refuses it even when dispatched
    await p.ev(clickOn('#review')); await wait(400);
    const b = await p.ev(lastBody('editCatalog'));
    assert.deepEqual(b.source.structure.categories.map((c) => c.name), ['Primera de la casa', 'Segunda']);
    assert.deepEqual(b.source.items.map((i) => i.price), [100, 200], '🔴 the outgoing body never mixes a price with a rename');
  } finally { await p.close(); }
});

test('REAL Chrome (Codex r1 #3): «Enviar al dueño» with a rename keeps prices locked — the name is still unpublished', async () => {
  const p = await openMenu({ named: true, via: true });
  try {
    await enterRename(p, 'Primera de la casa');
    await p.ev(clickOn('#review')); await wait(500);   // the manager's CTA: save + send to the owner
    assert.equal(await p.ev('window.__sent.catalogRequestPublish.length'), 1, 'non-vacuity: it was sent');
    assert.equal(await p.ev(`[...document.querySelectorAll('#detail .price input')].every((i) => i.disabled)`), true, '🔴 still locked after the send');
    assert.match(await p.ev(txt('#detail > .secnote')), /Hay un cambio de nombre esperando publicarse/);
    await p.ev(forcePrice('#detail .price input', '150'));
    await p.ev(clickOn('#review')); await wait(500);
    for (const b of await p.ev('window.__sent.editCatalog')) assert.deepEqual(b.source.items.map((i) => i.price), [100, 200], '🔴 no later save carries a price');
  } finally { await p.close(); }
});

test('REAL Chrome (Codex r1 #1): an unsaved rename blocks leaving — the branch switch / self-update guard counts it', async () => {
  const p = await openMenu({ named: true });
  try {
    assert.equal(await p.ev("import('/app.js').then((m) => m.editorCanLeave())"), true, 'non-vacuity: nothing pending → may leave');
    await enterRename(p, 'Primera de la casa');
    await p.ev('document.activeElement && document.activeElement.blur()');
    assert.equal(await p.ev("import('/app.js').then((m) => m.editorCanLeave())"), false, '🔴 a pending rename is never silently dropped by a switch or a reload');
    await p.ev(clickOn('#discard')); await wait(200);
    assert.equal(await p.ev("import('/app.js').then((m) => m.editorCanLeave())"), true, 'discarded → may leave');
  } finally { await p.close(); }
});

test('REAL Chrome (Codex r1 #3): after a RELOAD the saved-but-unpublished side still holds the other — names hold prices, a price holds names', async () => {
  const p = await openMenu({ named: true });
  try {
    // a saved, unpublished RENAME (review opened = saved; closed without publishing), then reload
    await enterRename(p, 'Primera de la casa');
    await p.ev(clickOn('#review')); await wait(400);
    await p.ev(clickOn('#pubback')); await wait(200);
    await p.reload(); await ready(p);
    assert.equal(await p.ev(txt('#rail .railitem.on b')), 'Primera de la casa', 'the saved name came back');
    assert.equal(await p.ev(`[...document.querySelectorAll('#detail .price input')].every((i) => i.disabled)`), true, '🔴 prices locked from server truth');
    assert.match(await p.ev(txt('#detail > .secnote')), /Hay un cambio de nombre esperando publicarse/);
    await p.ev(forcePrice('#detail .price input', '150'));
    await p.ev(clickOn('#review')); await wait(400);
    assert.deepEqual((await p.ev(lastBody('editCatalog'))).source.items.map((i) => i.price), [100, 200], '🔴 no price rides on the reloaded rename');
    await p.ev(clickOn('#pubbtn')); await wait(700);
    // published → a saved, unpublished PRICE, then reload: the rename control is off
    await p.ev(clickOn('#pubback')); await wait(200);
    await p.reload(); await ready(p);
    await p.ev(typeIn('#detail .price input', '150'));
    await p.ev(clickOn('#review')); await wait(400);
    await p.ev(clickOn('#pubback')); await wait(200);
    await p.reload(); await ready(p);
    assert.equal(await p.ev(`${$q('#detail .secren')}.disabled`), true, '🔴 a saved price holds the rename after a reload');
    assert.match(await p.ev(txt('#detail > .secnote')), /Hay cambios de precio sin publicar/);
  } finally { await p.close(); }
});

