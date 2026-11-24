// The «Editar producto» drawer under a REAL DOM — the shared harness (moved verbatim from item-edit-drawer.test.mjs; used by it and by
// structure-s3-ui.test.mjs): jsdom over the shipped index.html with the REAL app.js, ventas.js and shell.js (auth stubbed), the REAL
// la_musa seed, getEditableCatalog in the contract's exact shape, and the page's classic scripts run as the browser runs them — ALL FOUR,
// in index.html order (the extras rule, then the three writers' byte copies).
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { DIR, installFetch, okJson, errJson } from './ventas-harness.mjs';

const req = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'));
const { JSDOM } = req('jsdom');
const { buildSourceFromCode } = req('./tools/seed-source-store');
const { rendererContract } = req('./catalog/source-store');
// the page's classic script: the PORTAL'S OWN copy (tools/sync-client.js), run as the browser runs it — it defines ExtrasEligibility
runInThisContext(readFileSync(join(DIR, 'extras-eligibility.js'), 'utf8'));   // once per process, as once per page load
runInThisContext(readFileSync(join(DIR, 'exposure-transitions.js'), 'utf8'));   // STRUCTURE S2: the writer, the page's next classic script (index.html order)
runInThisContext(readFileSync(join(DIR, 'choice-transitions.js'), 'utf8'));   // STRUCTURE S3: the required-choice writer (index.html order)
runInThisContext(readFileSync(join(DIR, 'section-transitions.js'), 'utf8'));   // STRUCTURE S4: the section rules (index.html order)
const EE = globalThis.ExtrasEligibility;
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const RID = 'la_musa';
const SRC = buildSourceFromCode(RID);
const OWNER_CAPS = ['catalog.read_editor', 'catalog.edit', 'catalog.publish', 'catalog.fiscal_ack', 'catalog.add_product', 'catalog.reset_draft', 'stats.read',
  'availability.set', 'location.prep', 'location.pause', 'location.hours', 'team.invite', 'team.revoke'];
const E1 = () => ({ brands: [{ brand_id: RID, name: 'La Musa' }], membership_writes_enabled: false,
  branches: [{ rid: RID, brand_id: RID, role: 'owner', state: 'member', caps: OWNER_CAPS, name: 'Centro', identity_version: 2, editable: { prep_default_min: 20 },
    readonly: { active: true, radius_km: 4, hours: null, phone: '+50400000000' }, control: { state: 'open', paused_until: null, pause_reason: null, pause_since: null }, devices: 0, last_order_today: null }] });
// the S2 §1.1 read: today's body + textEditEnabled (always present) + reservedNames / pendingTexts when served
// 5f getEditableCatalog rewardGroups (catalog/portal-reads): STATED whenever the reward-group guard is on (choice-compare
// rewardGroupGuardOn on the Extras switch), its value the REAL derivation (choice-compare rewardGroupsOf) over the menu the read serves as
// published — never a literal, so this read is never laxer than the server's (rule 29). A cell may pass rewardGroups: undefined = an
// OLDER server that does not state it.
const servedRewardGroups = (src) => new Set(req('./catalog/choice-compare').rewardGroupsOf({ extras: src.extras, structure: src.structure }));
const editable = (over = {}) => {
  const r = { source: JSON.parse(JSON.stringify(SRC)), sourceUpdateTime: '1700000000.000000001', activeVersionId: 'v-live', usesPlatformFactura: false,
    renderedCategories: [...rendererContract(RID).renderedCategories], restaurantName: 'La Musa', publish_via_request: false, groupAuthoring: false, choiceBadges: [],
    textEditEnabled: true, reservedNames: [], ...over };
  if (!('rewardGroups' in over) && req('./catalog/choice-compare').rewardGroupGuardOn(r.extrasCatalog === true)) r.rewardGroups = [...servedRewardGroups(r.source)];
  return r;
};
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function loadAll() {
  const tag = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const auth = join(DIR, `__ied-auth-stub.${tag}.mjs`);
  writeFileSync(auth, 'export const token = async () => "TK-ied";\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n');
  const tmp = (n) => join(DIR, `__ied-under-test.${n}.${tag}.mjs`);
  const url = (n) => `./__ied-under-test.${n}.${tag}.mjs`;
  const files = [auth]; const mods = {};
  try {
    for (const name of ['app', 'ventas', 'shell']) {
      const src = readFileSync(join(DIR, `${name}.js`), 'utf8')
        .replace(/from '\.\/auth\.js'/g, `from './__ied-auth-stub.${tag}.mjs'`)
        .replace(/from '\.\/app\.js'/g, `from '${url('app')}'`)
        .replace(/from '\.\/shell\.js'/g, `from '${url('shell')}'`);
      writeFileSync(tmp(name), src); files.push(tmp(name));
      mods[name] = await import(pathToFileURL(tmp(name)).href);
    }
    return mods;
  } finally { for (const f of files) { try { unlinkSync(f); } catch (_) { /* best effort */ } } }
}

async function page({ read = () => editable(), evaluator = true, on = {} } = {}) {
  const dom = new JSDOM(HTML, { url: 'https://portal.test/', pretendToBeVisual: true });
  const w = dom.window;
  w.scrollTo = () => {};
  for (const k of ['window', 'document', 'CustomEvent', 'Event', 'HTMLElement', 'Node', 'MutationObserver', 'sessionStorage', 'localStorage']) {
    Object.defineProperty(globalThis, k, { value: k === 'window' ? w : w[k], configurable: true, writable: true });
  }
  if (evaluator) globalThis.ExtrasEligibility = EE; else delete globalThis.ExtrasEligibility;
  globalThis.__branchesDirect = true;
  globalThis.CSS = { escape: (x) => String(x).replace(/["\\]/g, '\\$&') };   // jsdom has no CSS.escape (Codex S4P2 r1: uncaught «CSS is not defined»)
  const st = { read };
  const calls = installFetch((fn) => {
    if (on[fn]) { const r = on[fn](calls[calls.length - 1]); if (r) return r; }
    if (fn === 'getMyBranches') return okJson(E1());
    if (fn === 'getEditableCatalog') return okJson(st.read());
    if (fn === 'getBranchAvailability') return okJson({ branches: [] });
    return errJson(404, { error: 'not_found' });
  });
  const mods = await loadAll();
  const d = w.document;
  const n = (fn) => calls.filter((c) => c.fn === fn);
  const signIn = async () => {
    d.dispatchEvent(new w.CustomEvent('portal:auth', { detail: { uid: 'uOwnerIED' } }));
    d.dispatchEvent(new w.CustomEvent('portal:signed-in'));
    await settle(80);
  };
  const drawer = () => d.getElementById('drawer');
  const open = async (key) => { mods.app.openDrawer(key); await settle(10); return drawer(); };
  const fld = (label) => [...drawer().querySelectorAll('.dwb > .fld')].find((f) => { const l = f.querySelector('label'); return l && l.firstChild && l.firstChild.textContent.trim() === label; });
  const btn = (label) => [...drawer().querySelectorAll('.dwf button')].find((b) => b.textContent.trim() === label);
  const type = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); };
  const choose = (el, v) => { el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const src = () => mods.app.state.draft && JSON.parse(JSON.stringify((mods.app.state.draft.state)));
  return { dom, w, d, mods, st, calls, n, signIn, drawer, open, fld, btn, type, choose, src };
}
const lineOf = (f) => { const e = f && f.querySelector('.ferr.mk-ferr'); return e ? e.textContent.trim() : null; };

export { DIR, req, JSDOM, buildSourceFromCode, rendererContract, EE, HTML, RID, SRC, OWNER_CAPS, E1, servedRewardGroups, editable, settle, loadAll, page, lineOf, installFetch, okJson, errJson };
