# EXECUTOR HANDOFF — User Profiles P0 BACKEND

**You are the EXECUTOR. You build. You do NOT gate and you do NOT deploy.** The advisor runs codex-on-diff (this is the platform's highest-stakes diff); Xavier deploys.

## Mission
Build the secure backend for optional customer accounts: rules hardening + WhatsApp-OTP auth functions + profile store + deletion + verified order attribution. **Backend only** — the forms UI is a separate later plan.

## Environment
- **Worktree:** `/Users/xavierlacayo/Downloads/xpizza-padthai`
- **Branch:** `feature/user-profiles-p0` (off `origin/main` fc87907; already checked out — the design spec/plan/log are committed on it)
- **Files:** `xpizza-functions/` (functions + tests), `xpizza-reference/database.rules.json` (rules)

## Read first (in order)
1. Spec: `docs/superpowers/specs/2026-07-24-user-profiles-p0-design.md` (esp. the **Security hardening H1–H10** section — these are gate-mandated).
2. Review log: `docs/superpowers/reviews/2026-07-24-user-profiles-p0-review-log.md` (why each control exists).
3. Plan: `docs/superpowers/plans/2026-07-24-user-profiles-p0-backend.md` ← **execute Tasks 1–8 in order**, commit after each. Task 9 (gate/deploy) is advisor + Xavier.

## How to build
Use **superpowers:subagent-driven-development**. The plan carries full code for the security-critical parts (rules, otp-lib, requestOtp, verifyOtp, deleteAccount, attribution) + TDD steps. Follow it exactly — this is security code; do not improvise the crypto/transaction/token logic.

## NON-NEGOTIABLES (from the codex design gate)
1. **H1 first:** the staff-read rules hardening (customer tokens excluded) is Task 1 and must be correct — customer `customer:true` tokens must NOT read `/orders`,`/tasks`,`/drivers`,`/dispatchers`,`/config`,`/order_timelines`,`/incoming_messages`. Guard test proves it. Existing staff/driver/kitchen access unchanged.
2. **No token mint without a verified OTP.** `verifyOtp` verifies + consumes in ONE RTDB transaction BEFORE `createCustomToken`. Never mint on `outcome!=='ok'`.
3. **Guest checkout byte-identical.** `createOrder`'s existing `ORDER_SECRET` path is untouched; the ID token is a SEPARATE `X-Firebase-ID-Token` header; a missing/malformed token must NOT fail the order.
4. **Owner-only PII.** `/user_profiles/{uid}` = `auth.uid===$uid`; `/otp`,`/otp_ip`,`/phone_index`,`/user_orders` = deny-all-client. `$other:false`; `phone`/`created_at` immutable; no wholesale client delete.
5. **Fail-closed `OTP_SALT`** (≥32 chars) — module throws if missing.
6. **CORS = exact allowlist** on the account endpoints (NOT `cors:true`).
7. **NO emoji** anywhere ([[no-cheap-emoji-in-form-chrome]]) — though this is backend, keep any strings clean.
8. **Do NOT deploy or merge to main.** Push the branch, report the SHA.

## Definition of done → hand to advisor
- Tasks 1–8 committed; `cd xpizza-functions && npm test` all PASS (incl. the new guard + otp + verify + lifecycle tests and the existing suite); emulator tests pass.
- Branch pushed: `feature/user-profiles-p0` (NOT main).
- **Report the tip SHA to the advisor** for **codex-on-diff** on the full security surface (functions + rules). Advisor gates → Xavier deploys **backend-first** (functions incl. new `OTP_SALT` env + rules), App Check monitor-only. The forms-UI plan ships only after this backend is live.
