// Item S3 (D4c-grill/item-s1/S3-DESIGN.md) — the two order forms' item refusals, side by side with MOCKUP-item-s3-refusals.html
// (owner-approved 11-10): X. Pizza C1 (menu_changed) → C2 (after «Recargar la página»), D1 (extra_not_allowed) → D2 (after «Quitar
// extra y seguir»); La Musa E1 → E2, F1 → F2.
//   node review/forms-s3-sbs/shoot.mjs [--out <dir>] [--mock <D4c-grill dir>] [--only c1,d2,…]
// The REAL page (this tree's form, served from loopback by the forms' own CDP rig, platform/perf/cdp-fonts.mjs) in headless Chrome at the
// mockup frame's CSS size, DPR 2. Nothing leaves the machine: every https request is answered here or failed —
//   · getPublicMenu: the brand's menu from ONE real publish (item-s3-fixtures.mjs: the seed source → publishVersion → buildPublicMenu,
//     item_keys overlay ON); after a menu_changed refusal, the same body without the mockup's dropped dish (what a later publish serves);
//   · quoteOrder: the server's own stage + pricing over that version's tables (resolveLines → computeServerTotal);
//   · chargeOnlineOrder: the server's own refusal body ONCE (resolve-lines resolutionRefusal / extras-intake refusalBody + order_id, as
//     index.js sends them); any later send is HELD (a re-send would be a defect — the page is shot before any tap);
//   · RTDB: '{}' (nothing sold out); fonts.googleapis / the Firebase SDK / Maps: failed (the forms self-host their faces).
// The cart is the mockup's, added through the page's own handlers (chg / the detail extra toggles), Delivery, «Pagar en línea ahora» —
// the same calls the jsdom suite (item-s3-forms-ui.test.mjs send()) makes. The mockup's frames are clipped the same way as the capp's:
// the device lifted out of its strip. Its Google faces are not served (the mock page is offline), so it renders in its fallback stack —
// text metrics differ by construction (stated on the review page).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { launch, serveDir, router, sleep } from '../../platform/perf/cdp-fonts.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.join(HERE, '..', '..');
const require = createRequire(path.join(ROOT, 'xpizza-functions/x.js'));
const { computeServerTotal } = require('./menu-pricing');
const { resolveLines, resolutionRefusal } = require('./catalog/resolve-lines');
const EI = require('./catalog/extras-intake');
const { published } = await import(path.join(ROOT, 'item-s3-fixtures.mjs'));
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `forms-s3-sbs-${process.pid}`))), MOCK = path.resolve(arg('--mock', path.join(os.homedir(), 'Downloads/xpizza-D4c-grill')));
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);
fs.mkdirSync(path.join(OUT, 'img'), { recursive: true });
const plain = (x) => JSON.parse(JSON.stringify(x));
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

// the mockup's carts (its XPL / LML lines) and what each frame shows
const BRANDS = {
  x_pizza: { dir: 'xpizza-orders', lines: [['Carnivora', 'Pepperoni'], ['Margherita'], ['Potato & Dill Sausage']], gone: 'Potato & Dill Sausage', denied: ['Carnivora', 'Pepperoni'],
    frames: { menu: 'mk-c1', reloaded: 'mk-c2', extra: 'mk-d1', repaired: 'mk-d2' } },
  la_musa: { dir: 'la-musa-orders', lines: [['Sichuan Spicy Wonton'], ['Filete La Muse', 'Arroz Blanco'], ['Pork Belly Buns']], gone: 'Pork Belly Buns', denied: ['Filete La Muse', 'Arroz Blanco'],
    frames: { menu: 'mk-e1', reloaded: 'mk-e2', extra: 'mk-f1', repaired: 'mk-f2' } },
};
const SCENES = [];
for (const rid of Object.keys(BRANDS)) for (const kind of ['menu', 'reloaded', 'extra', 'repaired']) SCENES.push({ rid, kind, mk: BRANDS[rid].frames[kind] });
const want = SCENES.filter((s) => !ONLY.length || ONLY.includes(s.mk.slice(3)));

// ── the mockup frame: its CSS size + a DPR-2 shot of exactly that box ──
const MOCK_CLIP = (id) => `(() => { const f = document.getElementById(${JSON.stringify(id)}); if (!f) throw new Error('no frame ${id}');
  const d = f.querySelector('.device'), fr = f.querySelector('.device .frame'); if (!d || !fr) throw new Error('no device in ${id}');
  for (const e of [d, fr]) e.style.transition = 'none';
  Object.assign(d.style, { position: 'fixed', left: '0px', top: '0px', zIndex: '99999', maxWidth: 'none', borderRadius: '0', boxShadow: 'none', margin: '0' });
  fr.style.borderRadius = '0'; f.querySelectorAll('.sbar').forEach((e) => { e.style.display = 'none'; });
  const r = fr.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`;
async function shootMock(id) {
  const cdp = await launch({ width: 1600, height: 1200, dpr: 2 });
  try {
    await router(cdp, () => 'fail');   // offline: the mockup's Google faces are not served
    const srv = await serveDir(MOCK);
    await cdp.s('Page.navigate', { url: `${srv.base}/MOCKUP-item-s3-refusals.html` });
    for (let i = 0; i < 400 && !(await cdp.ev(`document.readyState === 'complete' && !!document.getElementById(${JSON.stringify(id)})`).catch(() => false)); i++) await sleep(25);
    await sleep(600);
    const box = await cdp.ev(MOCK_CLIP(id)); await sleep(300);
    const shot = await cdp.s('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 1 }, captureBeyondViewport: true });
    srv.close();
    return { box, png: Buffer.from(shot.data, 'base64') };
  } finally { cdp.close(); }
}

// ── the real page ──
async function shootReal(sc, box) {
  const B = BRANDS[sc.rid];
  const P = await quiet(() => published(sc.rid));
  const less = (() => { const e = plain(P.env); const d = e.menu.dishes.find((x) => x.name === B.gone); if (!d) throw new Error(`no ${B.gone} in ${sc.rid}`);
    e.menu.dishes = e.menu.dishes.filter((x) => x !== d); delete e.menu.item_keys[String(d.id)]; return e; })();
  const st = { refused: false, sends: 0, menu: P.env };
  const cdp = await launch({ width: Math.round(box.width), height: Math.round(box.height), dpr: 2 });
  try {
    const srv = await serveDir(ROOT);
    let refusal = null;
    await router(cdp, (url, req) => {
      if (/getPublicMenu/.test(url)) return { body: JSON.stringify(st.menu), headers: { etag: st.menu === P.env ? '"s3-base"' : '"s3-less"' } };
      if (/firebaseio\.com/.test(url)) return { body: '{}' };
      let body = {}; try { body = JSON.parse(req.postData || '{}'); } catch (_) {}
      if (/quoteOrder/.test(url)) { const b = plain(body); const r = resolveLines(sc.rid, b, P.tables); const t = r.ok ? computeServerTotal(b.items, sc.rid, P.tables) : null;
        return { body: JSON.stringify(!r.ok ? { ok: false, error: r.code } : t.error ? { ok: false } : { ok: true, total_cents: Math.round(t.total * 100), net_total_cents: Math.round(t.total * 100) }) }; }
      if (/chargeOnlineOrder|createOrder/.test(url)) {
        if (req.method === 'OPTIONS') return { body: '' };
        st.sends++; if (st.refused) return 'hold';
        st.refused = true; if (sc.kind === 'menu' || sc.kind === 'reloaded') st.menu = less;   // the publish that made the server refuse
        return { status: refusal.status, body: JSON.stringify({ ...refusal.body, order_id: body.order_id || 'X' }) };
      }
      return 'fail';
    });
    await cdp.s('Page.navigate', { url: `${srv.base}/${B.dir}/index.html` });
    for (let i = 0; i < 800 && !(await cdp.ev(`!!(window.liveMenuGlobalGet && Object.keys(liveMenuGlobalGet('ITEM_KEYS') || {}).length)`).catch(() => false)); i++) await sleep(25);
    if (!(await cdp.ev(`Object.keys(liveMenuGlobalGet('ITEM_KEYS') || {}).length`))) throw new Error(`${sc.mk}: the live menu (with its item_keys) never applied`);
    // the denied line, from the page's OWN identities (x_pizza names the extra, la_musa its id — extras-intake's two key modes)
    const den = await cdp.ev(`(() => { const d = MENU.find((x) => x.name === ${JSON.stringify(B.denied[0])}), e = liveMenuGlobalGet('EXTRAS').find((x) => x.name === ${JSON.stringify(B.denied[1])});
      return { item: liveMenuGlobalGet('ITEM_KEYS')[String(d.id)], extra: ${sc.rid === 'la_musa' ? 'e.id' : 'e.name'} }; })()`);
    const XR = { outcome: 'denied', denied: [den] }; const MC = resolutionRefusal({ code: 'menu_changed' });
    refusal = sc.kind === 'menu' || sc.kind === 'reloaded' ? { status: MC.status, body: MC.body } : { status: EI.refusalStatus(XR), body: EI.refusalBody(XR) };
    // the mockup's cart, through the page's own handlers
    await cdp.ev(`(() => { for (const [n, x] of ${JSON.stringify(B.lines)}) { const d = MENU.find((m) => m.name === n); if (!d) throw new Error('no dish ' + n); chg(d.id, 1);
        if (x) { const e = liveMenuGlobalGet('EXTRAS').find((m) => m.name === x); if (!e) throw new Error('no extra ' + x);
          if (typeof toggleDetailExtra === 'function' && ${sc.rid === 'x_pizza'}) toggleDetailExtra(e.id, d.id, 0); else chgDetailExtra(e.id, d.id, 1); } }
      document.getElementById('cname').value = 'Ana Martínez'; document.getElementById('cphone').value = '9'.repeat(phoneCountry().len); return true; })()`);
    // the send, as the suite's send(w, 'card'): «Pagar en línea ahora», the quote, the order, PixelPay → the server refuses
    await cdp.ev(`selectPay('online'); requestServerQuote(); true`); await sleep(500);
    await cdp.ev(`(() => { if (!buildOrder()) throw new Error('premise: buildOrder refused'); const p = processPixelPay(); if (p && p.catch) p.catch(() => {}); return true; })()`);
    for (let i = 0; i < 400 && !(await cdp.ev(`(() => { const g = document.getElementById('item-gate'); return !!g && g.style.display !== 'none' && !g.hidden; })()`).catch(() => false)); i++) await sleep(25);
    await sleep(400);
    if (sc.kind === 'reloaded' || sc.kind === 'repaired') {
      await cdp.ev(`document.querySelector('#item-gate .pickup-gate-btn.primary').click(), true`);
      if (sc.kind === 'reloaded') {   // the drop's toast (account.js toast(): 1.8 s on screen) — shot while it is up, as the mockup draws it
        for (let i = 0; i < 200 && !(await cdp.ev(`!!document.querySelector('.acct-toast.acct-show')`).catch(() => false)); i++) await sleep(25);
        st.toastShown = await cdp.ev(`!!document.querySelector('.acct-toast.acct-show')`);
      }
      for (let i = 0; i < 400 && !(await cdp.ev(`(() => { const g = document.getElementById('item-gate'); return !g || g.style.display === 'none' || g.hidden; })()`).catch(() => false)); i++) await sleep(25);
      await sleep(sc.kind === 'reloaded' ? 350 : 1200);   // the re-quote lands; the summary re-renders (C2/E2: inside the toast's own lifetime)
      // the frame as the mockup draws it (its data-scroll): the summary block in view
      await cdp.ev(`(() => { const t = ['s2-price-notice', 's2-summary'].map((i) => document.getElementById(i)).find((e) => e && !e.hidden && e.offsetHeight > 0);
        if (!t) throw new Error('no visible summary block'); t.scrollIntoView({ block: 'start' }); window.scrollBy(0, -12); return true; })()`);
    } else await cdp.ev('window.scrollTo(0, 0), true');
    await sleep(sc.kind === 'reloaded' ? 150 : 500);
    const shot = await cdp.s('Page.captureScreenshot', { format: 'png' });
    const facts = await cdp.ev(`({ gate: (document.getElementById('item-gate') || {}).innerText || null, toast: (document.querySelector('.acct-toast') || {}).innerText || null,
      notice: (document.getElementById('s2-price-notice') || {}).innerText || null, sends: 0,
      toastBox: (() => { const t = document.getElementById('acct-toast'); if (!t) return null; const c = getComputedStyle(t), r = t.getBoundingClientRect(); return [c.position, c.opacity, Math.round(r.top), Math.round(r.height)].join(' '); })() })`);
    srv.close();
    return { png: Buffer.from(shot.data, 'base64'), facts: { ...facts, sends: st.sends, ...(sc.kind === 'reloaded' ? { toastShown: st.toastShown, toastUpAtShot: await cdp.ev(`!!document.querySelector('.acct-toast.acct-show')`) } : {}) } };
  } finally { cdp.close(); }
}

const results = [];
for (const sc of want) {
  const m = await shootMock(sc.mk);
  const r = await shootReal(sc, m.box);
  const name = `${sc.mk}-${sc.rid}-${sc.kind}`;
  fs.writeFileSync(path.join(OUT, 'img', `${name}-mock.png`), m.png); fs.writeFileSync(path.join(OUT, 'img', `${name}-real.png`), r.png);
  results.push({ name, ...sc, box: m.box, facts: r.facts });
  console.log(`${name}: ${Math.round(m.box.width)}×${Math.round(m.box.height)} · sends ${r.facts.sends} · gate ${JSON.stringify(r.facts.gate)} · notice ${JSON.stringify(r.facts.notice)} · toast ${JSON.stringify(r.facts.toast)}`);
}
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
fs.writeFileSync(path.join(OUT, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Forms S3 SBS</title><style>body{font:14px system-ui;margin:16px}.row{display:flex;gap:12px;overflow-x:auto}img{max-width:min(420px,45vw);border:1px solid #ccc}</style>
<h1>Order forms · item S3 refusals · real | mockup</h1><p>The mockup renders offline (its Google faces fall back) — text metrics differ by construction.</p>
${results.map((x) => `<section><h2>${x.name}</h2><div class="row"><img src="img/${x.name}-real.png"><img src="img/${x.name}-mock.png"></div><pre>${JSON.stringify(x.facts)}</pre></section>`).join('\n')}`);
console.log(`\n${results.length} pairs · ${path.join(OUT, 'index.html')}`);
process.exit(0);
