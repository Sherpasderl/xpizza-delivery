#!/usr/bin/env node
'use strict';
// D4-c4 — "Pausar pedidos": the OWNER's pause CLI, the ONLY writer of `order_control/{rid}` (PLAN-D4c4 rev 13 §1/§0).
// DRY RUN unless --apply.
//
//   node tools/order-control.js --project xpizza-delivery --rid <rid> --pause --reason "…" --actor "<name>" [--apply]                 indefinite
//   node tools/order-control.js --project xpizza-delivery --rid <rid> --pause --for 2h --reason "…" --actor "<name>" [--apply]        auto-resume
//   node tools/order-control.js --project xpizza-delivery --rid <rid> --pause --until 2026-10-08T21:00:00-06:00 --reason … --actor … [--apply]
//   node tools/order-control.js --project xpizza-delivery --rid <rid> --resume --reason "…" --actor "<name>" [--apply]
//
// The write is ONE RTDB transaction (tools/order-control-core.js txnCallback): it checks the version this run read (or
// --expect-version from an earlier dry run), increments it, sets `current` and adds the audit event under a preallocated
// op_id — no pause without its audit row. `principal` is the authenticated Google credential's email (§0.10), recorded
// beside the free-text --actor. Server time comes from RTDB `.info/serverTimeOffset` (§0.3). After applying it reads
// back, waits one reader-cache TTL + margin (every request whose control read STARTS after that sees the change), reads
// again, and reports "effective" — or "superseded by <op_id>". Runbook: docs/runbooks/order-control.md.
const crypto = require('crypto');
const admin = require('firebase-admin');
const { requireProject } = require('./require-project');
const PROJECT_ID = requireProject({ requireFlag: true });   // FIRST: states the project, before any client is constructed
const { RTDB_URL } = require('../catalog/mirror-rtdb');
const { discoverRestaurants } = require('./client-floor-admin');
const { makeFirestoreRegistryReader } = require('../catalog/restaurant-registry');
const { CACHE_TTL_MS } = require('../order-control');
const C = require('./order-control-core');

const WAIT_MS = CACHE_TTL_MS + 2000;
const parsed = C.parseArgs(process.argv.slice(2));
if (!parsed.ok) { console.error(`order-control: REFUSED — ${parsed.error}\n${C.USAGE}`); process.exit(2); }
const args = parsed;

admin.initializeApp({ projectId: PROJECT_ID, databaseURL: RTDB_URL });
const rtdb = admin.database();
const nodeRef = rtdb.ref(`order_control/${args.rid}`);

// the credential's identity: a service-account key names itself; a user ADC token is asked of Google's tokeninfo
async function resolvePrincipal() {
  if (process.env.FIREBASE_DATABASE_EMULATOR_HOST) return 'emulator (no credential)';
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/cloud-platform'] });
  const creds = await auth.getCredentials().catch(() => ({}));
  if (creds && creds.client_email) return creds.client_email;
  const token = await (await auth.getClient()).getAccessToken();
  const t = token && (token.token || token);
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(t)}`);
  const j = r.ok ? await r.json() : {};
  if (j && typeof j.email === 'string' && j.email) return j.email;
  throw new Error('the credential has no email identity (re-run `gcloud auth application-default login`)');
}

async function serverNowEstimate() {
  const off = (await rtdb.ref('.info/serverTimeOffset').once('value')).val();
  const c = C.serverClock(Number(off), Date.now());
  if (c.skewWarning) console.warn(`order-control: WARNING — this machine's clock is ${Math.round(c.offsetMs / 1000)} s off the server's; using the server-corrected time (fix the laptop clock)`);
  return c;
}

(async () => {
  const disc = await discoverRestaurants(rtdb, () => makeFirestoreRegistryReader(admin.firestore())());
  if (!disc.registryOk) console.warn(`order-control: WARNING — restaurant registry unreadable (${disc.registryError}); checking the rid against RTDB restaurants only`);
  if (!disc.rids.includes(args.rid)) { console.error(`order-control: REFUSED — unknown restaurant "${args.rid}" (known: ${disc.rids.join(', ') || 'none'})`); process.exit(1); }

  const node = (await nodeRef.once('value')).val();   // also establishes the connection the clock offset needs
  const clock = await serverNowEstimate();
  console.log(`order-control ${args.apply ? 'APPLY' : 'DRY RUN'} — project ${PROJECT_ID}, restaurant ${args.rid}`);
  console.log(`  now (server):  ${new Date(clock.serverNow).toISOString()}  (offset ${clock.offsetMs} ms)`);
  console.log(`  current:       ${C.describeState(node && node.current, clock.serverNow)}  [version ${C.versionOf(node)}]`);
  const plan = C.planChange({ node, args, serverNow: clock.serverNow });
  if (!plan.ok) { console.error(`order-control: REFUSED — ${plan.error}`); process.exit(1); }
  console.log(`  change:        ${JSON.stringify(plan.from)} → ${JSON.stringify(plan.to)}${plan.to.until !== undefined ? `  (until ${C.describeUntil(plan.to.until)})` : ''}`);
  if (plan.noop) { console.log('order-control: already in that state — nothing to write'); process.exit(0); }
  if (!args.apply) { console.log(`(dry run — nothing written; add --apply, optionally with --expect-version ${plan.expectedVersion})`); process.exit(0); }

  const principal = await resolvePrincipal();
  const opId = `oc_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
  // §0.3: re-validate the end time against server-now at the moment of applying (a slow operator / a delayed apply)
  const atApply = C.serverClock(clock.offsetMs, Date.now()).serverNow;
  const late = C.checkAtApply(plan, atApply);
  if (!late.ok) { console.error(`order-control: REFUSED — ${late.error}`); process.exit(1); }
  const tx = await nodeRef.transaction(C.txnCallback({ expectedVersion: plan.expectedVersion, to: plan.to, opId, actor: args.actor, principal, reason: args.reason, timestamp: admin.database.ServerValue.TIMESTAMP }));
  const after = tx.snapshot.val();
  if (!(tx.committed && after && after.current && after.current.op_id === opId)) {
    console.error(`order-control: REFUSED — the switch changed since it was read (now ${C.describeState(after && after.current, atApply)}, version ${C.versionOf(after)}); nothing written — re-run`);
    process.exit(1);
  }
  const back = (await nodeRef.once('value')).val();
  if (!(back && back.current && back.current.op_id === opId && back.events && back.events[opId])) { console.error('order-control: READ-BACK MISMATCH — inspect order_control/' + args.rid); process.exit(1); }
  console.log(`order-control: applied op ${opId} (version ${back.current.version}, by ${args.actor}, principal ${principal}); waiting ${WAIT_MS / 1000} s for every instance's cache…`);
  await new Promise((r) => setTimeout(r, WAIT_MS));
  const later = (await nodeRef.once('value')).val();
  const now2 = C.serverClock(clock.offsetMs, Date.now()).serverNow;
  if (!later || !later.current || later.current.op_id !== opId) {
    console.log(`order-control: SUPERSEDED by ${later && later.current ? later.current.op_id : '(node removed)'} — now ${C.describeState(later && later.current, now2)}`);
    process.exit(0);
  }
  console.log(`order-control: EFFECTIVE — ${args.rid} is ${C.describeState(later.current, now2)} for every request whose control read starts from now`);
  process.exit(0);
})().catch((e) => { console.error('order-control FAILED:', e && e.message); process.exit(1); });
