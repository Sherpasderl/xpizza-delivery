'use strict';
// PAY RATE (PROPOSAL-driver-pay-rate-reader r2) — the pure core of the owner's `tools/set-driver-rate.js`.
// The node platform_rates/driver_per_delivery is APPEND-ONLY: a rate change is ONE new {cents, effective_from} entry under a
// new push key; nothing is ever edited or deleted, so a past delivery keeps the rate it was paid at (pay-rate.js).
const { rateCentsInEffect, validEntry } = require('../pay-rate');

const NODE = 'platform_rates/driver_per_delivery';
const HN_OFFSET = '-06:00';   // America/Tegucigalpa: UTC-6, no daylight saving
const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:\d{2})?$/;

// "2026-11-01" / "2026-11-01T06:00" (Honduras time) / "2026-11-01T12:00Z" / "…-06:00" → epoch ms, or null
function parseEffectiveFrom(s) {
  const m = ISO.exec(String(s || ''));
  if (!m) return null;
  const [, y, mo, d, hh = '00', mi = '00', ss = '00', zone] = m;
  const iso = `${y}-${mo}-${d}T${hh}:${mi}:${ss}${zone || HN_OFFSET}`;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  // reject calendar overflow (2026-02-31 parses to March): the date read back in its own zone must be the date given
  const back = new Date(t + (zone && zone !== 'Z' ? zoneMs(zone) : zone === 'Z' ? 0 : zoneMs(HN_OFFSET)));
  if (back.getUTCFullYear() !== +y || back.getUTCMonth() + 1 !== +mo || back.getUTCDate() !== +d) return null;
  return t;
}
function zoneMs(z) { const sign = z[0] === '-' ? -1 : 1; return sign * ((+z.slice(1, 3)) * 60 + (+z.slice(4, 6))) * 60000; }

// argv (without node + script) → { cents, effectiveFrom, apply, allowPast } | { error }
function parseArgs(argv) {
  const known = new Set(['--project', '--cents', '--effective-from', '--apply', '--allow-past']);
  const out = { apply: false, allowPast: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!known.has(name)) return { error: `unknown argument ${a}` };
    if (name === '--apply') { out.apply = true; continue; }
    if (name === '--allow-past') { out.allowPast = true; continue; }
    const v = eq > 0 ? a.slice(eq + 1) : argv[++i];
    if (v === undefined) return { error: `${name} needs a value` };
    if (name === '--cents') out.centsRaw = v;
    else if (name === '--effective-from') out.effectiveRaw = v;
  }
  if (out.centsRaw === undefined) return { error: '--cents is required' };
  if (!/^[1-9]\d*$/.test(out.centsRaw) || !Number.isSafeInteger(Number(out.centsRaw))) return { error: `--cents must be a positive integer (cents), got ${JSON.stringify(out.centsRaw)}` };
  if (out.effectiveRaw === undefined) return { error: '--effective-from is required (ISO date / time; no zone = Honduras time)' };
  const t = parseEffectiveFrom(out.effectiveRaw);
  if (t === null) return { error: `--effective-from ${JSON.stringify(out.effectiveRaw)} is not a valid ISO date / time` };
  return { cents: Number(out.centsRaw), effectiveFrom: t, apply: out.apply, allowPast: out.allowPast };
}

// existing entries map + the parsed request + now → { entry, refusals[], notes[] }
function planRate(existing, req, now) {
  const entries = existing && typeof existing === 'object' ? existing : {};
  const entry = { cents: req.cents, effective_from: req.effectiveFrom };
  const refusals = []; const notes = [];
  if (!validEntry(entry)) refusals.push('the entry is malformed');
  const same = Object.entries(entries).filter(([, e]) => e && e.effective_from === entry.effective_from);
  if (same.length) refusals.push(`an entry already takes effect at that instant (${same.map(([k]) => k).join(', ')}) — append-only: pick another effective_from`);
  if (entry.effective_from < now && !req.allowPast) refusals.push('effective_from is in the PAST — every delivery since then would be paid at the new rate (retro-apply); pass --allow-past only if that is intended');
  const bad = Object.entries(entries).filter(([, e]) => !validEntry(e)).map(([k]) => k);
  if (bad.length) notes.push(`existing malformed entr${bad.length === 1 ? 'y' : 'ies'} (ignored by every reader): ${bad.join(', ')}`);
  notes.push(`rate in effect now: ${fmt(rateCentsInEffect(entries, now))}; at effective_from before / after this entry: ${fmt(rateCentsInEffect(entries, entry.effective_from))} → ${req.cents}`);
  return { entry, refusals, notes };
}
const fmt = (c) => (c === null ? 'none' : `${c} cents (L ${(c / 100).toFixed(2)})`);

// append ONE entry under a NEW key (never an existing one), then read it back. keyFn() → a fresh push key.
async function appendRate(db, entry, keyFn) {
  const key = keyFn();
  if (typeof key !== 'string' || !key) throw new Error('no push key');
  const ref = db.ref(`${NODE}/${key}`);
  if ((await ref.once('value')).val() !== null) throw new Error(`refusing: ${NODE}/${key} already exists (append-only)`);
  await ref.set(entry);
  const back = (await ref.once('value')).val();
  if (!back || back.cents !== entry.cents || back.effective_from !== entry.effective_from) throw new Error(`read-back mismatch at ${NODE}/${key}: ${JSON.stringify(back)}`);
  return key;
}

module.exports = { NODE, HN_OFFSET, parseEffectiveFrom, parseArgs, planRate, appendRate };
