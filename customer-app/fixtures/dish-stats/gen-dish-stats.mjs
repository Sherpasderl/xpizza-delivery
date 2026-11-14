// PLAN-capp-dish-stats r0 — THE dish_stats CONTRACT FIXTURE, produced by 3a's REAL producer and serve path (feat/dish-stats-3a) —
// never hand-written. 3a's tree is not in this base, so this generator runs against an extracted tree of that commit:
//   git archive <sha> | tar -x -C <dir>;  ln -s <this repo>/xpizza-functions/node_modules <dir>/xpizza-functions/node_modules
//   node customer-app/fixtures/dish-stats/gen-dish-stats.mjs <dir>/xpizza-functions <full sha>
// Real pieces, in order:
//   · the served 1d.4 BODY: contract/capp/capture.mjs provisionBrand (the real publish + buildPublicMenu; its stats read has no
//     handle there, so it serves the body WITHOUT dish_stats — the 'plain' scenario, ETag = 3a's own PLAN_ETAG);
//   · ratings: the capp's rate request bodies → ratings/rating-v2 parseRequest (the server's own parser) → fulfilmentUpdater +
//     v2Updater (the writers) — the per-dish thumbs keyed by the SERVED dish_id, as the capp's rate sheet sends them;
//   · the doc: ratings/aggregate.buildPublicStats (the producer: its own thresholds — ≥ 20 votes);
//   · the served body: catalog/dish-stats-serve.withDishStats — the very call buildPublicMenu makes on that body — with the read
//     injected through ITS declared seam (deps.read/memo/inflight); non-blocking by design, so the first call starts the read and
//     the second serves it (exactly the endpoint's cold → warm sequence);
//   · the ETag: public-menu's formula over canonical-json — sha256("<rid> <representation_version> <canonicalJson(body)>").
// NOT here (raised with the advisor): orders_30d / top_rank / pairs need orders' dish_qty through createOrder's pricing-resolver
// identity context, which the capture does not expose — so these scenarios carry the VOTE stats only.
// Output: dish-stats.json — the envelopes { rid, representation_version, menu } + their ETags, and the source pins.
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FN = process.argv[2], SHA = process.argv[3];
if (!FN || !/^[0-9a-f]{40}$/.test(SHA || '')) throw new Error('usage: gen-dish-stats.mjs <extracted xpizza-functions> <full commit sha>');
const require = createRequire(join(FN, 'x.js'));
const RV2 = require('./ratings/rating-v2.js'), AGG = require('./ratings/aggregate.js'), DS = require('./catalog/dish-stats-serve.js');
const { canonicalJson } = require('./catalog/canonical-json.js');
const { provisionBrand, T0 } = await import(join(FN, 'contract/capp/capture.mjs'));
const blob = (rel) => { const b = readFileSync(join(FN, rel)); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };   // = git hash-object
const quiet = async (f) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await f(); } finally { console.log = l; console.warn = w; } };

const RID = 'x_pizza', DAY = AGG.DAY_MS, NOW = T0;
const prov = await quiet(() => provisionBrand(RID));
const plain = prov.envelope;
if (plain.representation_version !== '1d.4' || 'dish_stats' in plain.menu) throw new Error('premise: the capture serves 1d.4 without dish_stats');
const ids = plain.menu.dishes.map((d) => d.dish_id).filter((x) => typeof x === 'string' && x);
if (ids.length < 4) throw new Error('premise: served dish ids');

// one live rating per order, from the capp's rate request body: { order_id, store, dishes: { <served dish_id>: ±1 } }
function rating(n, thumbs) {
  const req = RV2.parseRequest({ order_id: `XPZ2610${String(n).padStart(4, '0')}`, store: 5, dishes: thumbs });
  if (!req.ok || req.kind !== 'v2') throw new Error('the server parser refused a capp rate body: ' + JSON.stringify(thumbs));
  const o = {}, at = NOW - 5 * DAY + n * 60e3;
  const node = RV2.v2Updater({ fields: req.fields, uid: `u${n}`, now: at + 3600e3 }, o)(RV2.fulfilmentUpdater({ restaurantId: RID, now: at }, {})(null));
  if (node.state !== RV2.STATES.LIVE) throw new Error('premise: a live rating');
  return node;
}
// the votes: dish A up/down per the scenario, dish B 15 up / 5 down (75 %), dish C 19 votes (below the producer's 20: no stats)
const votes = (aUp, aDown) => {
  const rs = []; let n = 0;
  const add = (id, up, down) => { for (let i = 0; i < up; i++) rs.push(rating(++n, { [id]: 1 })); for (let i = 0; i < down; i++) rs.push(rating(++n, { [id]: -1 })); };
  add(ids[0], aUp, aDown); add(ids[1], 15, 5); add(ids[2], 19, 0);
  return rs;
};
async function served(ratings) {
  const doc = AGG.buildPublicStats({ rid: RID, nowMs: NOW, orders: [], ratings, priceOf: () => null });
  const deps = { read: async () => doc.dish_stats || null, memo: new Map(), inflight: new Map(), now: () => NOW };
  const cold = await DS.withDishStats(RID, plain.menu, deps);
  if ('dish_stats' in cold) throw new Error('premise: the cold call never awaits the read');
  await deps.inflight.get(RID); await new Promise((r) => setImmediate(r));
  const body = await DS.withDishStats(RID, plain.menu, deps);
  if (!body.dish_stats) throw new Error('premise: the warm call serves the stats');
  return { doc_dish_stats: doc.dish_stats, envelope: { rid: plain.rid, representation_version: plain.representation_version, menu: body } };
}
const etag = (env) => `"${createHash('sha256').update(`${env.rid} ${env.representation_version} ${canonicalJson(env.menu)}`).digest('hex')}"`;

const out = { source: { commit: SHA, blobs: Object.fromEntries(['contract/capp/capture.mjs', 'catalog/dish-stats-serve.js', 'catalog/public-menu.js', 'catalog/canonical-json.js', 'ratings/aggregate.js', 'ratings/rating-v2.js'].map((f) => [f, blob(f)])) },
  ratings: { dish_a: ids[0], dish_b: ids[1], dish_c: ids[2] }, scenarios: {} };
const S = out.scenarios;
S.plain = { etag: prov.etag, envelope: plain };
if (etag(plain) !== prov.etag) throw new Error('premise: the ETag formula reproduces the served ETag');
for (const [k, up, down] of [['stats_a', 19, 1], ['stats_b', 23, 1]]) { const s = await served(votes(up, down)); S[k] = { etag: etag(s.envelope), envelope: s.envelope, produced: s.doc_dish_stats }; }
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
out.scenarios_sha256 = createHash('sha256').update(canon(out.scenarios)).digest('hex');
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'dish-stats.json'), JSON.stringify(out, null, 1) + '\n');
console.log(Object.entries(S).map(([k, v]) => `${k} ${v.etag.slice(0, 13)} dish_stats=${JSON.stringify(v.envelope.menu.dish_stats || null)}`).join('\n'));
