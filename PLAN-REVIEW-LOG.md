# Plan Review Log: Static security + reliability audit of the X Pizza delivery platform
Act 1 (grill) complete — plan locked with the user. MAX_ROUNDS=3.

Grill decisions:
1. Deliverable = prioritized remediation roadmap (no code during audit).
2. Severity lens = security + reliability first; efficiency/cost/maintainability lower.
3. Method = static + config review only; zero live requests / side effects.
4. Scope = whole platform, depth by risk; + npm check + out-of-repo verify checklist.
5. Confidence bar = demonstrable + reasoned hardening, severity calibrated to ~2-driver volume; speculative flagged.
6. No specific suspected surface — open "find our blindspots" sweep. MAX_ROUNDS=3.

---

## Round 1 — Codex
Thread: 019ea382-c5e4-7571-b4d0-46e5b4aad152 · read-only

**Findings**

1. `createOrder` auth model is already broken in the public order form: `ORDER_SECRET` is embedded in xpizza-orders/index.html:1226 and sent as a bearer token at line 2220. The plan treats `MAKE_SECRET` as a server-side shared secret, but this is now a public browser credential. Fix: add a "public static asset credential exposure" step and require rotation + new order-intake auth design review.
2. Secret scanning too narrow. Plaintext secrets in xpizza-functions/.env and run_patches.sh (MAKE_SECRET, VAPID private key, UltraMsg token, webhook secret, Sheet ID). Plan only said committed/history secrets; ignored/untracked local files + helper scripts are real repo risk. Fix: full working-tree scan incl. ignored/untracked files and scripts; classify exposed secrets as immediate rotation items.
3. "Already done well" pre-commits a false claim: `createOrder` uses normal string comparison, not constant-time, at index.js:182. Fix: remove "constant-time secret compare" from assumed positives; audit each secret comparison independently.
4. Rules file does not define `order_tracking` or `incoming_messages`, while the tracking app expects anonymous reads from `order_tracking/{token}` (xpizza-track/index.html:641) and functions/dispatch read/write `incoming_messages`. Static review of the repo rules file alone cannot prove what is deployed. Fix: add a deployed-rules/config reconciliation step.
5. Kitchen auth under-covered. SDK has `isKitchen(uid)` checking `/kitchen/{uid}` (xpizza-dispatch/xpizza-delivery.js:132), but `/kitchen` is absent from the rules matrix, and kitchen can update order state. Fix: add `/kitchen` membership + KDS status-update paths to the deep authz matrix.
6. Plan admits it won't read every copied SDK, contradicting "whole platform." Copies in dispatch, driver, dashboard, kitchen, reference contain privileged write helpers (`assignOrderToDriver`, `cancelOrder`, `createOrderWithTasks`). Fix: read/diff every `xpizza-delivery.js` copy and map every exported write helper to Firebase rules.
7. Driver privilege escalation needs precision. Rules allow a driver to write an assigned task broadly if `data.assigned_driver_id === auth.uid` OR `newData.assigned_driver_id === auth.uid` (database.rules.json:27), with weak child validation. Fix: add field-level task mutation review (status, destination, linked task, totals, assignment metadata).
8. Sheets formula injection underspecified and partly not statically verifiable. The Cloud Function only writes `Cancelado`; the path writing full order data into the KDS Sheet appears external/legacy. Fix: split repo-confirmed Sheets writes from out-of-repo Sheet ingestion; checklist for Make/Apps Script/Sheet formulas receiving customer-controlled fields.
9. DoS severity calibration off. With the order secret exposed publicly, low volume does NOT make spam low-risk: bogus orders trigger DB writes, WhatsApp sends, dispatch noise, driver disruption. Fix: add a low-volume operational-abuse scenario (order spam, WhatsApp spend/ban, dispatcher overload).
10. Static-only overclaims race-condition confidence. Sleeping functions, concurrent triggers, reassignment races, timeout monitors (index.js:1406, 1525) can be reasoned about but not verified statically. Fix: mark trigger race findings as design-risk unless backed by emulator tests; add post-audit dynamic test checklist.
11. Frontend injection review too light. Multiple apps render DB/customer fields via `innerHTML`; some call `escapeHtml`, some need verification. Fix: systematic source-to-sink XSS review for all untrusted fields rendered into HTML, URLs, `tel:`, `wa.me`, maps links, SVG/chart markup.
12. Supply-chain coverage weak if offline. `npm audit` needs current advisory data; reading `package-lock.json` alone can't confirm current CVEs. Fix: require dated `npm audit`/OSV results, or explicitly mark dependency status unverified.

**VERDICT: REVISE**

### Claude's response (Round 1)
Verified the three highest-impact claims directly against the code before accepting:
- **#1 CONFIRMED** — `ORDER_SECRET = '3f9fb4bd…'` hardcoded at xpizza-orders/index.html:1226, sent as bearer at :2220. The order-intake secret is public. This is now itself a top finding, not just a plan gap.
- **#3 CONFIRMED** — index.js:182 is a plain `!== SECRET`; constant-time compare is only used by onIncomingWhatsApp. The "already done well" claim was false.
- **#2 CONFIRMED** — `.env` (gitignored, on disk) and untracked `run_patches.sh` hold all live secrets in plaintext.

**Accepted: all 12.** None were bad-faith or incorrect; each materially improves coverage or fixes a calibration/methodology error. Changes made to PLAN.md:
- Reframed the `createOrder` trust boundary around the **publicly-exposed order secret**; added a "public static-asset credential exposure" audit step (#1). Removed the false constant-time positive and added "audit each secret comparison independently" (#3).
- Broadened secret handling to a **full working-tree scan incl. ignored/untracked files + helper scripts**, with exposed secrets classified as immediate-rotation items (#2).
- Added `/kitchen`, `order_tracking`, `incoming_messages` to the authz matrix and a **deployed-rules reconciliation** caveat (cannot prove deployed rules statically) (#4, #5).
- Upgraded SDK review from "skim" to **read/diff every `xpizza-delivery.js` copy** and map each exported write helper to a rule (#6). Added **field-level driver task-mutation** review (#7).
- Split **repo-confirmed vs out-of-repo Sheets writes**; moved full-order-data formula-injection to the out-of-repo checklist (#8).
- Recalibrated **DoS/operational-abuse** severity given the public secret (#9). Marked **race-condition findings as design-risk** (static), with a dynamic-test follow-up checklist (#10).
- Added a **systematic source-to-sink XSS** pass across all apps (#11). Required **dated npm audit/OSV** or an explicit "unverified" mark for dependencies (#12).
No rejections. Proceeding to Round 2.

---

## Round 2 — Codex
Thread: 019ea382-c5e4-7571-b4d0-46e5b4aad152 (resumed) · read-only

Round 1 coverage now mostly fixed — all 12 prior findings adequately addressed in the revised plan. Two new gaps:

A. **Payment trust boundary / PCI (material).** The order form collects card number, holder, expiry, and CVV; PixelPay placeholder/demo behavior; can post card data to a backend if configured; can set `payment_method: online` / `payment_status` client-side. The plan only covered browser tampering for price/total/items, not payment-status spoofing, backend endpoint presence/absence, card-data logging/storage, PCI exposure, or whether dispatch/drivers trust `payment_method` as proof of payment. Fix: add a deep payment-flow audit section.

B. **Public third-party API-key abuse.** Google Maps key is public in the order form; unrestricted Maps/Places keys → billing-abuse risk for a small shop. Fix: add API-key restriction review (referrers, enabled APIs, quotas, billing caps).

**VERDICT: REVISE**

### Claude's response (Round 2)
Verified both against the code before accepting:
- **A CONFIRMED** — order form collects card number (xpizza-orders/index.html:1120), name (:1124), expiry (:1131), CVV (:1136); PixelPay is a **placeholder** (`PIXELPAY_KEY`/`PIXELPAY_ENDPOINT = 'YOUR_..._HERE'`, :1227-1228), `payment_status: 'pending'` set client-side (:2104). Codex slightly overstated "posts to /api/pixelpay-charge if configured" (it's an unconfigured placeholder), but the substance — cardholder-data handling, PCI scope, demo-in-production, client-set payment state — is valid and important.
- **B CONFIRMED** — `key=AIzaSy…D_Y0A` public at :1210 (Maps JS + Places), unrestricted-key billing-abuse risk.

**Accepted both.** Changes to PLAN.md:
- Added a dedicated **Payment flow + PCI** deep section (§4a): card-data collection/handling, PixelPay placeholder/demo state, client-settable `payment_status` spoofing, backend endpoint presence/absence, whether card data is logged/stored, PCI scope, and whether dispatch/drivers trust `payment_method` as proof of payment. Flagged as a likely high-severity finding.
- Added **API-key restriction review** (referrers, enabled APIs, quotas, billing caps) to §6 and the out-of-repo checklist.
- Updated headline/risks to note the payment surface.
No rejections. Proceeding to Round 3 (MAX_ROUNDS cap).

---

## Round 3 — Codex (final)
Thread: 019ea382-c5e4-7571-b4d0-46e5b4aad152 (resumed) · read-only

Finding A (payment/PCI) addressed — §4a covers client-set payment state, cardholder-data handling, PCI scope, and charge-endpoint presence/absence, with the uncertainty carried into risks. Finding B (public Maps key) addressed — referrer restrictions, enabled-API minimization, quotas, billing caps, and review of every browser-embedded key. No remaining material coverage gap; plan is comprehensive enough to execute as a static audit with clear labels for what static review cannot prove.

**VERDICT: APPROVED**

### Convergence
Act 2 complete after 3 rounds (Round 1 REVISE → Round 2 REVISE → Round 3 APPROVED). 14 distinct gaps found and folded in (12 in R1, 2 in R2); 3 highest-impact claims per round verified directly against the code; 0 rejections. Awaiting user sign-off before executing the audit. No code written.
