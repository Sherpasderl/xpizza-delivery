// C-DIR-1 — THE ADDRESS-BOOK FIXTURE, produced by the REAL writer and 3a's REAL handlers (feat/addr-use-3a, which contains S-ADDR-1)
// — never hand-written. 3a's tree is not in this base, so this generator runs against an extracted tree of that commit:
//   git archive <sha> | tar -x -C <dir>;  ln -s <this repo>/xpizza-functions/node_modules <dir>/xpizza-functions/node_modules
//   node customer-app/fixtures/addr/gen-addr.mjs <dir> <full sha>        (<dir> = the extracted REPO root: the writer is xpizza-orders')
// Real pieces (Casa is inside x_pizza's 7 km zone, Trabajo ~180 km outside it):
//   · the book's ONLY writer: the frozen brand form's own saveAddress (xpizza-orders/account.js — newAddrId + saveAddress lifted and run
//     against this store, exactly as 3a's signup-platform.test.js 8b does): «Casa» (makeDefault) then «Trabajo»;
//   · signup-platform.js makeSignupPlatform getMyProfile (GET ?context=platform, the header token) — S-ADDR-1's address-book whitelist;
//   · my-address.js makeMyAddress useMyAddress (POST ?context=platform, body { id }) — S-ADDR-2's «en uso» write.
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
const formSaveAddress = new Function('ensureFirebase', 'heal', 'MAX_ADDRESSES', 'window', `${liftFn('function newAddrId()')}\n${liftFn('async function saveAddress(')}\nreturn saveAddress;`)(
  async () => ({ auth: { authStateReady: async () => {}, currentUser: { uid: UID } }, db: null, dbMod: { ref: (_d, p) => p, get: async (p) => db.ref(p).get(), update: async (_r, u) => db.ref().update(u) } }), () => {}, 10, { crypto: webcrypto });
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
S.profile_default_casa = await profile();
clock += 60e3;
S.use_trabajo = await call(MY.useMyAddress, { method: 'POST', query: { context: 'platform' }, body: { id: trabajo.addrId } });
S.profile_after_use = await profile();
S.use_casa = await call(MY.useMyAddress, { method: 'POST', query: { context: 'platform' }, body: { id: casa.addrId } });   // and back
S.use_unknown = await call(MY.useMyAddress, { method: 'POST', query: { context: 'platform' }, body: { id: 'a_' + '0'.repeat(12) } });
put(`user_profiles/${UID}/addresses`, null); put(`user_profiles/${UID}/default_address`, null);
S.profile_empty = await profile();
for (const [k, v] of Object.entries(S)) if (![200, 404].includes(v.status)) throw new Error(`premise: ${k} answered ${v.status} ${JSON.stringify(v.body).slice(0, 160)}`);
if (S.profile_default_casa.body.default_address !== casa.addrId || S.profile_after_use.body.default_address !== trabajo.addrId) throw new Error('premise: the default moves with useMyAddress');

const out = { source: { commit: SHA, blobs: Object.fromEntries(['xpizza-orders/account.js', 'xpizza-functions/signup-platform.js', 'xpizza-functions/address-book.js', 'xpizza-functions/my-address.js', 'xpizza-functions/member-auth.js'].map((f) => [f, blob(f)])),
  // the functions' files keyed relative to xpizza-functions/ too — the provenance registry's (site, module) shape (form-source-inventory; merge-forward 11-18)
  fn_blobs: Object.fromEntries(['signup-platform.js', 'address-book.js', 'my-address.js', 'member-auth.js'].map((f) => [f, blob(`xpizza-functions/${f}`)])) },
  ids: { casa: casa.addrId, trabajo: trabajo.addrId }, scenarios: S };
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
out.scenarios_sha256 = createHash('sha256').update(canon({ ids: out.ids, scenarios: S })).digest('hex');
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'addr.json'), JSON.stringify(out, null, 1) + '\n');
for (const [k, v] of Object.entries(S)) console.log(k, v.status, JSON.stringify(v.body).slice(0, 260));
