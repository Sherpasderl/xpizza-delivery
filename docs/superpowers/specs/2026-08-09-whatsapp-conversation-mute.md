# SPEC — WhatsApp auto-reply: mute the bot while a human is in the conversation

**Date:** 2026-08-09 · **Surface:** `xpizza-functions` — `onIncomingWhatsApp` (index.js:3756) + `whatsapp_inbound.js` (pure logic). **Type:** additive customer-messaging fix. Customer-facing inbound function → advisor + codex gate + scoped single-function deploy. **NOT money-path** (only gates the auto-REPLY; never touches orders/tracking/money).

## Problem
Every inbound customer chat message is classified + **auto-replied** (`onIncomingWhatsApp` → `inbound.classify` → a template). There is **no per-conversation pause** — so when staff try to have a real WhatsApp conversation with a customer, the bot answers every customer message. The only current off-switch is the **restaurant-wide** `whatsapp_enabled` flag (`isEnabledForRestaurant`), which silences the bot for *all* customers — too blunt.

## Goal
When a human is actively handling a WhatsApp conversation, the bot **backs off for that customer only**, automatically (no manual toggling), and **resumes on its own** once the human conversation goes idle. Zero effect on orders, status, tracking, or any other customer.

## Mechanism — auto-mute on staff reply
The signal is already arriving: when staff reply to a customer from the WhatsApp number, UltraMsg delivers that **outbound to this same webhook as `fromMe: true`** (the handler already special-cases `data.fromMe === true`, index.js:3858 — today it just ignores it). Use it:

1. **On `fromMe: true` (staff outbound):** instead of only ignoring it, **record/refresh a mute** for that customer's conversation — `whatsapp_mute/{rid}/{phoneKey}` = `{ at: <serverEpochMs> }` (admin-write). The customer is `data.to` on an outbound (vs `data.from` on an inbound); `phoneKey` = the existing phone normalization used for order-matching (reuse it — do NOT invent a new one). Still `return 200` as today.
2. **On inbound (`fromMe:false`), before auto-replying:** read `whatsapp_mute/{rid}/{phoneKey}`; if `now - at < muteWindowMs` → **suppress the auto-reply**. Do NOT reply; DO still log to `incoming_messages` (with `handled:false, reason:'muted: human handling'`) so the conversation stays visible. Otherwise → classify + reply exactly as today.
3. **Auto-expiry:** the mute is a bare timestamp — each staff message refreshes it; after `muteWindowMs` of no staff activity the bot resumes on its own. (Refresh ONLY on staff/`fromMe` messages — a customer texting is NOT a human-present signal; that's exactly when the bot should answer if no staff is engaged.)

## Window — live-tunable, short default
`muteWindowMs` read LIVE from `config/whatsapp_mute_window_ms` (per-load read; fallback default **10 min** if unset/invalid). Owner tunes without a redeploy. (Owner flagged 30 min as too long — the window only needs to exceed the gap between messages in a live chat; 10 min is the starting point, adjust from data. Trade-off: too short → the bot may answer during a natural reply gap; too long → a *fresh* inbound after a short convo waits longer before the bot auto-replies.)

## Pure logic (extract to `whatsapp_inbound.js`, unit-tested)
- `muteKeyFor(phone)` — the normalized `phoneKey` (reuse the existing normalization).
- `shouldSuppressAutoReply(muteRecord, now, windowMs)` → boolean: `!!muteRecord && Number.isFinite(muteRecord.at) && (now - muteRecord.at) < windowMs`.
- `resolveMuteWindowMs(configVal)` → the live value or the 10-min default (guards non-finite / non-positive).
The handler does the DB read/write side effects around these pure helpers (mirrors the existing `classify`/`getHoursStatus` split).

## Hard guardrails
1. **Money/order path untouched.** The mute ONLY gates the auto-reply. Orders, `STATUS_CHECK` order lookups (when NOT muted), tracking, factura, rewards — unchanged. The mute node is its own subtree; never writes orders/tasks/anything else.
2. **Existing inbound behavior preserved.** Secret check, restaurant routing, non-chat handling, `whatsapp_enabled` gate, and the classify/reply templates are byte-identical. The ONLY changes: (a) `fromMe` branch also writes the mute (still returns 200); (b) a mute check gates the reply on the inbound branch.
3. **FAIL-OPEN.** If the mute read errors/throws, **reply as today** (never let a mute bug silence the bot). Wrapped so it can never 500 → no UltraMsg retry storm.
4. **Bounded.** `whatsapp_mute` stays tiny — each write overwrites the same `{rid}/{phoneKey}` leaf; add an inline prune (drop entries older than a few × the window on write) or a small scheduled sweep. Admin-only node (rules: no client access).

## ⚠️ Build-gate pre-req (LOAD-BEARING — verify before building)
The whole mechanism hinges on **UltraMsg firing the `fromMe: true` webhook for messages staff send from the WhatsApp app/web** (not only via API). The handler already anticipates `fromMe` events, which is a strong sign, but CONFIRM it on-instance (send a staff reply from the WhatsApp app → verify a `fromMe` webhook hits `onIncomingWhatsApp`, e.g. via a temp log or an `incoming_messages` fromMe record). **If UltraMsg only fires `fromMe` for API-sent messages**, this auto-mute won't trigger for app-sent replies → fall back to an explicit trigger (a dispatcher "silenciar bot" toggle in the comms UI, or a staff keyword) — that would be a fresh design + gate.

## Rules
`whatsapp_mute` is admin-written by the function (bypasses rules) and read only by it → **no client access; add a deny rule** (`.read:false/.write:false`) for the node, or rely on the default-deny if the tree is default-closed. Run the RTDB emulator if a rules line is added ([[rtdb-rules-no-numchildren]]); prefer no-rules-change if the tree is already default-deny.

## Testing
- **Unit (pure, whatsapp_inbound.js):** `shouldSuppressAutoReply` truth table (no record → false; fresh `at` within window → true; `at` older than window → false; missing/non-finite `at` → false); `resolveMuteWindowMs` (valid → value; unset/0/NaN/negative → 10-min default); `muteKeyFor` normalization parity with order-matching.
- **On-device (owner):** verify the pre-req (staff app-reply → `fromMe` webhook). Then: staff reply to a customer → subsequent customer messages get NO auto-reply (but appear in `incoming_messages`) → wait past the window → the bot auto-replies again. Confirm a DIFFERENT customer is unaffected. Confirm toggling `config/whatsapp_mute_window_ms` changes the behavior live.

## Gate & deploy
- **Gate:** advisor + **codex** (customer-facing inbound; verify money/order path untouched, existing reply behavior byte-identical, fail-open, bounded, mute writes only its own node).
- **Deploy:** reconcile `.env`==live ([[functions-env-management]]) → **`firebase deploy --only functions:onIncomingWhatsApp`** (scoped single function → prunes nothing [[prod-functions-deployed-state]]) → verify only that function updated + inbound still auto-replies (unmuted). Owner deploys after APPROVED.

## Out of scope
- A dispatcher-facing "silence bot" toggle / comms composer (that's the dispatch comms-thread Phase 2). This spec is the automatic, zero-touch mute; a manual toggle is the fallback IF the `fromMe`-webhook pre-req fails.
- Any change to the auto-reply COPY or classification.
