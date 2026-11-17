'use strict';
// LEDGER S4 — the pure core of the owner's `tools/set-commission-rate.js`. ledger_settings/commission/{scope}/{push} is APPEND-ONLY: a rate
// change is ONE new { bp, effective_from } entry under a new push key; nothing is edited or deleted. NEVER RETRO (r4.6 §4): a past
// effective_from is refused outright (no override — unlike the driver-rate CLI's --allow-past), so no order already placed is ever
// re-rated. The bounds are ledger/commission-rate.js's ONE contract (the reader ignores what this writer would refuse). The Admin SDK
// bypasses the rules (the node has none: server-only), so THIS writer is the gate.
const R = require('../ledger/commission-rate');
const { parseEffectiveFrom } = require('./set-driver-rate-core');   // one source: Honduras-time ISO parsing with calendar-overflow refusal

// argv (without node + script) → { scope, bp, effectiveFrom, apply } | { error }
function parseArgs(argv) {
  const known = new Set(['--project', '--scope', '--bp', '--effective-from', '--apply']);
  const out = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!known.has(name)) return { error: `unknown argument ${a}${name === '--allow-past' ? ' (a commission rate is never retro)' : ''}` };
    if (name === '--apply') { out.apply = true; continue; }
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (v === undefined) return { error: `${name} needs a value` };
    if (name === '--scope') out.scope = v; else if (name === '--bp') out.bpRaw = v; else if (name === '--effective-from') out.effectiveRaw = v;
  }
  if (out.scope === undefined || !(out.scope === R.DEFAULT || R.validRid(out.scope))) return { error: `--scope must be ${R.DEFAULT} or one restaurant id ([a-z0-9_], ≤ 64)` };
  if (out.bpRaw === undefined || !/^(0|[1-9]\d{0,4})$/.test(out.bpRaw) || Number(out.bpRaw) > R.MAX_BP) return { error: `--bp must be an integer from ${R.MIN_BP} to ${R.MAX_BP} (basis points: 1000 = 10 %)` };
  if (out.effectiveRaw === undefined) return { error: '--effective-from is required (ISO date / time; no zone = Honduras time)' };
  const t = parseEffectiveFrom(out.effectiveRaw);
  if (t === null) return { error: `--effective-from ${JSON.stringify(out.effectiveRaw)} is not a valid ISO date / time` };
  return { scope: out.scope, bp: Number(out.bpRaw), effectiveFrom: t, apply: out.apply };
}

const fmt = (r) => (r === null ? 'none' : `${r.bp} bp (${(r.bp / 100).toFixed(2)} %)`);
// the whole commission node + the request + now → { entry, refusals[], notes[] }
function planRate(existing, req, now) {
  const all = existing && typeof existing === 'object' ? existing : {};
  const entries = all[req.scope] && typeof all[req.scope] === 'object' ? all[req.scope] : {};
  const entry = { bp: req.bp, effective_from: req.effectiveFrom };
  const refusals = []; const notes = [];
  if (!R.validEntry(entry)) refusals.push(`the entry is out of bounds: bp an integer ${R.MIN_BP}–${R.MAX_BP}, effective_from an integer ms ≥ ${new Date(R.MIN_EFFECTIVE_FROM).toISOString()}`);
  if (entry.effective_from < now) refusals.push('effective_from is in the PAST — a commission rate is never retro (every order placed since then would be re-rated)');
  if (entry.effective_from > now + R.MAX_AHEAD_MS) refusals.push(`effective_from is more than ${R.MAX_AHEAD_MS / 86400000} days ahead`);
  const same = Object.entries(entries).filter(([, e]) => e && e.effective_from === entry.effective_from);
  if (same.length) refusals.push(`an entry of ${req.scope} already takes effect at that instant (${same.map(([k]) => k).join(', ')}) — append-only: pick another effective_from`);
  const bad = Object.entries(entries).filter(([, e]) => !R.validEntry(e)).map(([k]) => k);
  if (bad.length) notes.push(`existing malformed entr${bad.length === 1 ? 'y' : 'ies'} of ${req.scope} (ignored by every reader): ${bad.join(', ')}`);
  const rid = req.scope === R.DEFAULT ? 'x_pizza' : req.scope;   // any valid rid shows the default chain; a restaurant scope shows its own
  notes.push(`rate in effect now for ${req.scope === R.DEFAULT ? 'a restaurant with no own rate' : req.scope}: ${fmt(R.rateAt(all, rid, now))}`);
  return { entry, refusals, notes };
}

// append ONE entry under a NEW key of the scope (never an existing one), then read it back. keyFn() → a fresh push key.
async function appendRate(db, scope, entry, keyFn, now) {
  if (!(scope === R.DEFAULT || R.validRid(scope))) throw new Error(`refusing: scope ${JSON.stringify(scope)} is not ${R.DEFAULT} or a restaurant id`);
  if (!R.validEntry(entry) || entry.effective_from < now || entry.effective_from > now + R.MAX_AHEAD_MS) throw new Error(`refusing: ${JSON.stringify(entry)} is out of bounds or in the past (never retro)`);   // backstop
  const key = keyFn();
  if (typeof key !== 'string' || !key) throw new Error('no push key');
  const ref = db.ref(`${R.NODE}/${scope}/${key}`);
  if ((await ref.once('value')).val() !== null) throw new Error(`refusing: ${R.NODE}/${scope}/${key} already exists (append-only)`);
  await ref.set(entry);
  const back = (await ref.once('value')).val();
  if (!back || back.bp !== entry.bp || back.effective_from !== entry.effective_from) throw new Error(`read-back mismatch at ${R.NODE}/${scope}/${key}: ${JSON.stringify(back)}`);
  return key;
}

module.exports = { parseArgs, planRate, appendRate };
