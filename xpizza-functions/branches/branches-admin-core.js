'use strict';
// ORCHESTRATION O1a (PLAN-multi-location-orchestration r3.1 §2, §3, §4, §6) — the SHERPA-admin branches CLI's logic over an injected
// RTDB handle (tools/branches-admin.js adds only the explicit-project guard, the Admin app and argv). Owner rulings: pin / address /
// zone (and delivery fees) are Sherpa-admin writes only; the pin moves only while the branch is off.
// Every mutation command is a DRY RUN (ZERO writes; the plan printed, every guard evaluated) unless `apply`; with apply it writes
// through branch-store, then republishes the brand projection (fenced). A write whose projection is refused exits 1, named.
// Exit codes: 0 ok / dry run / no-op, 1 refusal, 2 usage.
const P = require('./branch-ops');
const S = require('./branch-store');
const { checkBrand } = require('./branch-check');
const B = require('../brands/brand-store');
const { ridCandidates } = require('./rid-alloc');

const USAGE = 'usage: branches-admin.js --project <id> (status <brandId> | check <brandId> | create-brand <brandId> --name S --first-branch S --phone S --prep MIN --hours JSON | materialize <rid> --lat N --lng N --address S [--reference S] [--radius KM]'
  + ' | set-location <rid> --expected-version N [--lat N --lng N] [--address S] [--reference S] [--radius KM]'
  + ' | enrich-legacy <rid> --expected-version N --location-name S --prep MIN [--address S] | resume <rid> | delete-draft <rid>'
  + ' | activate-brand <brandId> [--open rid,rid] | deactivate-brand <brandId> | resync-projection <rid>) [--apply]';

const FLAGS = { '--lat': ['lat', 'num'], '--lng': ['lng', 'num'], '--address': ['address', 'str'], '--reference': ['reference', 'str'], '--radius': ['radius', 'num'],
  '--expected-version': ['expectedVersion', 'num'], '--location-name': ['locationName', 'str'], '--prep': ['prep', 'num'], '--open': ['open', 'list'],
  '--name': ['name', 'str'], '--first-branch': ['firstBranch', 'str'], '--phone': ['phone', 'str'], '--hours': ['hours', 'json'] };

// argv (after <op> <id>) → opts; an unknown, valueless or non-numeric flag (or a stray argument) is an error — never ignored
function parseOpts(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const f = FLAGS[argv[i]];
    if (!f) return { error: argv[i].startsWith('--') ? `unknown flag ${argv[i]}` : `unexpected argument ${JSON.stringify(argv[i])}` };
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return { error: `${argv[i]} needs a value` };
    i += 1;
    if (f[1] === 'num') { const x = Number(v); if (v.trim() === '' || !Number.isFinite(x)) return { error: `${argv[i - 1]} must be a number` }; out[f[0]] = x; }
    else if (f[1] === 'list') out[f[0]] = v.split(',').filter(Boolean);
    else if (f[1] === 'json') { try { out[f[0]] = JSON.parse(v); } catch (_) { return { error: `${argv[i - 1]} must be JSON` }; } }
    else out[f[0]] = v;
  }
  return out;
}

// brand_busy (one lifecycle lock per brand): another op holds the brand — live (retry later) or interrupted (resume it first)
const busyLine = (r) => `branches-admin: REFUSED — brand_busy: otra operación en curso, reintentá${r.holder ? ` (${r.holder}` : ''}${r.holder ? (r.interrupted ? `, interrumpida: branches-admin resume ${r.brand} --apply)` : ')') : ''}`;
// what the operator does about a refusal that needs a decision first (Codex r3 #3)
const HINTS = { brand_lists_draft: 'desactivá la marca o quitá la sucursal primero' };
const refusedLine = (r) => (r.error === 'brand_busy' ? busyLine(r) : `branches-admin: REFUSED — ${r.error}${HINTS[r.error] ? `: ${HINTS[r.error]}` : ''}${r.errors ? `: ${r.errors.join(', ')}` : ''}${r.unmet ? ` ${JSON.stringify(r.unmet)}` : ''}${r.rids ? ` ${r.rids.join(', ')}` : ''}`);
const show = (title, apply, body) => `branches-admin ${title} ${apply ? 'APPLY' : 'DRY RUN'}${body === undefined ? '' : `\n${JSON.stringify(body, null, 2)}`}`;

async function publishAfter(rtdb, brandId, now, log) {
  const p = await B.publishBrandProjection(rtdb, brandId, { now });
  if (p.ok) { log(`branches-admin: projection published (${p.unchanged ? 'unchanged' : p.superseded ? 'a newer one already stands' : `source ${JSON.stringify(p.source)}`})`); return 0; }
  log(`branches-admin: written; projection NOT published — ${p.error}${p.errors ? `: ${p.errors.join('; ')}` : ''}`);
  return 1;
}

function locationInput(o) {
  const input = {};
  if (o.lat !== undefined || o.lng !== undefined) input.hub = { lat: o.lat, lng: o.lng };
  if (o.address !== undefined) input.address_line = o.address;
  if (o.reference !== undefined) input.address_reference = o.reference;
  if (o.radius !== undefined) input.zone_radius_km = o.radius;
  return input;
}

async function runBranchesAdmin({ rtdb, op, id, opts = {}, apply, nowMs: now, callId, log }) {
  if (opts.error) { log(`branches-admin: ${opts.error}\n${USAGE}`); return 2; }
  if (!op || !id) { log(USAGE); return 2; }
  const read = (p) => B.readNode(rtdb, p);

  if (op === 'status') {
    const brand = await read(`brands/${id}`);
    // the brand's lifecycle lock (one per brand): a live op, or an interrupted one waiting for `resume` — shown even when the brand
    // record does not exist yet (an interrupted create_draft; Codex r3 #5)
    const lock = await read(`brand_ops/${id}`);
    const unfinished = lock ? { kind: lock.kind || null, rid: (lock.inputs && lock.inputs.rid) || null, step: lock.step || null,
      interrupted: !(lock.lease && Number.isFinite(lock.lease.until) && lock.lease.until > now) } : null;
    if (brand === null && !lock) { log(refusedLine({ error: 'brand_not_found' })); return 1; }
    if (brand === null) { log(JSON.stringify({ brand: id, brand_record: null, branches: {}, unfinished_op: unfinished }, null, 2)); return 0; }
    const restaurants = (await read('restaurants')) || {};
    const branches = {};
    for (const [rid, node] of Object.entries(restaurants)) if (node && node.draft && node.draft.brand_id === id && !node.identity) branches[rid] = 'draft';
    for (const [rid, st] of Object.entries(brand.locations || {})) {
      const ident = restaurants[rid] && restaurants[rid].identity;
      branches[rid] = st === 'member' ? (ident && ident.active === true ? 'active' : 'inactive') : st;
    }
    log(JSON.stringify({ brand: id, activation: brand.activation || null, branches: Object.fromEntries(Object.keys(branches).sort().map((k) => [k, branches[k]])), unfinished_op: unfinished }, null, 2));
    return 0;
  }

  // READ-ONLY consistency report (Codex r3 #1(d)) — never writes, --apply or not; exit 1 on any finding
  if (op === 'check') {
    const r = await checkBrand(rtdb, id, { now });
    log(JSON.stringify(r, null, 2));
    if (r.lock) log(`branches-admin: a lifecycle op holds ${id} (${r.lock.kind}${r.lock.interrupted ? ', interrumpida' : ''}) — findings may be its unfinished work; resume it first`);
    return r.findings.length ? 1 : 0;
  }

  if (op === 'create-brand') {
    if ([opts.name, opts.firstBranch, opts.phone, opts.prep, opts.hours].some((x) => x === undefined)) { log(`branches-admin: create-brand needs --name --first-branch --phone --prep --hours\n${USAGE}`); return 2; }
    const input = { location_name: opts.firstBranch, phone: opts.phone, prep_default_min: opts.prep, hours: opts.hours };
    if ((await read(`brands/${id}`)) !== null && !apply) { log(refusedLine({ error: 'brand_exists' })); return 1; }
    const errors = P.draftErrors({ ...input, brand_id: id });
    if (errors.length) { log(refusedLine({ error: 'bad_draft', errors })); return 1; }
    log(show(`create-brand ${id}`, apply, { brand: { name: opts.name, active: true, locations: { [`${ridCandidates(id, opts.firstBranch, 1)[0]} (first free candidate at --apply)`]: 'staged' }, activation: { state: 'off' } }, first_branch_draft: input }));
    if (!apply) { log('(dry run — nothing written; add --apply)'); return 0; }
    const r = await S.createBrandWithDraft(rtdb, { brandId: id, brandName: opts.name, input, opId: `create_${id}`, callerUid: 'sherpa_admin_cli', now });
    if (!r.ok) { log(refusedLine(r)); return 1; }
    const [brand, draft] = [await read(`brands/${id}`), await read(`restaurants/${r.rid}/draft`)];
    if (!brand || !brand.locations || brand.locations[r.rid] !== 'staged' || !(draft || await read(`restaurants/${r.rid}/identity`))) { log(`branches-admin: READ-BACK MISMATCH — ${JSON.stringify({ brand, draft })}`); return 1; }
    log(`branches-admin: brand ${id} (off) + first branch ${r.rid} created and read back — next: materialize ${r.rid}`);
    return 0;
  }

  if (op === 'materialize') {
    const draft = await read(`restaurants/${id}/draft`);
    if (!draft) { log(refusedLine({ error: 'not_a_draft' })); return 1; }
    const location = locationInput(opts);
    const brand = await read(`brands/${draft.brand_id}`);
    const plan = P.planMaterialize({ draft, location, brandName: brand && brand.name, bounds: await read('platform_config/service_bounds'), now });
    if (!plan.ok) { log(refusedLine({ error: 'bad_location', errors: plan.errors })); return 1; }
    log(show(`materialize ${id}`, apply, plan.identity));
    if (!apply) { log('(dry run — nothing written; add --apply)'); return 0; }
    const r = await S.materializeBranch(rtdb, { rid: id, location, now, callId });
    if (!r.ok) { log(refusedLine(r)); return 1; }
    log(`branches-admin: ${id} is ${r.state}`);
    return publishAfter(rtdb, draft.brand_id, now, log);
  }

  if (op === 'set-location' || op === 'enrich-legacy' || op === 'resync-projection') {
    const identity = await read(`restaurants/${id}/identity`);
    if (!identity) { log(refusedLine({ error: 'not_a_branch' })); return 1; }
    const ev = op === 'resync-projection' ? identity.version : opts.expectedVersion;
    if (!Number.isFinite(ev)) { log(`branches-admin: ${op} needs --expected-version (the identity's current version)\n${USAGE}`); return 2; }
    let plan; let brandId;
    if (op === 'set-location') {
      brandId = identity.brand_id;
      plan = P.planSetLocation({ identity, input: locationInput(opts), bounds: await read('platform_config/service_bounds'), liveOrders: (await S.liveOrders(rtdb, id)).length, now, expectedVersion: ev });
    } else if (op === 'enrich-legacy') {
      brandId = id;
      const input = { location_name: opts.locationName, prep_default_min: opts.prep, ...(opts.address !== undefined ? { address_line: opts.address } : {}) };
      plan = P.planEnrichLegacy({ rid: id, identity, brand: await read(`brands/${id}`), input, expectedVersion: ev });
    } else {
      brandId = identity.brand_id || id;
      plan = { ok: true, patch: { version: ev + 1 } };
      log(`branches-admin resync-projection ${id}: version ${ev} → ${ev + 1} (no other field), then the fenced publish of ${brandId}`);
    }
    if (!plan.ok) { log(refusedLine(plan.errors.length === 1 && plan.errors[0] === 'stale_branch' ? { error: 'stale_branch' } : { error: 'refused', errors: plan.errors })); return 1; }
    log(show(`${op} ${id}`, apply, plan.patch));
    if (!apply) { log('(dry run — nothing written; add --apply)'); return 0; }
    const r = op === 'set-location' ? await S.setBranchLocation(rtdb, { rid: id, input: locationInput(opts), expectedVersion: ev, now })
      : op === 'enrich-legacy' ? await S.enrichLegacyIdentity(rtdb, { rid: id, input: { location_name: opts.locationName, prep_default_min: opts.prep, ...(opts.address !== undefined ? { address_line: opts.address } : {}) }, expectedVersion: ev })
        : await S.bumpIdentityVersion(rtdb, { rid: id, expectedVersion: ev });
    if (!r.ok) { log(refusedLine(r)); return 1; }
    log(`branches-admin: ${id} written (version ${r.version})`);
    return publishAfter(rtdb, brandId, now, log);
  }

  if (op === 'resume') {
    // <id> is a brand or one of its rids: the op record is the brand's lifecycle lock brand_ops/{brand}
    const brandId = await S.opBrandOf(rtdb, id);
    const rec = brandId ? await read(`brand_ops/${brandId}`) : null;
    if (!rec) { log(`branches-admin: no unfinished op for ${id} — nothing to resume`); return 0; }
    log(show(`resume ${id}`, apply, { brand: brandId, kind: rec.kind, step: rec.step, lease: rec.lease || null }));
    if (!apply) { log('(dry run — nothing written; add --apply)'); return 0; }
    const r = await S.resumeBranchOp(rtdb, { brandId, now, callId });
    if (!r.ok) { log(refusedLine(r)); return 1; }
    if (rec.kind === 'delete_draft') { log(`branches-admin: ${id} resumed → draft deleted (its rid / name reservations released)`); return 0; }   // nothing to publish
    if (rec.kind === 'create_draft') { log(`branches-admin: ${id} resumed → draft ${r.rid} created`); return 0; }   // a draft is not published
    log(`branches-admin: ${id} resumed → ${r.state || (r.opened ? `opened ${r.opened.join(', ') || '(no branch)'}` : 'done')}`);
    return publishAfter(rtdb, brandId, now, log);
  }

  if (op === 'delete-draft') {
    const draft = await read(`restaurants/${id}/draft`);
    if (!draft) { log(refusedLine({ error: 'not_a_draft' })); return 1; }
    log(show(`delete-draft ${id}`, apply, draft));
    if (!apply) { log('(dry run — nothing written; add --apply)'); return 0; }
    const r = await S.deleteBranchDraft(rtdb, { rid: id, brandId: draft.brand_id, now, callId });
    if (!r.ok) { log(refusedLine(r)); return 1; }
    log(`branches-admin: draft ${id} deleted (its rid / name reservations released)`);
    return 0;
  }

  if (op === 'activate-brand') {
    const open = opts.open || [];
    const check = await S.activateBrand(rtdb, { brandId: id, open, now, checkOnly: true });
    if (!check.ok) { log(refusedLine(check)); return 1; }
    log(show(`activate-brand ${id}`, apply, { state: 'on', open }));
    if (!apply) { log('(dry run — every readiness check passed; nothing written; add --apply)'); return 0; }
    const r = await S.activateBrand(rtdb, { brandId: id, open, now });
    if (!r.ok) { log(refusedLine(r)); return 1; }
    log(`branches-admin: ${id} on; opened ${r.opened.join(', ') || '(none)'}`);
    return publishAfter(rtdb, id, now, log);
  }

  if (op === 'deactivate-brand') {
    const brand = await read(`brands/${id}`);
    if (!brand || !brand.activation || brand.activation.state !== 'on') { log(refusedLine({ error: brand ? 'not_on' : 'brand_not_found' })); return 1; }
    log(show(`deactivate-brand ${id}`, apply, { state: 'off' }));
    if (!apply) { log('(dry run — nothing written; add --apply)'); return 0; }
    const r = await S.deactivateBrand(rtdb, { brandId: id, now });
    if (!r.ok) { log(refusedLine(r)); return 1; }
    log(`branches-admin: ${id} off (routing stops; bound orders unaffected)`);
    return publishAfter(rtdb, id, now, log);
  }

  log(USAGE);
  return 2;
}

module.exports = { runBranchesAdmin, parseOpts, USAGE };
