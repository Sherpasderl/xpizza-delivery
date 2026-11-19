// C-DIR-1 — THE ADDRESS-BOOK FIXTURE, produced by the REAL writer and 3a's REAL handlers (feat/addr-use-3a, which contains S-ADDR-1)
// — never hand-written. 3a's tree is not in this base, so this generator runs against an extracted tree of that commit:
//   git archive <sha> | tar -x -C <dir>;  ln -s <this repo>/xpizza-functions/node_modules <dir>/xpizza-functions/node_modules
//   node customer-app/fixtures/addr/gen-addr.mjs <dir> <full sha>        (<dir> = the extracted REPO root: the writer is xpizza-orders')
// Real pieces (Casa is inside x_pizza's 7 km zone, Trabajo ~180 km outside it):
//   · the book's ONLY writer: the frozen brand form's own saveAddress (xpizza-orders/account.js — newAddrId + saveAddress lifted and run
//     against this store, exactly as 3a's signup-platform.test.js 8b does): «Casa» (makeDefault) then «Trabajo»;
//   · signup-platform.js makeSignupPlatform getMyProfile (GET ?context=platform, the header token) — S-ADDR-1's address-book whitelist;
//   · my-address.js makeMyAddress useMyAddress (POST ?context=platform, body EXACTLY { id, expected_rev, expected_default } — the
//     selection CAS of PLAN-3a-addr-rev, APPROVED @805a5015) — S-ADDR-2's «en uso» write.
// The stand-ins: the RTDB store (reads return exactly what was written: val() + exists(); a multi-path update; a transaction that hands
// the updater the stored value — the server-truth re-run RTDB guarantees), the token check (verifyIdToken → { uid, customer: true }),
// an always-allowed rate limiter. Every served body is recorded VERBATIM.
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTX = process.argv[2], SHA = process.argv[3];
if (!ROOTX || !/^[0-9a-f]{40}$/.test(SHA || '')) throw new Error('usage: gen-addr.mjs <extracted repo root> <full commit sha>');
const FN = join(ROOTX, 'xpizza-functions'), require = createRequire(join(FN, 'x.js'));
const { makeSignupPlatform } = require('./signup-platform.js'), { makeMyAddress } = require('./my-address.js');
const blob = (rel) => { const b = readFileSync(join(ROOTX, rel)); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };   // = git hash-object

// ── the store ──
const tree = {}; const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const at = (p) => (p ? p.split('/').reduce((o, k) => (o == null ? undefined : o[k]), tree) : tree);
const put = (p, v) => { const ks = p.split('/'); let o = tree; for (const k of ks.slice(0, -1)) o = o[k] = (o[k] && typeof o[k] === 'object') ? o[k] : {}; if (v === null || v === undefined) delete o[ks.at(-1)]; else o[ks.at(-1)] = clone(v); };
const snap = (v) => { const c = v === undefined ? null : clone(v); return { val: () => c, exists: () => c !== null }; };
const db = { ref: (p = '') => ({
  once: async () => snap(at(p)), get: async () => snap(at(p)),
  update: async (u) => { for (const [k, v] of Object.entries(u)) put(p ? `${p}/${k}` : k, v); },
  set: async (v) => put(p, v),
  transaction: async (fn) => { const cur = at(p) === undefined ? null : clone(at(p)); const next = fn(cur); if (next === undefined) return { committed: false }; put(p, next); return { committed: true }; },
}) };

// ── the real writer: the frozen form's saveAddress ──
const ACC = readFileSync(join(ROOTX, 'xpizza-orders/account.js'), 'utf8');
const liftFn = (head) => { const i = ACC.indexOf(head); if (i <= 0) throw new Error('premise: account.js defines ' + head); return ACC.slice(i, ACC.indexOf('\n  }\n', i) + 4); };
const UID = 'u_ana';
const FORM = new Function('ensureFirebase', 'heal', 'MAX_ADDRESSES', 'window', `${liftFn('function newAddrId()')}\n${liftFn('async function saveAddress(')}\n${liftFn('async function deleteAddress(')}\nreturn { saveAddress, deleteAddress };`)(
  async () => ({ auth: { authStateReady: async () => {}, currentUser: { uid: UID } }, db: null, dbMod: { ref: (_d, p) => p, get: async (p) => db.ref(p).get(), update: async (_r, u) => db.ref().update(u) } }), () => {}, 10, { crypto: webcrypto });
const formSaveAddress = FORM.saveAddress, formDeleteAddress = FORM.deleteAddress;   // the frozen form's OWN writers (r3: deleteAddress too)
put(`user_profiles/${UID}`, { phone: '50499990000', created_at: 5, name: 'Ana' });
// «Casa» INSIDE x_pizza's zone (San Pedro Sula, ~1.7 km from its hub), «Trabajo» far OUTSIDE it (Tegucigalpa) — the checkout seed's two cases
const casa = await formSaveAddress({ label: 'Casa', detected: 'Col. Trejo, San Pedro Sula', details: 'Casa azul, portón negro', lat: 15.52, lng: -88.03, makeDefault: true });
await new Promise((r) => setTimeout(r, 5));
const trabajo = await formSaveAddress({ label: 'Trabajo', detected: 'Blvd. Morazán, Tegucigalpa', details: 'Torre 2, piso 5', lat: 14.1003, lng: -87.1901 });
if (!casa.ok || !trabajo.ok) throw new Error('premise: the form wrote the book ' + JSON.stringify([casa, trabajo]));

// ── the real handlers ──
const auth = { verifyIdToken: async (t) => { if (t !== 'tok_u_ana') throw new Error('foreign'); return { uid: UID, customer: true }; } };
const allow = async () => ({ allowed: true, retryAfterSec: 0 });
let clock = 1.8e12; const now = () => clock;
const SP = makeSignupPlatform({ getDatabase: () => db, getAuth: () => auth, checkRateLimit: allow, now, env: {}, grantSecret: () => 's' });
const MY = makeMyAddress({ getDatabase: () => db, getAuth: () => auth, checkRateLimit: allow, now });
async function call(h, { method, query, body }) {
  const r = { status: null, body: null };
  const res = { set() { return res; }, status(c) { r.status = c; return res; }, json(b) { r.body = clone(b); return res; } };
  await h({ method, query, body, ip: '1.1.1.1', headers: {}, get: (k) => (k.toLowerCase() === 'x-firebase-id-token' ? 'tok_u_ana' : undefined) }, res);
  return r;
}
const profile = () => call(SP.getMyProfile, { method: 'GET', query: { context: 'platform' }, body: {} });
const S = {};
// r3 (PLAN-3a-addr-rev @805a5015, APPROVED): every WRITE scenario records its REQUEST beside the response ({ req, status, body }) — the
// capp's stub answers a recorded write ONLY when the client sends that exact body, so it is never laxer than this handler
const use = async (body) => ({ req: clone(body), ...(await call(MY.useMyAddress, { method: 'POST', query: { context: 'platform' }, body })) });
const C = casa.addrId, Tb = trabajo.addrId;
S.profile_default_casa = await profile();                                   // Casa, rev 0
clock += 60e3;
S.use_trabajo = await use({ id: Tb, expected_rev: 0, expected_default: C });            // 200, rev 1
S.profile_after_use = await profile();                                      // Trabajo, rev 1
S.use_trabajo_again = await use({ id: Tb, expected_rev: 0, expected_default: C });      // the lost-reply RESEND: 409 naming MY id at rev 1
clock += 60e3;
S.use_casa = await use({ id: C, expected_rev: 1, expected_default: Tb });               // and back: 200, rev 2
S.profile_after_back = await profile();                                     // Casa, rev 2
S.use_trabajo_late = await use({ id: Tb, expected_rev: 0, expected_default: C });       // an OLD write landing late: 409 (Casa, 2) — never overwrites
S.use_unknown = await use({ id: 'a_' + '0'.repeat(12), expected_rev: 2, expected_default: C });   // the pair is current ⇒ 404 (409 precedes 404)
S.use_bad_shape = await use({ id: Tb, expected_rev: 2 });                   // expected_default missing ⇒ 400
// m3: a THIRD address saved by the frozen form, then the FORM makes it the default (no rev bump: the form never writes the rev) —
// the selection changes between the client's read and its pick
clock += 60e3;
const mama = await formSaveAddress({ label: 'Mamá', detected: 'Col. Trejo, San Pedro Sula', details: 'Casa verde, portón blanco', lat: 15.525, lng: -88.035 });
if (!mama.ok) throw new Error('premise: the form saved «Mamá» ' + JSON.stringify(mama));
S.m3_profile_casa = await profile();                                        // 3 rows, Casa, rev 2
const mamaDef = await formSaveAddress({ addrId: mama.addrId, label: 'Mamá', detected: 'Col. Trejo, San Pedro Sula', details: 'Casa verde, portón blanco', lat: 15.525, lng: -88.035, makeDefault: true });
if (!mamaDef.ok) throw new Error('premise: the form made «Mamá» the default ' + JSON.stringify(mamaDef));
S.m3_profile_mama = await profile();                                        // Mamá, rev STILL 2
S.m3_use_trabajo_stale = await use({ id: Tb, expected_rev: 2, expected_default: C });   // the client saw Casa ⇒ 409 (Mamá, 2)
clock += 60e3;
S.m3_use_trabajo_ok = await use({ id: Tb, expected_rev: 2, expected_default: mama.addrId });   // after the re-read: 200, rev 3
S.m3_profile_trabajo = await profile();                                     // Trabajo, rev 3
// the FORM deletes Casa (not the selection) between the client's read and its pick of Casa ⇒ the pair is current ⇒ 404
const del = await formDeleteAddress(C); if (!del.ok) throw new Error('premise: the form deleted «Casa» ' + JSON.stringify(del));
S.m3_profile_nocasa = await profile();                                      // Trabajo, rev 3, no Casa
S.m3_use_casa_gone = await use({ id: C, expected_rev: 3, expected_default: Tb });       // 404 — a refusal of a row she could see
put(`user_profiles/${UID}/addresses`, null); put(`user_profiles/${UID}/default_address`, null);
S.profile_empty = await profile();
const WANT = { profile_default_casa: 200, use_trabajo: 200, profile_after_use: 200, use_trabajo_again: 409, use_casa: 200, profile_after_back: 200, use_trabajo_late: 409,
  use_unknown: 404, use_bad_shape: 400, m3_profile_casa: 200, m3_profile_mama: 200, m3_use_trabajo_stale: 409, m3_use_trabajo_ok: 200, m3_profile_trabajo: 200, m3_profile_nocasa: 200, m3_use_casa_gone: 404, profile_empty: 200 };
for (const [k, v] of Object.entries(S)) if (v.status !== WANT[k]) throw new Error(`premise: ${k} answered ${v.status} (want ${WANT[k]}) ${JSON.stringify(v.body).slice(0, 160)}`);
const pair = (k) => [S[k].body.default_address, S[k].body.default_address_rev];
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
if (!eq(pair('profile_default_casa'), [C, 0]) || !eq(pair('profile_after_use'), [Tb, 1]) || !eq(pair('use_trabajo_again'), [Tb, 1]) || !eq(pair('profile_after_back'), [C, 2])
  || !eq(pair('use_trabajo_late'), [C, 2]) || !eq(pair('m3_profile_mama'), [mama.addrId, 2]) || !eq(pair('m3_use_trabajo_stale'), [mama.addrId, 2]) || !eq(pair('m3_profile_trabajo'), [Tb, 3]))
  throw new Error('premise: the selection CAS moved as the plan says');

const out = { source: { commit: SHA, blobs: Object.fromEntries(['xpizza-orders/account.js', 'xpizza-functions/signup-platform.js', 'xpizza-functions/address-book.js', 'xpizza-functions/my-address.js', 'xpizza-functions/member-auth.js'].map((f) => [f, blob(f)])),
  // the functions' files keyed relative to xpizza-functions/ too — the provenance registry's (site, module) shape (form-source-inventory; merge-forward 11-18)
  fn_blobs: Object.fromEntries(['signup-platform.js', 'address-book.js', 'my-address.js', 'member-auth.js'].map((f) => [f, blob(`xpizza-functions/${f}`)])) },
  ids: { casa: casa.addrId, trabajo: trabajo.addrId, mama: mama.addrId }, scenarios: S };
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
out.scenarios_sha256 = createHash('sha256').update(canon({ ids: out.ids, scenarios: S })).digest('hex');
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'addr.json'), JSON.stringify(out, null, 1) + '\n');
for (const [k, v] of Object.entries(S)) console.log(k, v.status, JSON.stringify(v.body).slice(0, 260));
