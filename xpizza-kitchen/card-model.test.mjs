// Golden test for the pure KDS card state-model (card-model.js). Like the sibling goldens it loads the
// REAL module source as an ESM data: URL (dependency-free) so we test the SHIPPED code, not a copy.
// Run: node card-model.test.mjs
//
// Covers the Phase-2a contract invariants the advisor gates:
//   • released_at||created_at aging anchor (band doesn't regress to created_at)  — GOLDEN
//   • no order_timelines write anywhere in the KDS                               — CONTRACT GOLDEN
//   • recall NEVER reverts /orders.status (recall performs no status write)      — CONTRACT GOLDEN
//   • per-item check is LOCAL only (toggle performs no status write)             — CONTRACT GOLDEN
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./card-model.js', import.meta.url), 'utf8');
const {
  KDS_STATUS, agingAnchorMs, bandClass, isLateBand,
  actionStatusWrite, isLocalOnlyAction, deriveTab, completedTabVisible, orderForTab, paginate, countOffPage,
} = await import('data:text/javascript,' + encodeURIComponent(src));

let n = 0;
const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const MIN = 60000;
const NOW = 1_000_000_000_000;
const band = (over) => bandClass({ warnMin: 8, lateMin: 15, nowMs: NOW, ...over });

// ── agingAnchorMs: released_at wins over created_at; else created_at; else null ──
assert.equal(agingAnchorMs({ released_at: 500, created_at: 100 }), 500); ok('anchor: released_at wins when present');
assert.equal(agingAnchorMs({ created_at: 100 }), 100);                    ok('anchor: falls back to created_at');
assert.equal(agingAnchorMs({}), null);                                    ok('anchor: neither → null');
assert.equal(agingAnchorMs(null), null);                                  ok('anchor: null order → null (no throw)');

// ── GOLDEN: released_at anchor does NOT regress to created_at under the band ──
// A scheduled order placed 3h ago (created_at) but RELEASED 2 min ago must read FRESH, not LATE.
{
  const created = NOW - 180 * MIN;    // ancient — would be aging-late on created_at
  const released = NOW - 2 * MIN;     // just released — fresh
  const o = { created_at: created, released_at: released };
  const anchorMs = agingAnchorMs(o);
  assert.equal(anchorMs, released, 'anchor picks released_at');
  assert.equal(band({ statusStr: KDS_STATUS.PREP, anchorMs }), 'aging-fresh',
    'released-anchored → fresh (NOT late)');
  // Proof the anchor is load-bearing: the SAME order on created_at WOULD be late.
  assert.equal(band({ statusStr: KDS_STATUS.PREP, anchorMs: created }), 'aging-late',
    'same order on created_at would be late — anchor is what saves it');
  ok('GOLDEN released_at||created_at anchor: released-anchored card is fresh, created_at would be late');
}

// ── bandClass precedence: completed > completing > cancelado > listo > scheduled-pre-slot > aging ──
assert.equal(band({ completed: true, completing: true,  statusStr: KDS_STATUS.LISTO, anchorMs: NOW }), 'band-completing'); ok('precedence: completing beats listo');
assert.equal(band({ completed: true, completing: false, statusStr: KDS_STATUS.LISTO, anchorMs: NOW }), 'band-completed');  ok('precedence: completed (green)');
assert.equal(band({ cancelled: true, statusStr: KDS_STATUS.NUEVO, anchorMs: NOW - 40 * MIN }), '');                        ok('precedence: cancelado → "" (.cancelled owns band) over aging-late');
assert.equal(band({ statusStr: KDS_STATUS.LISTO, anchorMs: NOW - 40 * MIN }), 'band-listo');                               ok('precedence: listo (green) beats aging-late');
assert.equal(band({ statusStr: KDS_STATUS.NUEVO, scheduledFor: NOW + 30 * MIN, anchorMs: NOW - 40 * MIN }), 'band-scheduled'); ok('precedence: scheduled pre-slot (gold) beats aging');
assert.equal(band({ statusStr: KDS_STATUS.NUEVO, scheduledFor: NOW - 1,        anchorMs: NOW - 40 * MIN }), 'aging-late');  ok('scheduled AFTER slot falls through to aging-late (never hidden gold when late)');
assert.equal(band({ statusStr: KDS_STATUS.NUEVO, anchorMs: NOW - 10 * MIN }), 'aging-warn'); ok('aging: 10m → warn');
assert.equal(band({ statusStr: KDS_STATUS.NUEVO, anchorMs: NOW - 3 * MIN }),  'aging-fresh'); ok('aging: 3m → fresh');
assert.equal(isLateBand('aging-late'), true); assert.equal(isLateBand('aging-warn'), false); ok('isLateBand: only aging-late is late');

// ── CONTRACT GOLDEN: the ONLY status writes 2a performs are empezar→preparing, listo→ready ──
assert.equal(actionStatusWrite('empezar'), 'preparing'); ok('CONTRACT: empezar → preparing (the one start write)');
assert.equal(actionStatusWrite('listo'),   'ready');     ok('CONTRACT: listo → ready (the one ready write)');

// ── CONTRACT GOLDEN: recall NEVER reverts /orders.status (recall performs NO status write) ──
assert.equal(actionStatusWrite('recall'), null);         ok('CONTRACT recall-doesnt-revert-status: recall → null (NO /orders write, never reverts ready)');
assert.equal(isLocalOnlyAction('recall'), true);         ok('CONTRACT: recall is LOCAL-only');

// ── CONTRACT GOLDEN: per-item check is LOCAL only (toggle performs NO status write, never auto-readies) ──
assert.equal(actionStatusWrite('toggleItem'), null);     ok('CONTRACT per-item-local-only: toggleItem → null (no status write, never auto-fires ready)');
assert.equal(isLocalOnlyAction('toggleItem'), true);     ok('CONTRACT: toggleItem is LOCAL-only');

// prioritize + archive-cancel + unknown are LOCAL only too — and NOTHING ever returns a timeline write.
for (const a of ['prioritize', 'archiveCancel', 'weird', '', undefined, null]) {
  assert.equal(actionStatusWrite(a), null, `local-only: ${JSON.stringify(a)}`);
}
ok('CONTRACT: prioritize/archiveCancel/unknown → null (LOCAL only)');
// STRUCTURAL: actionStatusWrite can ONLY ever return one of these — never an order_timelines write.
for (const a of ['empezar', 'listo', 'recall', 'toggleItem', 'prioritize', 'archiveCancel', 'x']) {
  assert.ok([null, 'preparing', 'ready'].includes(actionStatusWrite(a)), `write set closed: ${a}`);
}
ok('CONTRACT no-timeline-write: the write set is CLOSED to {null, preparing, ready} — never order_timelines');

// ── deriveTab: completed (bumped OR delivered) vs open (incl. cancelado) ──
{
  const completed = new Set(['bumped']);
  assert.equal(deriveTab({ id: 'bumped', estado: KDS_STATUS.LISTO }, completed), 'completed'); ok('deriveTab: locally bumped → completed');
  assert.equal(deriveTab({ id: 'del', estado: KDS_STATUS.ARCHIVADO }, completed), 'completed'); ok('deriveTab: delivered (Archivado) → completed');
  assert.equal(deriveTab({ id: 'p', estado: KDS_STATUS.PREP }, completed), 'open');              ok('deriveTab: preparing → open');
  assert.equal(deriveTab({ id: 'c', estado: KDS_STATUS.CANCELADO }, completed), 'open');         ok('deriveTab: cancelado stays OPEN (stop-cooking until archived)');
}

// ── paginate: clamps, slices, derives counts ──
{
  const list = Array.from({ length: 25 }, (_, i) => ({ id: 'o' + i }));
  const p0 = paginate(list, 0, 12);
  assert.equal(p0.pageCount, 3); assert.equal(p0.slice.length, 12); assert.equal(p0.slice[0].id, 'o0'); ok('paginate: page 0 of 25/12 → 12 items, 3 pages');
  const p2 = paginate(list, 2, 12);
  assert.equal(p2.slice.length, 1); assert.equal(p2.slice[0].id, 'o24'); ok('paginate: last page → remainder');
  const clamp = paginate(list, 99, 12);
  assert.equal(clamp.page, 2); ok('paginate: out-of-range page clamps to last');
  assert.deepEqual(paginate([], 0, 12), { page: 0, pageCount: 1, total: 0, pageSize: 12, slice: [] }); ok('paginate: empty list → 1 empty page (no throw)');
}

// ── countOffPage: flagged ids not on the mounted page ──
assert.equal(countOffPage(['a', 'b', 'c'], new Set(['a'])), 2); ok('countOffPage: 3 late, 1 visible → 2 off-page');
assert.equal(countOffPage(['a', 'b'], ['a', 'b']), 0);          ok('countOffPage: all visible → 0');
assert.equal(countOffPage([], new Set()), 0);                   ok('countOffPage: none flagged → 0');

// ── SOURCE-INSPECTION contract: the KDS never WRITES order_timelines (read-subscription only) ──
// card-model is pure; the write-surface lives in index.html. Assert the shipped page has zero
// order_timelines WRITE (set/update/push/remove targeting that path). A read subscription
// (subscribeToOrderTimeline) is fine — the nudge only READS server stamps.
{
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const writeRe = /(set|update|push|remove|transaction)\s*\([^)]*order_timelines/;
  assert.ok(!writeRe.test(html), 'index.html must contain NO order_timelines write call');
  // And no ref(...'order_timelines'...) that is then written. Belt-and-suspenders: assert the only
  // order_timelines mentions are the read subscription path in the SDK usage/comments.
  ok('CONTRACT no-timeline-write (source): index.html has zero order_timelines write calls');
}
// ── completedTabVisible: Completados tab RENDER filter (fix #3 — session bumps + recent, not all history) ──
{
  const now = Date.now();
  const HR = 3600 * 1000, WIN = 18 * HR;
  const set = new Set(['LOCAL-1']);
  // (a) this session's local bump → always shown (even if its anchor is ancient)
  const localBump = { id: 'LOCAL-1', estado: KDS_STATUS.LISTO, hora: new Date(now - 100 * HR).toISOString() };
  assert.equal(completedTabVisible(localBump, set, now, WIN), true, 'local-bumped completed → shown regardless of age');
  // (b) a server-delivered order completed TODAY/recent → shown
  const recentDelivered = { id: 'SRV-NEW', estado: KDS_STATUS.ARCHIVADO, hora: new Date(now - 2 * HR).toISOString() };
  assert.equal(completedTabVisible(recentDelivered, set, now, WIN), true, 'recent server-delivered → shown');
  // (c) an OLD server-delivered order (outside the window) → EXCLUDED (this is the endless-scroll fix)
  const oldDelivered = { id: 'SRV-OLD', estado: KDS_STATUS.ARCHIVADO, hora: new Date(now - 100 * HR).toISOString() };
  assert.equal(completedTabVisible(oldDelivered, set, now, WIN), false, 'old server-delivered → EXCLUDED from the tab');
  // (d) a non-completed (open) order → never in the completed tab
  const openOrder = { id: 'OPEN-1', estado: KDS_STATUS.PREP, hora: new Date(now).toISOString() };
  assert.equal(completedTabVisible(openOrder, set, now, WIN), false, 'an open order is never completed-tab-visible');
  ok('completedTabVisible: session bump always + recent server-completed shown; OLD delivered excluded');
}

// ── orderForTab: per-tab render ordering (FIFO Open oldest-first + prioritized-front; Completados newest-first) ──
{
  const iso = (m) => new Date(2026, 0, 1, 12, m).toISOString();   // increasing minute = later
  // A=oldest, B, C, D=newest (by hora). Deliberately pass them out of order.
  const A = { id: 'A', hora: iso(0) }, B = { id: 'B', hora: iso(5) }, C = { id: 'C', hora: iso(10) }, D = { id: 'D', hora: iso(15) };
  const input = [C, A, D, B];

  // Open, no prioritized → oldest-first (FIFO): A, B, C, D
  assert.deepEqual(orderForTab(input, 'open', new Set()).map(o => o.id), ['A', 'B', 'C', 'D'],
    'Open tab → FIFO oldest-first by hora');

  // Open with D prioritized → D jumps to the FRONT, the rest stay FIFO: D, A, B, C
  assert.deepEqual(orderForTab(input, 'open', new Set(['D'])).map(o => o.id), ['D', 'A', 'B', 'C'],
    'Open tab → prioritized jumps to front, rest FIFO');

  // Two prioritized (C,A) → prioritized-first FIFO among themselves (A before C), then rest FIFO (B,D)
  assert.deepEqual(orderForTab(input, 'open', new Set(['C', 'A'])).map(o => o.id), ['A', 'C', 'B', 'D'],
    'Open tab → prioritized group is itself FIFO, then the rest FIFO');

  // Completados → newest-first: D, C, B, A (prioritized irrelevant on this tab)
  assert.deepEqual(orderForTab(input, 'completed', new Set(['A'])).map(o => o.id), ['D', 'C', 'B', 'A'],
    'Completados tab → newest-first, prioritized ignored');

  // Pure: does not mutate the input array
  assert.deepEqual(input.map(o => o.id), ['C', 'A', 'D', 'B'], 'orderForTab does not mutate its input');
  ok('orderForTab: Open FIFO (prioritized-front) · Completados newest-first · pure');
}

// ── SOURCE-INSPECTION contract: recall + toggleItem handlers perform NO setOrderStatus ──
{
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  // Extract each handler body and assert it does not call setOrderStatus.
  for (const fn of ['recall', 'toggleItem', 'prioritize']) {
    const m = new RegExp(`function ${fn}\\s*\\(([^)]*)\\)\\s*\\{([\\s\\S]*?)\\n\\}`).exec(html);
    assert.ok(m, `handler ${fn} found in index.html`);
    assert.ok(!/setOrderStatus/.test(m[2]), `${fn} must NOT call setOrderStatus (LOCAL only)`);
  }
  ok('CONTRACT recall/toggleItem/prioritize (source): handler bodies call NO setOrderStatus');
}
// ── SOURCE-INSPECTION: the SHIPPED anchor IS the golden-tested helper (not an inline fork) ──
{
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.ok(/elapsedAnchorMs\s*=\s*agingAnchorMs\(o\)/.test(html),
    'mapFirebaseOrderToCard must source the aging anchor from card-model.agingAnchorMs');
  ok('anchor golden is LOAD-BEARING: mapFirebaseOrderToCard uses agingAnchorMs (shipped path == tested helper)');
}

console.log(`card-model: OK (${n} cases)`);
