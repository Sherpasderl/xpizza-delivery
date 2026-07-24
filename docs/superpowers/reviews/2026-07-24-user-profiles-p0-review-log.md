# Codex design-review log — User Profiles Phase 0

**Spec:** `docs/superpowers/specs/2026-07-24-user-profiles-p0-design.md` · **Thread:** 019f959e · **Result: APPROVED (R4)** · MAX_ROUNDS 5.

## R1 — REVISE (12 findings)
Critical: **customer auth = `auth != null` would grant staff-node reads** (/orders,/tasks,… → mass PII leak). Plus forgeable `customer_uid`, recycled-number takeover, non-atomic OTP verify + rate-limit, spoofable per-IP, WhatsApp-bombing, mutable server-truth profile fields, vague CORS, non-fail-closed OTP_SALT, asserted-not-designed guest isolation, no privacy/deletion.
→ Added **H1–H10** hardening: staff role-gating BLOCKING pre-req; verified ID-token attribution; atomic RTDB txns; global per-phone limit + monitoring; immutable profile fields; CORS allowlist; OTP_SALT fail-closed; lazy-loaded Firebase (guest-with-SDK-blocked test); recycled re-confirm; server-side deletion + disclosure.

## R2 — REVISE (4 blockers)
`/user_orders` owner-readable in P0 (recycled history leak); recycled mitigation a time-based guess applied too late; profile immutability bypassable by wholesale delete; ID-token transport collides with `Authorization: Bearer ORDER_SECRET`.
→ `/user_orders` `.read:false` in P0; deterministic confirm + uid-rotate; parent `.write` requires `newData.exists()` (deletion server-side only); ID token via `X-Firebase-ID-Token` (Authorization unchanged, malformed never fails guest).

## R3 — REVISE (1 issue + 1 inconsistency)
The "¿Sos vos?" confirm is not a security control (recycled holder just taps yes); testing section still said `/user_orders` owner-read (contradicted the rule).
→ **H9 reframed honestly:** phone OTP = proof of *current* control, not original ownership; a recycled number inheriting the account is the **accepted phone-account model** (WhatsApp/Uber/DoorDash), **disclosed + bounded** in P0 (no pre-OTP PII, name-only durable, `/user_orders` read-denied, inactivity aging); a stronger anti-recycling control (recovery secret / rotate+merge) is a **BLOCKING pre-req before P2/P3** expose addresses/history. Fixed the guard-test inconsistency; added the H1 customer-token deny test.

## R4 — APPROVED
"Sound enough for a Phase 0 build under the stated owner risk acceptance." All material blockers closed; recycled-number risk accurately treated as an **owner product risk-acceptance** (not a technical contradiction). **Build-gate must enforce: rules-hardening (H1) ships BEFORE any customer token can be minted, and the named guard tests are non-optional.**

## Owner decision required (final human gate)
Accept the phone-account recycling model for P0 (recommended, industry-standard; P0 exposes name-only, history denied) **vs** add a second factor (email/PIN) now. Accepting = proceed to plan; the stronger control is a tracked blocking pre-req for P2 (addresses) / P3 (history).
