'use strict';
// ---------------------------------------------------------------------------
// Phase 1d Stage 2b — the READ-SIDE fallback ladder.
//
// Entered ONLY when the live catalog read has failed or timed out. In Stage 2c this replaces the
// in-code tables as what prices an order during a Firestore outage, so its governing rule is: NEVER
// serve a price it cannot vouch for. Every rung either produces tables of known provenance or
// fails closed.
//
//   1. IN-MEMORY LAST-GOOD — the freshest coherent tables this instance actually served. No I/O, so
//      it is also the common case: a warm instance whose Firestore blipped.
//   2. RTDB MIRROR, VERSION-CHECKED — a cold instance has no last-good, so it reads the mirror.
//      Because the mirror is self-describing (it carries its own `seq`), the freshness check needs no
//      Firestore — which is the entire reason the mirror exists.
//   3. FAIL CLOSED — no coherent, fresh-enough source → throw. The 2c caller turns this into an order
//      REJECT. Firestore AND RTDB both unreachable is a platform-wide outage, and refusing to guess a
//      price is the correct behaviour there.
//
// WHY K=1. Stage 1b acks the mirror under the publish lease, and the lease serializes publishes per
// restaurant — so a successful publish leaves the mirror at most ONE version behind the pointer. K=1
// admits exactly that and refuses anything staler. A mirror ≥2 behind means a mirror write actually
// failed (which alarmed at publish time), so serving it would be serving prices from a version that
// was superseded twice.
//
// WHY AN ABSENT `seq` IS FAIL-CLOSED, NEVER DISTANCE-ZERO. Mirrors written before the ordinal existed
// carry no `seq`. Treating "absent" as zero distance would make the STALEST possible mirror read as
// perfectly fresh — the worst available default for a disaster fallback. Absent is refused.
// ---------------------------------------------------------------------------

const { isValidPrice } = require('../price-valid');   // the ONE platform price rule (1a)

const DEFAULT_K = 1;
const MIRROR_READ_DEADLINE_MS = 1500;

function withDeadline(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}_timeout`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A price table is usable only if EVERY entry is a non-empty string key mapping to a positive-integer
// price — the same rule the calculators enforce. The 1a guard at the calculator is the final backstop,
// but the ladder must not lean on it: its own contract is "never serve a price it cannot vouch for",
// and serving a table it knows is corrupt would break that contract even if nothing downstream is
// mispriced. Fail closed here, first.
const pricesOk = (t) => !!t && typeof t === 'object' && !Array.isArray(t)
  && Object.entries(t).every(([k, v]) => typeof k === 'string' && k.length > 0 && isValidPrice(v));

// A mirror payload is usable only if it is fully self-describing (an ordinal) AND its tables are sound.
function mirrorUsable(m) {
  return !!m && Number.isInteger(m.seq) && pricesOk(m.menu) && pricesOk(m.extras);
}

// createSnapshotFallback({ mirrorReader, alarm, K, deadlineMs })
//   mirrorReader(rid) → the RTDB mirror payload (or null/undefined when absent). Firestore-independent.
//   alarm(kind, detail) → best-effort signal; never allowed to break pricing.
// Returns { snapshotFor, recordActive, recordGood, state } — the recorders are what the resolver calls
// on its happy path so the ladder has something to stand on when the outage arrives.
function createSnapshotFallback({ mirrorReader, alarm, K = DEFAULT_K, deadlineMs = MIRROR_READ_DEADLINE_MS } = {}) {
  const lastKnownActive = new Map();   // rid -> { versionId, seq }   — the ordinal K measures against
  const lastGood = new Map();          // rid -> { versionId, seq, menu, extras } — freshest coherent serve
  const fire = (kind, detail) => {
    try { const r = alarm && alarm(kind, detail); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch (_) {}
  };

  // Learn which version is live. Recorded even when the subsequent table read fails, so a cold-ish
  // instance that saw the pointer still has an ordinal to check the mirror against.
  function recordActive(rid, versionId, seq) {
    if (Number.isInteger(seq)) lastKnownActive.set(rid, { versionId: versionId || null, seq });
  }
  // Remember a serve that actually succeeded — rung 1.
  // 2c RECORDS-LANDING SIGNAL. "The ladder is injected" and "the ladder is being fed" are different
  // claims, and only the second one matters at an outage. The wiring test proves injection; this proves
  // the records actually LAND, sampled per restaurant so it is a heartbeat and not a per-order log.
  // It exists because a wiring bug here is silent by construction — the resolver's recorder calls are
  // wrapped in a catch (correctly: a recording failure must never break pricing), which already hid a
  // name collision that left the ladder permanently empty while every test passed.
  const WARM_MS = 60000;
  const _lastWarm = new Map();
  function warmSignal(rid, rec) {
    const last = _lastWarm.get(rid) || 0;
    const t = Date.now();
    if (t - last < WARM_MS) return;
    _lastWarm.set(rid, t);
    console.log('pricing_ladder_warm', JSON.stringify({ restaurantId: rid, version: rec.versionId, seq: rec.seq, items: Object.keys(rec.menu || {}).length }));
  }
  function recordGood(rid, { versionId, seq, menu, extras }) {
    // Symmetry with the mirror rung: never remember a table the ladder would refuse to serve, so rung 1
    // cannot hand out something rung 2 would have rejected. A served happy-path table cannot be corrupt
    // today (the reader and the 1a guard already reject one) — the ladder simply does not depend on that.
    if (!pricesOk(menu) || !pricesOk(extras)) return;
    const rec = { versionId: versionId || null, seq: Number.isInteger(seq) ? seq : null, menu, extras };
    lastGood.set(rid, rec);
    if (Number.isInteger(seq)) recordActive(rid, versionId, seq);
    try { warmSignal(rid, rec); } catch (_) { /* observability must never break pricing */ }
  }

  async function snapshotFor(rid) {
    // ── Rung 1: in-memory last-good. By construction its seq ≥ any older mirror's, so no check needed.
    const good = lastGood.get(rid);
    if (good) {
      return { source: 'last_good', versionId: good.versionId, seq: good.seq, menu: good.menu, extras: good.extras };
    }

    // ── Rung 2: the RTDB mirror, version-checked. Bounded — a hung RTDB must not hang an order.
    let mirror = null;
    try {
      mirror = await withDeadline(Promise.resolve(mirrorReader ? mirrorReader(rid) : null), deadlineMs, 'catalog_mirror_read');
    } catch (e) {
      fire('catalog_mirror_read_failed', { restaurantId: rid, error: String((e && e.message) || e).slice(0, 200) });
      mirror = null;
    }
    if (mirrorUsable(mirror)) {
      const known = lastKnownActive.get(rid);
      if (known && Number.isInteger(known.seq)) {
        const distance = known.seq - mirror.seq;
        if (distance <= K) {
          return { source: 'mirror', versionId: mirror.version || null, seq: mirror.seq, menu: mirror.menu, extras: mirror.extras };
        }
        fire('catalog_mirror_too_stale', { restaurantId: rid, activeSeq: known.seq, mirrorSeq: mirror.seq, distance, K });
      } else {
        // Truly cold: Firestore was never reachable, so we never learned the active version. The
        // mirror's self-described ordinal is all we have. Serve it as the bounded disaster fallback and
        // say so loudly — this is the one rung that serves without a second opinion.
        fire('catalog_served_from_mirror_cold', { restaurantId: rid, version: mirror.version || null, seq: mirror.seq });
        return { source: 'mirror_cold', versionId: mirror.version || null, seq: mirror.seq, menu: mirror.menu, extras: mirror.extras };
      }
    } else if (mirror) {
      // Present but not self-describing — an ordinal-less (pre-2b-pre) or malformed mirror.
      fire('catalog_mirror_unusable', { restaurantId: rid, hasSeq: Number.isInteger(mirror.seq) });
    }

    // ── Rung 3: fail closed.
    fire('snapshot_fallback_unavailable', { restaurantId: rid });
    throw new Error(`snapshot_fallback_unavailable: ${rid}`);
  }

  return {
    snapshotFor, recordActive, recordGood, K, deadlineMs,
    state: { lastKnownActive, lastGood },   // exposed for tests + operational introspection
  };
}

// The bounded RTDB mirror READER, parsing the projection makeRtdbMirror actually writes.
function makeRtdbMirrorReader(rtdb) {
  return async function readMirror(rid) {
    const snap = await rtdb.ref(`catalog_snapshot/${rid}`).get();
    return snap && typeof snap.val === 'function' ? snap.val() : null;
  };
}

module.exports = { createSnapshotFallback, makeRtdbMirrorReader, mirrorUsable, pricesOk, DEFAULT_K, MIRROR_READ_DEADLINE_MS };
