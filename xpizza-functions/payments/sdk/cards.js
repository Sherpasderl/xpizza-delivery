'use strict';
// §6 saved cards (PLAN-sdk-d4-r4 S3, r3 #12) — ONE authoritative node per member (server-only, rules .read/.write false):
//   customer_cards/{uid} = { cards: { <card_id>: { token, token_hash, brand, last4, exp_month, exp_year, display_source,
//                                                  created_at, last_used_at, expired_at? } },
//                            by_hash: { <token_hash>: <card_id> }, tomb: { <token_hash>: { gen, removed_at } }, removed_ids: { <card_id>: true } }
// Admission (A3) reads it; completion, removal and expiry are each ONE transaction of it — never a second write elsewhere, so a
// removal cannot be raced by a completion. tomb.gen only grows: a completion admitted at an older generation is DROPPED, a fresh
// save admitted after the removal creates the card again. Never a token or hash in any response.
const crypto = require('crypto');
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CARD_ID_RE = /^[A-Za-z0-9]{20}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const newCardId = () => { let s = ''; for (const b of crypto.randomBytes(20)) s += B62[b % 62]; return s; };
const node = (db, uid) => db.ref(`customer_cards/${uid}`);
const SAVED_CARD_UNAVAILABLE = Object.freeze({ status: 409, body: Object.freeze({ error: 'saved_card_unavailable' }) });
const monthIndex = (ms) => { const d = new Date(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth() + 1; };
const expiredNow = (c, now) => !!c.expired_at || c.exp_year * 12 + c.exp_month < monthIndex(now);   // valid THROUGH its expiry month

async function memberUid(deps, headers = {}) {
  const a = headers.authorization;
  if (typeof a !== 'string' || !/^Bearer\s+\S+$/.test(a)) return null;
  try { const d = await deps.verifyIdToken(a.replace(/^Bearer\s+/, '')); return d && typeof d.uid === 'string' ? d.uid : null; } catch (_) { return null; }
}

// A3: ONLY the caller's own, usable card; absent / foreign / removed / expired ⇒ null (the handler answers SAVED_CARD_UNAVAILABLE)
async function resolveSavedCard(deps, uid, cardId) {
  if (typeof uid !== 'string' || !uid || typeof cardId !== 'string' || !CARD_ID_RE.test(cardId)) return null;
  const c = (await deps.db.ref(`customer_cards/${uid}/cards/${cardId}`).once('value')).val();
  if (!isObj(c) || typeof c.token !== 'string' || expiredNow(c, deps.clock())) return null;
  return { card_id: cardId, token: c.token, token_hash: c.token_hash, display: { brand: c.brand, last4: c.last4, exp_month: c.exp_month, exp_year: c.exp_year } };
}
// the removal generation a NEW save is admitted at (read with the admission)
async function vaultGenOf(deps, uid, tokenHash) {
  const g = (await deps.db.ref(`customer_cards/${uid}/tomb/${tokenHash}/gen`).once('value')).val();
  return Number.isInteger(g) ? g : 0;
}

async function completeVault(deps, { uid, token, token_hash: h, display: rawDisplay, vault_gen: gen }) {
  const now = deps.clock();
  const display = require('./display').sanitizeDisplay(rawDisplay);   // validated AGAIN at the vault write (Codex S3 r4 P1)
  if (!display) return { outcome: 'invalid_display' };
  let outcome = null;
  await node(deps.db, uid).transaction((cur) => {
    outcome = null;
    const c = isObj(cur) ? JSON.parse(JSON.stringify(cur)) : {};
    const t = isObj(c.tomb) ? c.tomb[h] : null;
    if (t && Number.isInteger(t.gen) && t.gen > (Number.isInteger(gen) ? gen : 0)) { outcome = 'dropped'; return cur == null ? null : undefined; }
    const existing = isObj(c.by_hash) ? c.by_hash[h] : null;
    if (existing && isObj(c.cards) && isObj(c.cards[existing])) { c.cards[existing].last_used_at = now; outcome = 'reused'; return c; }
    const id = newCardId();
    c.cards = { ...(isObj(c.cards) ? c.cards : {}), [id]: { token, token_hash: h, brand: display.brand, last4: display.last4, exp_month: display.exp_month, exp_year: display.exp_year, display_source: 'client', created_at: now, last_used_at: now } };
    c.by_hash = { ...(isObj(c.by_hash) ? c.by_hash : {}), [h]: id };
    outcome = 'created';
    return c;
  });
  return { outcome };
}

async function removeCard(deps, uid, cardId) {
  const now = deps.clock();
  await node(deps.db, uid).transaction((cur) => {
    if (cur == null) return null;
    const c = JSON.parse(JSON.stringify(cur));
    const card = isObj(c.cards) ? c.cards[cardId] : null;
    if (!isObj(card)) return undefined;   // already removed (or never this member's): idempotent, the generation untouched
    const h = card.token_hash;
    delete c.cards[cardId];
    if (isObj(c.by_hash) && c.by_hash[h] === cardId) delete c.by_hash[h];
    const prev = isObj(c.tomb) && isObj(c.tomb[h]) && Number.isInteger(c.tomb[h].gen) ? c.tomb[h].gen : 0;
    c.tomb = { ...(isObj(c.tomb) ? c.tomb : {}), [h]: { gen: prev + 1, removed_at: now } };
    c.removed_ids = { ...(isObj(c.removed_ids) ? c.removed_ids : {}), [cardId]: true };
    return c;
  });
  return { removed: true };
}

async function markExpired(deps, uid, tokenHash) {
  const now = deps.clock();
  await node(deps.db, uid).transaction((cur) => {
    if (cur == null) return null;
    const id = isObj(cur.by_hash) ? cur.by_hash[tokenHash] : null;
    if (!id || !isObj(cur.cards) || !isObj(cur.cards[id]) || cur.cards[id].expired_at) return undefined;
    const c = JSON.parse(JSON.stringify(cur)); c.cards[id].expired_at = now; return c;
  });
}

// GET listCards → { cards: [ { card_id, brand, last4, exp_month, exp_year, expired } ] } (members only; newest last_used_at first)
async function listCardsCore(deps, { headers } = {}) {
  const uid = await memberUid(deps, headers);
  if (!uid) return { status: 401, body: { error: 'auth_required' } };
  const v = (await node(deps.db, uid).once('value')).val();
  const now = deps.clock();
  const cards = Object.entries(isObj(v) && isObj(v.cards) ? v.cards : {})
    .map(([card_id, c]) => [card_id, c, isObj(c) ? require('./display').sanitizeDisplay(c) : null])
    .filter(([, , d]) => d)   // a row that fails the schema is never listed
    .sort(([, a], [, b]) => (b.last_used_at || 0) - (a.last_used_at || 0))
    .map(([card_id, c, d]) => ({ card_id, brand: d.brand, last4: d.last4, exp_month: d.exp_month, exp_year: d.exp_year, expired: expiredNow(c, now) }));
  return { status: 200, body: { cards } };
}
// POST removeCard { card_id } → { removed: true } (idempotent for the owner; another member's / unknown ⇒ 404)
async function removeCardCore(deps, { headers, body } = {}) {
  const uid = await memberUid(deps, headers);
  if (!uid) return { status: 401, body: { error: 'auth_required' } };
  const id = body && body.card_id;
  if (typeof id !== 'string' || !CARD_ID_RE.test(id)) return { status: 404, body: { error: 'not_found' } };
  const v = (await node(deps.db, uid).once('value')).val();
  const mine = isObj(v) && ((isObj(v.cards) && isObj(v.cards[id])) || (isObj(v.removed_ids) && v.removed_ids[id] === true));
  if (!mine) return { status: 404, body: { error: 'not_found' } };
  return { status: 200, body: await removeCard(deps, uid, id) };
}
// The vault write after `placed` (§6, S3) — from the WINNING attempt ONLY (legs[payment_placed.leg_id].attempt_id): a member, a NEW
// card, save:true. Idempotent and resumable: the record's `vault.state` (done / dropped / skipped) ends it; the sweeper calls this
// on every visit (CORE-Δ row 12), so a crash between the card write and the record note completes once (the card is reused).
// the WINNING attempt when it owes a vault write (a member, a NEW card, save:true), else null — ONE answer for the vault step and the
// token null below (fix/sdk-token-null-5f)
function vaultAttemptOf(order, rec) {
  const R = require('./record');
  if (!isObj(order) || !isObj(order.payment_placed) || typeof order.customer_uid !== 'string' || !order.customer_uid || !isObj(rec)) return null;
  const leg = R.legsOfRecord(rec)[order.payment_placed.leg_id];
  const aid = leg && leg.attempt_id;
  const att = aid && isObj(rec.attempts) ? rec.attempts[aid] : null;
  if (!isObj(att) || att.save !== true || att.card_ref !== 'new' || !isObj(att.display)) return null;
  return { aid, att };
}
async function completeVaultForOrder(deps, orderId) {
  const R = require('./record');
  const order = (await deps.db.ref(`orders/${orderId}`).once('value')).val();
  if (!isObj(order) || !isObj(order.payment_placed) || typeof order.customer_uid !== 'string' || !order.customer_uid) return { outcome: 'none' };
  const rec = (await deps.db.ref(`payment_sdk/${orderId}`).once('value')).val();
  if (!isObj(rec) || (isObj(rec.vault) && ['done', 'dropped', 'skipped'].includes(rec.vault.state))) return { outcome: 'none' };
  const va = vaultAttemptOf(order, rec);
  if (!va) return { outcome: 'none' };
  const { aid, att } = va;
  // the record's token is the WINNING attempt's (claims serialize; the winner is the last claimed) — verified by its hash
  const token = await require('./record-token').readAttemptToken(deps.db, orderId, rec, aid);   // the WINNING attempt's token (payment_sdk_tokens)
  const ok = typeof token === 'string' && crypto.createHash('sha256').update(token).digest('hex') === att.token_hash;
  const r = ok ? await completeVault(deps, { uid: order.customer_uid, token, token_hash: att.token_hash, display: att.display, vault_gen: att.vault_gen }) : { outcome: 'skipped' };
  const state = r.outcome === 'dropped' ? 'dropped' : r.outcome === 'skipped' ? 'skipped' : 'done';
  await R.casRecord(deps.db, orderId, (x) => { if (isObj(x.vault) && x.vault.state) return undefined; x.vault = { attempt_id: aid, state, at: deps.clock() }; return x; });
  return { outcome: state };
}
// owner ruling 11-18 (card items 2; PLAN-card-token-cleanup (b)): the record's reusable card token is NULLED once nothing can read it —
// its readers are the decrease / increase re-authorize (only while the order AND the record are open) and the vault step above. Nulled
// when the order is finished (terminal, or a committed cancel / expiry) AND the record is closed (not open / adjusting, no lock, no
// unanswered money op) AND the vault owes nothing (no save asked, or vault.state set). ONE CAS; the per-attempt token_hash is KEPT.
// Returns 'nulled' | 'kept' | 'none' (no token). Called by the sweeper right after the vault step; a lost CAS waits for the next visit.
async function nullSpentToken(deps, orderId) {
  const R = require('./record'); const T = require('./record-token');
  const order = (await deps.db.ref(`orders/${orderId}`).once('value')).val();
  // finished: terminal (delivered/completed, or payment_terminal) OR a committed cancel / expiry (payment_cancel — irreversible; the
  // record is then phase 'cancelled', checked below), so an abandoned or cancelled order's token does not stay forever
  const finished = isObj(order) && (R.TERMINAL.includes(order.status) || !!order.payment_terminal || !!order.payment_cancel);
  let out = 'none';
  await R.casRecord(deps.db, orderId, (x) => {
    out = 'none';
    if (!T.hasToken(x)) return undefined;
    out = 'kept';
    if (!finished || x.phase === 'open' || x.phase === 'adjusting' || x.lock || R.unansweredMoneyOps(x).length) return undefined;
    if (vaultAttemptOf(order, x) && !(isObj(x.vault) && x.vault.state)) return undefined;
    T.dropPointer(x); out = 'nulled';
    return x;
  });
  // owner GO 11-18: the token NODE goes with the pointer — and a finished order with no pointer sweeps any ORPHAN (a write-ahead whose
  // claim lost, or a crash between the pointer drop and this remove): nothing at payment_sdk_tokens outlives a finished order
  // card-cleanup (PLAN DELTA (1)): never a bare drop — the node goes in ONE update that queues each token for the provider delete
  if (out === 'nulled' || (out === 'none' && (finished || !isObj(order)) && await T.hasTokens(deps.db, orderId))) await T.enqueueAndDrop(deps.db, orderId, isObj(order) ? order.customer_uid : null, deps.clock());
  return out;
}
// Codex #158 r1 F2: an orphan token node may have NO due entry (a cancel cleanup raced a failing placement; a migration write-ahead lost its
// CAS after the null) — the sweeper also walks payment_sdk_tokens itself, bounded (a page per run behind a rotating cursor), and applies the
// SAME safe-close rule per order (nullSpentToken: a node whose order is finished — or gone — and whose record holds no live pointer)
const TOKEN_SWEEP_BATCH = 50;
async function sweepTokenOrphans(deps, { batch = TOKEN_SWEEP_BATCH } = {}) {
  const ids = await require('./record-token').pageTokenOrders(deps.db, batch);
  let checked = 0; let failed = 0;
  for (const oid of ids) { try { await nullSpentToken(deps, oid); checked += 1; } catch (_) { failed += 1; } }
  return { checked, failed };
}
module.exports = { sweepTokenOrphans, nullSpentToken, completeVaultForOrder, resolveSavedCard, vaultGenOf, completeVault, removeCard, markExpired, listCardsCore, removeCardCore, memberUid, SAVED_CARD_UNAVAILABLE };
