// The FUNCTIONAL re-shoot (advisor 11-14, one Chrome slot): every scene carries an in-page CHECK that throws on the defect it guards (a
// thrown step or a failed verify FAILS the run, like an unmapped request) — the pixel/layout diff and the review page come on top.
//   bundle A (signup,guestCardOnly,ratings,schedulingLive): D1 / D2 (+ Codex P2's rendered bounds) / D3 / D6, G-A / G-B / G-C, rule 10
//   bundle B (A + sdkPay):                                   D4 — the held sheet on MOUNT over a network-unknown SDK attempt
//   bundle N (the NATIVE target, A's flags):                 «wake» — the frames vs MOCKUP-capp-splash-animation A, the controller-absent
//                                                            ceiling (Codex P2) and the READY exit
// FX_PKG names each scene's bundle: run once per bundle with --only (the review notes which).
import { MEMBER_SEED, memberExtra, s2Extra, chainExtra } from './fixtures.mjs';
import { frame, v6, pairPhone, s7a } from './scenes.mjs';
import { toCheckout, click, GEO, NATIVE, place, homeReady, pinSet } from './scenes-s2.mjs';

const lightOnly = (m) => (theme) => (theme === 'light' ? m : null);
const both = (m) => () => m;
const member = (o = {}) => ({ seed: MEMBER_SEED(), fixtures: { ...(o.directory ? { directory: o.directory } : {}), extra: memberExtra(o) } });
const RAW = 'complete_writer_raw';   // what the pinned directory writer emits TODAY (no pricing marker) — rule 10: zero claims
const ALL = '.hsec[aria-label="Todos los restaurantes"]';
const openStore = (rid) => [homeReady, { run: `(document.querySelector('${ALL} .rcard[data-rid="${rid}"]') || document.querySelector('.rlist .rcard[data-rid="${rid}"]')).click()` },
  { until: 'document.querySelector(".sinfo, #top .info")', ms: 20000 }, { wait: 500 }];
const addTwo = [{ run: `(() => { const b = [...document.querySelectorAll('.icards .qty-add-btn, .content .row .qty-add-btn')].filter((x) => !x.disabled).slice(0, 2); b.forEach((x) => x.click()); if (b.length !== 2) throw new Error('premise: two dishes added'); })()` }, { wait: 400 }];
const tab = (t) => ({ run: `(() => { const b = [...document.querySelectorAll('[data-act="tab"][data-tab="${t}"]')].find((x) => x.getClientRects().length); if (!b) throw new Error('no visible ${t} tab'); b.click(); })()` });
const toOrders = [homeReady, tab('orders'), { until: 'document.querySelector(".orow")', ms: 20000 }, { wait: 500 }];
const toRate = [...toOrders, click('[data-act="rate-open"][data-oid="XPZ261102-RATE01"]'), { until: 'document.querySelector("[data-act=rate-star]")', ms: 10000 }, { wait: 500 }];
// the delivery pin + details, then the QUOTE priced (the Total carries an amount) — the CTA's other gates (a tender, a guest's code) are not this scene's
const pinQuoted = [...pinSet.filter((st) => !(st.until && st.until.includes('#cta'))), { until: '/Total\\s*L\\s*[1-9]/.test(document.querySelector(".flow").innerText)', ms: 15000 }, { wait: 400 }];
const cartSheet = [{ run: `document.getElementById('cart-bar').click()` }, { until: 'document.querySelector("#layer .ctot")', ms: 8000 }, { wait: 500 }];
// a check: an in-page expression that THROWS with the measured values when the property fails
const check = (name, body) => ({ run: `(() => { const fail = (m) => { throw new Error(${JSON.stringify(name + ': ')} + m); }; ${body} })()` });
// the rendered LINE count of an element's text: every text node's line boxes, merged when they overlap vertically (an icon, a dot or a
// bold run on the same line has its own box top — distinct tops are NOT distinct lines)
const lines = (el) => `((__e) => { const __b = []; const __w = document.createTreeWalker(__e, NodeFilter.SHOW_TEXT);
  for (let __t = __w.nextNode(); __t; __t = __w.nextNode()) { if (!__t.nodeValue.trim()) continue; const __r = document.createRange(); __r.selectNodeContents(__t); for (const __x of __r.getClientRects()) if (__x.width > 0 && __x.height > 0) __b.push([__x.top, __x.bottom]); }
  __b.sort((p, q) => p[0] - q[0]); let __n = 0, __end = -Infinity; for (const [__t0, __t1] of __b) { if (__t0 >= __end - 1) { __n++; __end = __t1; } else __end = Math.max(__end, __t1); } return __n; })(${el})`;
const CLAIM = '/Envío gratis|envío es gratis|Gratis/';

// ── D1 (16b): the DESK open card meta = f1a's one line «Abierto · Envío desde L 45»; the phone keeps v6's closing time ──
const D1 = check('D1', `const m = document.querySelector('${ALL} .rcard[data-rid="x_pizza"] .meta'); if (!m) fail('no card meta');
  const t = m.textContent.replace(/\\s+/g, ' ').trim(); if (t !== 'Abierto · Envío desde L 45') fail('text «' + t + '»'); const n = ${lines('m')}; if (n !== 1) fail(n + ' lines');`);
const D1P = check('D1 phone', `const m = document.querySelector('.rlist .rcard[data-rid="x_pizza"] .meta, ${ALL} .rcard[data-rid="x_pizza"] .meta'); if (!m) fail('no card meta'); if (!/cierra/.test(m.textContent)) fail('the phone lost its closing time: «' + m.textContent.trim() + '»');`);

// ── D2 (16b) + Codex P2: «Envío desde L 45» on ONE line, and the cells NEVER overflow the tools column (rendered bounds) ──
const D2 = check('D2', `const row = document.querySelector('.app.desk .sinfo .toolrow'), cells = row && row.querySelector('.cells'); if (!row || !cells) fail('no tools row / cells');
  const col = row.getBoundingClientRect(), c = cells.getBoundingClientRect();
  if (c.left < col.left - 0.5 || c.right > col.right + 0.5) fail('the cells box overflows the column: [' + Math.round(c.left) + ',' + Math.round(c.right) + '] vs [' + Math.round(col.left) + ',' + Math.round(col.right) + ']');
  for (const b of cells.querySelectorAll('b')) { const r = b.getBoundingClientRect(); const n = ${lines('b')}; if (n !== 1) fail('«' + b.textContent.trim() + '» breaks over ' + n + ' lines'); if (r.right > c.right + 0.5) fail('«' + b.textContent.trim() + '» overflows its box'); }
  const fee = [...cells.querySelectorAll('b')].map((b) => b.textContent.replace(/\\s+/g, ' ').trim()).find((x) => /Envío/.test(x)); if (fee !== 'Envío desde L 45') fail('the fee line «' + fee + '»');`);
const D2_PROBE = `(() => { const row = document.querySelector('.app.desk .sinfo .toolrow'), cells = row.querySelector('.cells'), tg = row.firstElementChild === cells ? null : row.firstElementChild;
  const R = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  return { column: R(row), toggle: R(tg), cells: R(cells), cellsBelowToggle: !!tg && cells.getBoundingClientRect().top >= tg.getBoundingClientRect().bottom - 1 }; })()`;

// ── D3 (16b/16c): the comment hint is a LABEL hint (no global .opt box above the textarea); the footer is not clipped ──
const D3 = check('D3', `const s = document.querySelector('.rate'); if (!s) fail('no rate sheet'); if (s.querySelector('.opt')) fail('a global .opt box in the rate sheet');
  const h = s.querySelector('label.lbl .opthint'), ta = document.getElementById('rate-comment'); if (!h || !ta) fail('no hint / textarea');
  if (h.getBoundingClientRect().bottom > ta.getBoundingClientRect().top + 0.5) fail('the hint is not above the field as a label line');
  const lbl = h.closest('label'); if (${lines('lbl')} !== 1) fail('the label + hint wrap');
  const sc = s.closest('.sheet') || s; sc.scrollTop = sc.scrollHeight; const last = s.lastElementChild, lr = last.getBoundingClientRect(), sr = sc.getBoundingClientRect();
  if (lr.bottom > Math.min(sr.bottom, innerHeight) + 0.5) fail('the footer is clipped: ' + Math.round(lr.bottom) + ' > ' + Math.round(Math.min(sr.bottom, innerHeight)));`);

// ── D6: a logo that FAILS to load is the initials plate (never the broken-image glyph + overflowing alt) ──
const D6 = (sel, ini) => check('D6', `const e = document.querySelector(${JSON.stringify(sel)}); if (!e) fail('no ${sel}'); if (e.querySelector('img')) fail('the failed image is still in ${sel}');
  if (!e.classList.contains('txt') || e.textContent.trim() !== ${JSON.stringify(ini)}) fail('${sel} is «' + e.textContent.trim() + '», not the ${ini} plate');
  const r = e.getBoundingClientRect(); if (e.scrollWidth > e.clientWidth + 1) fail('the plate text overflows');`);

// ── G-A (v6 feeRows): the phone cart sheet's Subtotal · Envío · Total ──
const GA = (priced) => check('G-A', `const t = document.querySelector('#layer .ctot'); if (!t) fail('no totals');
  const rows = [...t.querySelectorAll('.sumrow')].map((r) => [...r.children].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()));
  const lab = rows.map((r) => r[0]); if (lab[0] !== 'Subtotal' || !lab.includes('Total') || !lab.some((l) => /^Envío/.test(l))) fail('rows ' + JSON.stringify(rows));
  const env = rows.find((r) => /^Envío/.test(r[0])), tot = rows.find((r) => r[0] === 'Total'), sub = rows[0];
  ${priced ? `if (!/^L \\d/.test(env[1] || '')) fail('the priced Envío «' + env[1] + '»'); if (!/^L \\d/.test(tot[1] || '') || tot[1] === sub[1]) fail('the priced Total «' + tot[1] + '» (subtotal ' + sub[1] + ')');`
    : `if (!/según tu dirección/.test(env.join(' '))) fail('before an address: «' + env.join(' ') + '»'); if (tot[1] !== sub[1]) fail('before an address Total = the subtotal: ' + tot[1] + ' vs ' + sub[1]);`}
  for (const r of t.querySelectorAll('.sumrow')) if (${lines('r')} !== 1) fail('a crammed row «' + r.textContent.trim() + '»');`);

// ── G-B (frame 2a): the desk aside's notes row, right after the lines; the tap = the checkout with #f-notes open + focused ──
const GB = check('G-B', `const a = document.querySelector('.deskcart'), row = a && a.querySelector('[data-act="cartnotes"]'); if (!row) fail('no aside notes row');
  const t = row.innerText.replace(/\\s+/g, ' ').trim(); if (t !== 'Agregar notas al restaurante Sin cebolla, bien cocida…') fail('copy «' + t + '»');
  const k = [...a.children], at = k.indexOf(row), last = k.map((x, i) => (x.classList.contains('cline') && x !== row ? i : -1)).reduce((p, q) => Math.max(p, q), -1);
  if (at !== last + 1 || !k.slice(at + 1).some((x) => x.classList.contains('ctot'))) fail('not right after the lines, before the totals');`);
const GB_TAP = check('G-B tap', `const n = document.getElementById('f-notes'); if (!n) fail('the notes field is not open'); if (document.activeElement !== n) fail('the notes field is not focused (' + (document.activeElement && document.activeElement.id) + ')');`);

// ── G-C (f1a): the desk guest's filter row, and the computed fee chip filters to the stores at the floor ──
const chips = `[...document.querySelectorAll('.fchips .fchip')].filter((c) => c.getClientRects().length).map((c) => c.textContent.replace(/\\s+/g, ' ').trim())`;
const GC = check('G-C', `const l = ${chips}; if (JSON.stringify(l) !== JSON.stringify(['Abierto ahora', 'Pickup', 'Menos de 30 min', 'Envío desde L 45'])) fail(JSON.stringify(l));
  const row = document.querySelector('.fchips'); if (${lines('row')} !== 1) fail('the chip row wraps');`);
const GC_PRESS = check('G-C press', `const c = document.querySelector('.fchip[data-val="fee"]'); if (!c || c.getAttribute('aria-pressed') !== 'true') fail('the fee chip is not pressed');
  const ids = [...document.querySelectorAll('${ALL} .rcard')].map((x) => x.dataset.rid); if (!ids.length) fail('no store at the floor'); window.__gc = ids;`);
const GCP = check('G-C phone', `const l = ${chips}; if (JSON.stringify(l) !== JSON.stringify(['Abierto ahora', 'Pickup', 'Menos de 30 min'])) fail('the phone row ' + JSON.stringify(l));`);

// ── RULE 10: zero free-delivery claims anywhere the customer looks, with today's writer ──
const R10 = (where) => check('RULE 10', `const m = document.body.textContent.match(${CLAIM}); if (m) fail('a claim on ${where}: «' + m[0] + '»');`);

// ── D4 (owner 11-13 copy): another account's SDK hold on this phone, the answer UNKNOWN (network) ⇒ the sheet on MOUNT ──
const D4_REBIND = { run: `(() => { const k = Object.keys(localStorage).find((x) => /:pending_place$/.test(x)); if (!k) throw new Error('no placement record');
  const r = JSON.parse(localStorage.getItem(k)); if (r.sdk !== true || r.unresolved !== true) throw new Error('premise: an UNRESOLVED SDK record, got ' + JSON.stringify({ sdk: r.sdk, unresolved: r.unresolved, attempt_state: r.attempt_state }));
  r.owner = 'u_bea'; localStorage.setItem(k, JSON.stringify(r)); location.reload(); })()` };
const D4 = check('D4', `const h = document.querySelector('#layer .errsheet h2'); if (!h) fail('no sheet');
  if (h.textContent.trim() !== 'Hay un pago de otra cuenta pendiente en este teléfono') fail('title «' + h.textContent.trim() + '»');
  const p = h.parentElement.querySelector('p'); if (!p || p.textContent.trim() !== 'Entrá con esa cuenta para terminarlo o cancelarlo.') fail('body «' + (p && p.textContent.trim()) + '»');
  for (const e of [h, p]) if (e.scrollWidth > e.clientWidth + 1) fail('text overflow');`);

// ── «wake» (bundle N) ──
// the SAME computed frame on both pages: the needle angle, the ring's scale, the halo, the pivot, the mark's size + centring, the colours
const WAKE_PROBE = (root) => `(() => { const sp = ${root}; if (!sp) throw new Error('no overlay'); const m = sp.querySelector('svg.mark'), R = sp.getBoundingClientRect(), M = m.getBoundingClientRect();
  const mx = (el) => { const t = getComputedStyle(el).transform; if (!t || t === 'none') return [1, 0, 0, 1]; return t.match(/matrix\\(([^)]+)\\)/)[1].split(',').map(Number); };
  const ang = (el) => { const v = mx(el); return +(Math.atan2(v[1], v[0]) * 180 / Math.PI).toFixed(2); }, sc = (el) => { const v = mx(el); return +Math.hypot(v[0], v[1]).toFixed(4); };
  const op = (el) => +(+getComputedStyle(el).opacity).toFixed(3);
  // the ring PATH itself (its own computed animation / transform) and where it actually renders: its centre vs the mark's (a class
  // collision — the app's global spinner .ring — rotated it about the viewBox origin; the group's scale alone never showed it)
  const rp = sp.querySelector('.ring'), RB = rp.getBoundingClientRect();
  return { needle: ang(sp.querySelector('.needle')), ring: sc(sp.querySelector('.ringg')), ringPath: { anim: getComputedStyle(rp).animationName, rot: ang(rp), off: [Math.round(RB.left + RB.width / 2 - (M.left + M.width / 2)), Math.round(RB.top + RB.height / 2 - (M.top + M.height / 2))] }, halo: [op(sp.querySelector('.halo')), sc(sp.querySelector('.halo'))], pivot: op(sp.querySelector('.pivot')),
    mark: [Math.round(M.width), Math.round(M.height)], off: [Math.round(M.left + M.width / 2 - (R.left + R.width / 2)), Math.round(M.top + M.height / 2 - (R.top + R.height / 2))],
    bg: getComputedStyle(sp).backgroundColor, stroke: getComputedStyle(sp.querySelector('.ring')).stroke, north: getComputedStyle(sp.querySelector('.north')).fill }; })()`;
const seek = (root, t) => `${root}.getAnimations({ subtree: true }).forEach((a) => { a.pause(); a.currentTime = ${t}; })`;
const wakeMock = (t) => (theme) => ({ file: 'MOCKUP-capp-splash-animation.html', label: `wake A · ${theme} · t = ${t} ms`, vw: 1400, vh: 1100,
  // the page auto-plays at 300 ms (READY 1 400 ms): wait it out, then restart THIS phone's overlay in its frame-0 state and seek it to t
  run: `(async () => { await new Promise((r) => setTimeout(r, 2400)); const col = document.querySelector('.ph-col[data-id="${theme === 'dark' ? 'a-dark' : 'a-light'}"]'); if (!col) throw new Error('no phone');
    const sp = col.querySelector('.splash'); sp.classList.remove('play', 'exit', 'gone'); sp.style.opacity = ''; void sp.offsetWidth; sp.classList.add('play'); ${seek('sp', t)}; col.scrollIntoView(); })()`,
  clip: `(() => { const r = document.querySelector('.ph-col[data-id="${theme === 'dark' ? 'a-dark' : 'a-light'}"] .splash').getBoundingClientRect(); return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height }; })()`,
  probe: WAKE_PROBE(`document.querySelector('.ph-col[data-id="${theme === 'dark' ? 'a-dark' : 'a-light'}"] .splash')`) });
const near = (a, b, e) => Math.abs(a - b) <= e;
const wakeVerify = (row) => { const a = row.probe, b = row.mockProbe; if (!a || !b) throw new Error('wake: no probe pair');
  const bad = [];
  if (!near(a.needle, b.needle, 0.5)) bad.push(`needle ${a.needle}° vs ${b.needle}°`);
  if (!near(a.ring, b.ring, 0.002)) bad.push(`ring ${a.ring} vs ${b.ring}`);
  if (!near(a.halo[0], b.halo[0], 0.02) || !near(a.halo[1], b.halo[1], 0.005)) bad.push(`halo ${a.halo} vs ${b.halo}`);
  if (!near(a.pivot, b.pivot, 0.02)) bad.push(`pivot ${a.pivot} vs ${b.pivot}`);
  if (a.mark.join() !== b.mark.join()) bad.push(`mark ${a.mark} vs ${b.mark}`);
  if (!near(a.off[0], 0, 1) || !near(a.off[1], 0, 1)) bad.push(`the real mark is off-centre ${a.off}`);
  if (a.ringPath.anim !== b.ringPath.anim || !near(a.ringPath.rot, b.ringPath.rot, 0.5) || !near(a.ringPath.off[0], b.ringPath.off[0], 1) || !near(a.ringPath.off[1], b.ringPath.off[1], 1)) bad.push(`the ring path ${JSON.stringify(a.ringPath)} vs ${JSON.stringify(b.ringPath)}`);
  for (const k of ['bg', 'stroke', 'north']) if (a[k] !== b[k]) bad.push(`${k} ${a[k]} vs ${b[k]}`);
  if (bad.length) throw new Error('wake frame ≠ mockup A: ' + bad.join('; ')); };
const wakeFrame = (t) => ({ name: `wake-frame-t${t}`, pkg: 'N', width: 390, height: 844, block: ['/capp-splash.js'], themes: ['light', 'dark'], settle: 200,
  steps: [{ until: 'document.getElementById("csplash") && document.getElementById("csplash").getAnimations({ subtree: true }).length >= 5', ms: 8000 }, { run: seek('document.getElementById("csplash")', t) }, { wait: 100 }],
  probe: WAKE_PROBE('document.getElementById("csplash")'), mock: wakeMock(t), verify: wakeVerify,
  injections: 'NATIVE bundle · capp-splash.js BLOCKED (the CSS alone; every animation paused + seeked to t on BOTH pages)',
  note: `t = ${t} ms: the computed needle / ring / halo / pivot / mark / colours must equal the mockup's variant A at the same t` });
// Codex P2: with the controller ABSENT the overlay's own CSS ceiling hides it — visible at its start + 3.8 s, gone (opacity 0, hidden) at + 4.25 s
const WAKE_CAP = `(async () => { const el = document.getElementById('csplash'); if (!el) throw new Error('no overlay');
  const cap = el.getAnimations().find((a) => a.animationName === 'cs-cap'); if (!cap) throw new Error('no cs-cap ceiling animation'); await cap.ready; const t0 = cap.startTime;
  const at = (t) => new Promise((r) => { const f = () => (performance.now() >= t ? r() : requestAnimationFrame(f)); f(); });
  const read = () => { const cs = getComputedStyle(el); return { t: Math.round(performance.now()), opacity: +(+cs.opacity).toFixed(3), visibility: cs.visibility, pointer: cs.pointerEvents }; };
  const early = read(); await at(t0 + 3800); const before = read(); await at(t0 + 4250); const after = read();
  await new Promise((r) => setTimeout(r, 300));
  return { t0: Math.round(t0), early, before, after, controller: typeof window.CappSplash, home: !!document.querySelector('.hsec .rcard, .rlist .rcard') }; })()`;
const wakeCapVerify = (row) => { const p = row.probe, bad = [];
  if (p.controller !== 'undefined') bad.push('premise: the controller loaded (' + p.controller + ')');
  if (p.early.t > p.t0 + 3800) bad.push('the probe started late (' + p.early.t + ' ms)');
  if (p.before.opacity !== 1 || p.before.visibility !== 'visible') bad.push(`at +3.8 s not yet the full overlay: ${JSON.stringify(p.before)}`);
  if (p.after.opacity !== 0 || p.after.visibility !== 'hidden') bad.push(`at +4.25 s still showing: ${JSON.stringify(p.after)}`);
  if (p.after.t - p.t0 > 4600) bad.push('sampled too late to prove the ceiling (' + (p.after.t - p.t0) + ' ms)');
  if (p.early.pointer !== 'none') bad.push('the overlay takes pointer events');
  if (!p.home) bad.push('the app under it did not boot without the controller');
  if (bad.length) throw new Error('wake ceiling: ' + bad.join('; ')); };
// the normal exit: READY (the shell's first settled screen) ⇒ .exit at once ⇒ .gone after the 200 ms fade; well inside the 4 s cap
const WAKE_TIMES_PRE = `(() => { const T = window.__wake = { ready: null, exit: null, gone: null };
  new MutationObserver(() => { const r = document.documentElement; if (r && T.ready === null && r.getAttribute('data-capp-ready') === '1') T.ready = performance.now();
    const el = document.getElementById('csplash'); if (el) { if (T.exit === null && el.classList.contains('exit')) T.exit = performance.now(); if (T.gone === null && el.classList.contains('gone')) T.gone = performance.now(); } })
  .observe(document, { subtree: true, attributes: true, attributeFilter: ['data-capp-ready', 'class'] }); })()`;
const WAKE_TIMES = `(async () => { const t0 = performance.now(); while (!(window.__wake && window.__wake.gone !== null) && performance.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 50));
  const w = window.__wake || {}; const R = (v) => (v === null || v === undefined ? null : Math.round(v)); return { ready: R(w.ready), exit: R(w.exit), gone: R(w.gone), controller: typeof window.CappSplash }; })()`;
const wakeReadyVerify = (row) => { const p = row.probe, bad = [];
  if (p.controller !== 'object') bad.push('premise: the controller is loaded');
  if (p.ready === null) bad.push('no READY'); if (p.exit === null || p.gone === null) bad.push('the overlay never exited');
  if (p.ready !== null && p.exit !== null && (p.exit < p.ready || p.exit - p.ready > 60)) bad.push(`exit ${p.exit} not at READY ${p.ready}`);
  if (p.exit !== null && p.gone !== null && (p.gone - p.exit < 150 || p.gone - p.exit > 400)) bad.push(`fade ${p.gone - p.exit} ms (200 ms)`);
  if (p.gone !== null && p.gone >= 4000) bad.push(`gone at ${p.gone} ms — the cap, not READY`);
  if (bad.length) throw new Error('wake READY: ' + bad.join('; ')); };

export const FX_SCENES = [
  // ── D1 ──
  { name: 'D1-home-desk-1440', pkg: 'A', width: 1440, height: 900, steps: [homeReady, { wait: 400 }, D1], themes: ['light', 'dark'], mock: lightOnly(frame('f1a')) },
  { name: 'D1-home-phone-390', pkg: 'A', width: 390, height: 844, steps: [homeReady, { wait: 400 }, D1P], themes: ['light'], mock: both(v6('Inicio')) },
  // ── D2 + Codex P2: the rendered bounds at the widths that matter (1280 = the 420 px column the finding measured; 1440 = f2a; 1680 = wide) ──
  { name: 'D2-store-desk-1440', pkg: 'A', width: 1440, height: 900, steps: [...openStore('x_pizza'), ...addTwo, D2], probe: D2_PROBE, themes: ['light', 'dark'], mock: lightOnly(frame('f2a')) },
  { name: 'D2-store-desk-1280', pkg: 'A', width: 1280, height: 800, steps: [...openStore('x_pizza'), D2], probe: D2_PROBE, themes: ['light'], mock: null, note: 'Codex P2: the 420 px tools column — bounds checked, no mockup at 1280 unscrolled' },
  { name: 'D2-store-desk-1680', pkg: 'A', width: 1680, height: 1000, steps: [...openStore('x_pizza'), D2], probe: D2_PROBE, themes: ['light'], mock: null, note: 'bounds checked (wide)' },
  // ── D3 ──
  { name: 'D3-rate-phone-390', pkg: 'A', width: 390, height: 844, ...member(), steps: [...toRate, D3], themes: ['light', 'dark'], mock: lightOnly(pairPhone('r2', 1)) },
  // ── D6 (both logos 404) ──
  { name: 'D6-store-phone-390', pkg: 'A', width: 390, height: 844, fixtures: { failLogos: true }, steps: [...openStore('x_pizza'), { wait: 600 }, D6('.avatar', 'XP')], themes: ['light', 'dark'], mock: both(v6('X. Pizza · en la app')), note: 'the logo 404s: the initials plate' },
  { name: 'D6-home-desk-1440', pkg: 'A', width: 1440, height: 900, fixtures: { failLogos: true }, steps: [homeReady, { wait: 800 }, D6(`${ALL} .rcard[data-rid="la_musa"] .logo`, 'LM')], themes: ['light'], mock: lightOnly(frame('f1a')), note: 'the card chips 404: plates' },
  // ── G-A ──
  { name: 'GA-cart-noaddr-390', pkg: 'A', width: 390, height: 844, steps: [...openStore('x_pizza'), ...addTwo, ...cartSheet, GA(false)], themes: ['light', 'dark'], mock: s7a(13), note: 'before an address: «según tu dirección», Total = the subtotal' },
  { name: 'GA-cart-priced-390', pkg: 'A', width: 390, height: 844, geo: GEO,
    steps: [...openStore('x_pizza'), ...addTwo, { run: `document.getElementById('cart-bar').click()` }, { wait: 300 }, click('#layer [data-act="checkout"]'), { until: 'document.querySelector(".flow .col-a")', ms: 15000 }, { wait: 600 }, ...pinQuoted,
      { run: 'history.back()' }, { until: 'document.getElementById("cart-bar") && !document.querySelector(".flow .col-a")', ms: 10000 }, { wait: 600 }, ...cartSheet, { until: '/L \\d/.test((document.querySelector("#layer .ctot .sumrow.tot") || {}).textContent || "") && !/—/.test(document.querySelector("#layer .ctot").textContent)', ms: 10000 }, GA(true)],
    themes: ['light'], mock: s7a(13), injections: 'GEO', note: 'a guest with an address: the amounts from the checkout\'s quote (the pin + details; the quote priced — no tender needed)' },
  // ── G-B ──
  { name: 'GB-aside-desk-1440', pkg: 'A', width: 1440, height: 900, steps: [...openStore('x_pizza'), ...addTwo, GB], themes: ['light', 'dark'], mock: lightOnly(frame('f2a')) },
  { name: 'GB-tap-desk-1440', pkg: 'A', width: 1440, height: 900, steps: [...openStore('x_pizza'), ...addTwo, click('.deskcart [data-act="cartnotes"]'), { until: 'document.querySelector(".flow .col-a")', ms: 15000 }, { wait: 600 }, GB_TAP], themes: ['light'], mock: null, note: 'the tap: the checkout with «Notas» open and focused' },
  // ── G-C ──
  { name: 'GC-chips-desk-1440', pkg: 'A', width: 1440, height: 900, steps: [homeReady, { wait: 400 }, GC], themes: ['light', 'dark'], mock: lightOnly(frame('f1a')) },
  { name: 'GC-fee-pressed-desk-1440', pkg: 'A', width: 1440, height: 900, steps: [homeReady, { wait: 400 }, click('.fchip[data-val="fee"]'), { wait: 400 }, GC_PRESS], themes: ['light'], mock: null, note: 'the fee chip pressed: only the stores at the floor' },
  { name: 'GC-chips-phone-390', pkg: 'A', width: 390, height: 844, steps: [homeReady, { wait: 400 }, GCP], themes: ['light'], mock: both(v6('Inicio')) },
  // ── RULE 10: today's writer (no marker) ⇒ zero claims — guest and member, Inicio + store + the cart sheet ──
  { name: 'R10-home-desk-1440-guest', pkg: 'A', width: 1440, height: 900, fixtures: { directory: RAW }, steps: [homeReady, { wait: 500 }, R10('Inicio')], themes: ['light'], mock: lightOnly(frame('f1a')) },
  { name: 'R10-store-desk-1440-guest', pkg: 'A', width: 1440, height: 900, fixtures: { directory: RAW }, steps: [...openStore('x_pizza'), ...addTwo, R10('the store + aside')], themes: ['light'], mock: lightOnly(frame('f2a')) },
  { name: 'R10-home-phone-390-guest', pkg: 'A', width: 390, height: 844, fixtures: { directory: RAW }, steps: [homeReady, { wait: 500 }, R10('Inicio')], themes: ['light'], mock: both(v6('Inicio')) },
  { name: 'R10-store-phone-390-guest', pkg: 'A', width: 390, height: 844, fixtures: { directory: RAW }, steps: [...openStore('x_pizza'), ...addTwo, R10('the store'), ...cartSheet, R10('the cart sheet')], themes: ['light'], mock: s7a(13) },
  { name: 'R10-home-desk-1280-member', pkg: 'A', width: 1280, height: 800, ...member({ directory: RAW }), steps: [homeReady, { wait: 600 }, R10('Inicio')], themes: ['light'], mock: null },
  { name: 'R10-store-phone-390-member', pkg: 'A', width: 390, height: 844, ...member({ directory: RAW }), steps: [...openStore('x_pizza'), ...addTwo, R10('the store'), ...cartSheet, R10('the cart sheet')], themes: ['light'], mock: null },
  // ── D4 (bundle B): the held sheet on MOUNT — u_ana's SDK placement gets NO answer (network), the record is re-bound to u_bea, reload ──
  { name: 'D4-heldsheet-mount-390', pkg: 'B', width: 390, height: 844, seed: MEMBER_SEED(), native: true, geo: GEO, themes: ['light', 'dark'],
    fixtures: { extra: chainExtra(memberExtra(), s2Extra({ place: 'network' })) }, injections: [NATIVE, 'GEO', 'NETWORK (placeSdkOrder: the response lost)'].join(' + '),
    steps: [...toCheckout, ...place, { wait: 3500 }, D4_REBIND, { wait: 1500 }, homeReady,   // the reload lands on Inicio; opening the store MOUNTS its UI (capp-ui sdkResume): the live attempt is resolved first ⇒ held_other_account — no place tap
      { run: `document.querySelector('${ALL} .rcard[data-rid="la_musa"], .rlist .rcard[data-rid="la_musa"]').click()` },
      { until: 'document.querySelector("#layer .errsheet h2")', ms: 20000 }, { wait: 500 }, D4],
    mock: null, note: 'the mount path (opening the store mounts its UI, which resolves the live attempt): no place tap after the reload — «Hay un pago de otra cuenta pendiente en este teléfono»; text fit at 390' },
  // ── «wake» (bundle N) ──
  ...[0, 300, 600, 900, 1200].map(wakeFrame),
  { name: 'wake-controller-absent-390', pkg: 'N', width: 390, height: 844, block: ['/capp-splash.js'], themes: ['light'], settle: 0, steps: [{ until: 'document.getElementById("csplash")', ms: 4000 }],
    probe: WAKE_CAP, verify: wakeCapVerify, mock: null, injections: 'NATIVE bundle · capp-splash.js BLOCKED', note: 'Codex P2: the CSS ceiling alone — full at +3.8 s, hidden at +4.25 s, the app booted under it' },
  { name: 'wake-ready-390', pkg: 'N', width: 390, height: 844, preboot: WAKE_TIMES_PRE, themes: ['light', 'dark'], settle: 0, steps: [{ until: 'document.getElementById("csplash")', ms: 4000 }],
    probe: WAKE_TIMES, verify: wakeReadyVerify, mock: null, injections: 'NATIVE bundle', note: 'READY ⇒ the 200 ms fade ⇒ gone, well inside the 4 s cap' },
];
export const FX_PKG = Object.fromEntries(FX_SCENES.map((s) => [s.name, s.pkg]));
