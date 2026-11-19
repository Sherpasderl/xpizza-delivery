// The REAL-core worlds behind the portal font census's newer states (PLAN-portal-fonts-census-gaps-r0 §2–§4), checked WITHOUT Chrome: each
// state's backend (review/portal-cores/<cores>.mjs, the SBS backends moved in-repo) is reset to the state's scenario over THIS tree's harnesses,
// and the page's OWN calls (the query shapes xpizza-portal/api.js builds) answer 200 — where the state's premise string is server DATA, it is
// in the body. The census tool's STATES are read from its source, so a state added or re-pointed there without a world here goes red.
// Run: node --test review/portal-cores/portal-cores.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = readFileSync(path.join(ROOT, 'portal-fonts.cdp.mjs'), 'utf8');
// the census states that name a backend: { state: [cores, scn, text] } from the tool's own source
const CORE_STATES = Object.fromEntries([...SRC.matchAll(/^ {2}'([A-Z]+-[A-Za-z-]+)':\s*\{[^\n]*?cores: '([a-z0-9]+)', scn: '([a-z-]+)'[^\n]*?text: '([^']+)'/gm)].map((m) => [m[1], [m[2], m[3], m[4]]]));
// the page's calls per backend (api.js shapes) and whether the premise text is DATA the body must carry
const CALLS = {
  ventas: [['getMyBranches', {}], ['getSalesStats', { restaurantId: 'r_centro', from: '2026-10-30', to: '2026-11-12', granularity: 'day' }],
    ['getSalesStats', { restaurantId: 'r_centro', from: '2026-11-12', to: '2026-11-12', granularity: 'day', compare: 'previous_week' }]],
  calificaciones2: [['getMyBranches', {}], ['getMerchantReviews', { rids: 'x_pizza', weeks: '4' }], ['getMerchantReviews', { rids: 'x_pizza,xp_sur', weeks: '4' }],
    ['getMerchantRatingComments', { rid: 'x_pizza' }]],
  ofertas: [['getMyBranches', {}], ['getMarketing', { rid: 'pv_centro' }], ['getEditableCatalog', { restaurantId: 'pv_centro' }]],   // the 2×1 builder's dishes (marketing-builder.js:138)
  zones: [['getMyBranches', {}], ['getDeliveryPricing', {}]],
};
const DATA_TEXT = new Set(['Ana P.', 'Almuerzo: 15 % en todo el menú', 'Centro']);   // the rest are UI copy (headings, buttons)

test('the census tool names exactly the 13 core states of the plan (+ the 2×1 builder / review, owed 2), each on a backend this file can drive', () => {
  assert.deepEqual(Object.keys(CORE_STATES).sort(), ['C-calif', 'C-earlier', 'C-filters', 'IN-inicio', 'M-builder', 'M-builder-bogo', 'M-detail', 'M-ofertas', 'M-review', 'M-review-bogo', 'N-envio', 'V-detail', 'V-rend'],
    'the core states read from portal-fonts.cdp.mjs');
  for (const [s, [cores]] of Object.entries(CORE_STATES)) assert.ok(CALLS[cores], `${s}: backend ${cores} has its page calls here`);
});

const pairs = [...new Set(Object.values(CORE_STATES).map(([c, scn]) => `${c}|${scn}`))];
for (const pair of pairs) {
  const [cores, scn] = pair.split('|');
  test(`${cores}:${scn} — the REAL world answers every page call 200; the states' data premises are in the bodies`, async () => {
    const { backend } = await import(pathToFileURL(path.join(ROOT, 'review', 'portal-cores', `${cores}.mjs`)).href);
    const b = await backend(ROOT); await b.reset(scn);
    // a backend with a clock pins the page to it; zones has none BY DESIGN (absolute hours: the real clock judges them the same at any time)
    if (cores === 'zones') assert.equal(b.clock, undefined, 'zones: no clock (absolute hours)'); else assert.ok(Number.isFinite(b.clock), `${cores}: the backend states its clock (the page runs on it)`);
    const bodies = [];
    for (const [fn, query] of CALLS[cores]) {
      const r = await b.call({ fn, method: 'GET', query, headers: { authorization: 'Bearer T' } });
      assert.ok(r, `${fn}: served by the backend (never a gap)`);
      assert.equal(r.status, 200, `${fn} ${JSON.stringify(query)} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      bodies.push(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    }
    const all = bodies.join('\n');
    for (const [s, [c, sc, text]] of Object.entries(CORE_STATES)) if (c === cores && sc === scn && DATA_TEXT.has(text)) assert.ok(all.includes(text), `${s}: «${text}» is in the real answers`);
  });
}

// owed 2 (advisor 11-18): the 2×1 builder's dishes come from 5f's REAL getEditableCatalogCore over the catalog the REAL first-publish path
// (contract/third-brand publishThirdBrand: source doc → build → publishVersion + the RTDB mirror) wrote — ONE menu in both stores: the
// seeded «2 por 1» offer's dishes (saved by the real offers core, which checks them against that published menu) are dishes of the source
test('ofertas:populated — the 2×1 dishes: getEditableCatalog is the real core over the published source; the seeded 2×1 offer names its dishes', async () => {
  const { backend } = await import(pathToFileURL(path.join(ROOT, 'review', 'portal-cores', 'ofertas.mjs')).href);
  const b = await backend(ROOT); await b.reset('populated');
  const ask = (fn, query) => b.call({ fn, method: 'GET', query, headers: { authorization: 'Bearer T' } });
  for (const [rid] of [['pv_centro'], ['pv_proceres'], ['pv_trapiche']]) {
    const r = await ask('getEditableCatalog', { restaurantId: rid });
    assert.ok(r && r.status === 200, `${rid}: getEditableCatalog → ${r && r.status} ${JSON.stringify(r && r.body).slice(0, 200)}`);
    const items = (r.body.source && r.body.source.items) || [];
    assert.ok(items.length > 0 && items.every((i) => typeof i.key === 'string' && i.display && typeof i.display.name === 'string'), `${rid}: the source carries named dishes`);
    assert.equal(typeof r.body.activeVersionId, 'string', `${rid}: the core read the published version pointer`);
  }
  const src = (await ask('getEditableCatalog', { restaurantId: 'pv_centro' })).body.source;
  const keys = new Set(src.items.map((i) => i.key));
  const m = await ask('getMarketing', { rid: 'pv_centro' });
  const bogo = (m.body.offers || []).find((o) => o.type === 'bogo');
  assert.ok(bogo && Array.isArray(bogo.params.items) && bogo.params.items.length === 2, 'the seeded 2×1 offer carries its two dishes');
  for (const k of bogo.params.items) assert.ok(keys.has(k), `the 2×1 dish ${k} is a dish of the published source`);
});

// owed-2 slot STOP (advisor 11-18): a core state's drive can fail BECAUSE its own data function was not served (the 2×1 picker never
// lists dishes when getEditableCatalog 404s) — the recorded own-data 404 is then reported FIRST, with the drive's error kept as the cause;
// any other drive failure is passed through unchanged. No pre-check before the drive (it would move every state's timing).
test('a failed drive reports the recorded own-data 404 first; otherwise the drive error is passed through', async () => {
  const { driveFailure } = await import(pathToFileURL(path.join(ROOT, 'review', 'portal-cores', 'drive-failure.mjs')).href);
  const err = new Error('premise: .mk5b-row[data-row="prod"] .mk5b-opt never appeared');
  const e = driveFailure('M-builder-bogo', 'getEditableCatalog', ['getEditableCatalog'], err);
  assert.match(e.message, /^premise: M-builder-bogo: its own data function getEditableCatalog was not served \(404\) during the capture \(drive\)/, 'the own-data 404 is named first');
  assert.ok(e.message.includes(err.message), 'the drive failure is still in the message');
  assert.equal(e.cause, err, 'the drive error is kept as the cause');
  assert.equal(driveFailure('M-builder-bogo', 'getEditableCatalog', ['getMyBranches'], err), err, 'another function unserved: the drive error unchanged');
  assert.equal(driveFailure('M-builder-bogo', 'getEditableCatalog', [], err), err, 'nothing unserved: the drive error unchanged');
  assert.equal(driveFailure('P-drawer', null, ['getEditableCatalog'], err), err, 'a state with no own data function: the drive error unchanged');
});

test('the census tool routes every drive failure through driveFailure (own data function of a core state, the recorded unserved list)', () => {
  assert.match(SRC, /^import \{ driveFailure \} from '\.\/review\/portal-cores\/drive-failure\.mjs';$/m, 'the census tool imports driveFailure');
  assert.match(SRC, /try \{ await def\.drive\(cdp\); \} catch \(e\) \{ throw driveFailure\(stateName, def\.cores \? CORE_DATA\[stateName\]\.fn : null, st\.unserved, e\); \}/,
    'the drive runs inside the driveFailure catch');
  assert.equal((SRC.match(/def\.drive\(/g) || []).length, 1, 'there is ONE drive call site');
});

// owed-2 E STOP (advisor 11-18): every run() lives inside a failStateOnDeadline cell (each per-page cell block, and each state of the
// FF-same / FF-census loops), and run() labels its session with the state and the step before each phase, so a CDP deadline is a named
// state failure, never a process kill.
test('the census tool runs every state inside a deadline cell and labels each step', () => {
  assert.match(SRC, /^import \{[^}]*\bfailStateOnDeadline\b[^}]*\} from '\.\/platform\/perf\/cdp-fonts\.mjs';$/m, 'the census tool imports failStateOnDeadline');
  const lines = SRC.split('\n'), runs = lines.map((l, i) => [l, i]).filter(([l]) => /await run\(/.test(l));
  assert.ok(runs.length >= 12, `the run() call sites (${runs.length})`);
  for (const [l, i] of runs) {   // the nearest enclosing opener above it is a cell
    let j = i - 1, open = null; for (; j >= 0; j--) if (/^ {4,6}(if \(CELLS\.includes|for \(const stn of states\)|if \(byState\[)/.test(lines[j])) { open = lines[j]; break; }
    assert.ok(open && /await cell\(async \(\) => \{\s*(\/\/.*)?$/.test(open), `run() at line ${i + 1} is inside a deadline cell (opener: ${open})`);
  }
  for (const step of ['boot', 'drive', 'fonts', 'premise', 'census', 'probe', 'end', 'cleanup']) assert.ok(SRC.includes(`where('${step}')`), `run() labels the ${step} step`);
  assert.ok(/where\('drive'\);\s*try \{ await def\.drive\(cdp\);/.test(SRC), 'the drive step is labelled right before the drive');
});

// N-envio (advisor 11-18, option C): the map frame talks ONLY to the production portal origin (map.js posts to PORTAL_ORIGIN), so off
// it no 'ready' or 'failed' ever arrives and envio.js's own 8 s deadline flips the pane mid-census (77 → 74 nodes). The drive waits for
// that deadline's outcome — the real «No se pudo cargar el mapa.» line — so every run reads the same settled FAILURE pane, and the
// census record says so (notes), so nobody reads it as coverage of the ready pane.
test('N-envio waits for the map failure line (envio.js\'s own deadline) and the record notes it measures the failure pane', () => {
  const envio = readFileSync(path.join(ROOT, 'xpizza-portal', 'envio.js'), 'utf8');
  const mapFail = /mapFail: '([^']+)'/.exec(envio)[1];
  const line = SRC.split('\n').find((l) => l.startsWith("  'N-envio':"));
  assert.ok(line.includes(`waitHas('.envio .mapline:not(.hidden)', ${JSON.stringify(mapFail).replace(/"/g, "'")}, 12000)`), `N-envio waits for the map failure line «${mapFail}» (drive: ${line.slice(0, 260)})`);
  assert.match(line, /note: '[^']*FAILURE pane[^']*ready pane[^']*'/, 'N-envio carries its record note (the failure pane, not the ready pane)');
  assert.match(SRC, /notes: Object\.fromEntries\(Object\.keys\(byState\)\.filter\(\(n\) => STATES\[n\]\.note\)\.map\(\(n\) => \[n, STATES\[n\]\.note\]\)\)/, 'the record writes every state\'s note');
  assert.match(SRC, /const waitHas = \(sel, t, ms = 6000\) => /, 'the waitHas verb exists');
});

// Codex #159 P2: every census() in the portal tool opts into deadline propagation, so a deadline inside a census is the named state failure
test('the census tool opts every census() into { deadlines: true }', () => {
  const calls = SRC.match(/\bcensus\(cdp[^)]*\)/g) || [];
  assert.ok(calls.length >= 3, `the census() call sites (${calls.length})`);
  for (const c of calls) assert.equal(c, 'census(cdp, { deadlines: true })', `census() opts in: ${c}`);
});
