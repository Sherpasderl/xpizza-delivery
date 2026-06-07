# X Pizza Platform — Security & Reliability Audit Findings
_Static, read-only audit · 2026-06-07 · pre-launch (go-live ~2–3 days, test orders only)_

## How to read this
- **Method:** static code + config review only. No live requests, no code changed. Findings
  are "confirmed by reading the code"; exploitability is reasoned, not proven by exploit.
  `[DESIGN-RISK]` = reasoned but needs a runtime/emulator test. `[VERIFY-LIVE]` = depends on
  out-of-repo config (Firebase Auth settings, deployed rules, GCP console) we can't see.
- **Severity** is calibrated to a real ~2-driver shop, counting impact **at launch**.
- **Bucket:** 🔴 *before go-live* vs 🟡 *post-launch hardening*.
- **Scope reconciled:** audited tree == GitHub `origin/main` (one uncommitted line: `createOrder`
  `cors:true` local vs `cors:false` on GitHub). Frontends auto-deploy from `main`; **Cloud
  Functions deploy manually → live functions may differ; confirm the deployed revision.**

---

## ✅ Remediation status — updated 2026-06-07
Progress on branch `security/pre-launch-hardening` (PR #1):

- **P0-3 price tampering** — ✅ **Fixed** (`createOrder` recomputes total server-side). *In PR; redeploy functions to go live.*
- **P0-4 stored XSS into staff screens** — ✅ **Fixed** (server-side field sanitization + output-escaping in kitchen/dispatch/driver). *In PR; redeploy functions + Netlify apps.*
- **P1-6 driver task theft** — ✅ **Fixed AND DEPLOYED 2026-06-07** (`newData` self-grant removed from live RTDB rules; verified live == repo).
- **P1-8 missing/stale rules** — ✅ **Resolved by reconcile**: deployed rules already had `kitchen`/`order_tracking`/`incoming_messages` + kitchen status-write, so **findings F3/F4/F5 below were false positives from the stale repo file**. Repo and production are now identical (deployed 2026-06-07). A CLI deploy path was added (`npm run deploy:rules`).
- **P0-1 public order secret** — ⚠️ **Mostly fixed (in PR)**: `maxInstances` cap + **RTDB-backed rate limiter** (per-phone 4/10min, per-IP 20/10min, fails open). Remaining: **rotate the secret** + optional bot-protection (App Check / Turnstile).
- **P0-2 fake online payment / PCI** — ⬜ Pending: handle tokenized in the in-progress PixelPay integration.
- **P1-5 broad PII reads** (needs coordinated client change), **P1-7 webhook secret in query**, **P1-9 Maps key**, and all 🟡 items — ⬜ Pending.

Deploy state: **rules deployed**; **functions + static apps not yet redeployed** (PR open).

---

## 🔴 Must fix before go-live

### P0-1 · `createOrder` order-intake secret is public; endpoint is effectively open + unthrottled
The bearer secret is shipped to every browser (`xpizza-orders/index.html:1226`, sent `:2220`)
and its sha256 **matches the live `MAKE_SECRET`**. Server compare is a plain `!==`
(`index.js:182`); there is **no rate limiting / maxInstances / abuse cap** anywhere. Anyone can
read the secret and POST unlimited orders → dispatch/kitchen flooding, WhatsApp sends to
attacker-chosen numbers (UltraMsg spend + ban risk), arbitrary `order_id`/fields.
**Fix:** treat `createOrder` as a public endpoint — rotate `MAKE_SECRET` (it's burned), add
rate limiting (per-IP/phone) + bot protection (Turnstile/App Check), keep server-side
validation. · *Confidence: high · refs: index.js:175-185,397-405; Agents B#11, C-F4, D-F1*

### P0-2 · "Pay online" charges nothing but ships as paid (PixelPay is demo code)
PixelPay keys are placeholders (`:1227-1228`), so `processPixelPay()` takes the demo branch
(`:2154-2160`): waits 2 s, sets `payment_status='confirmed'`, submits — **no charge**. Customer
sees "✅ Pago confirmado"; driver app shows `ONLINE` (`xpizza-driver/index.html:1805`) and
collects nothing. Also collects full PAN + CVV (`:1120`,`:1136`) in-page; the production branch
(`:2179`) would POST raw card data to `/api/pixelpay-charge` → PCI SAQ A-EP scope.
**Fix (do this in your 2–3 day PixelPay work):** integrate via **tokenization / hosted fields**
so PAN/CVV never touch your code; delete the demo `confirmed` shortcut; downstream should trust
`payment_method:'online'` only with a verified `payment_reference`. · *Confidence: high*

### P0-3 · Order `total` is client-controlled and never recomputed server-side (price manipulation)
`validateOrderPayload` only checks `total > 0` (`index.js:122-145`); the server stores
`total: asNumber(body.total)` verbatim (`:244`) and never recomputes from items/menu. With the
public secret, anyone can place an order for any quantity at `total: 1`. Item prices in the
payload are equally untrusted.
**Fix:** recompute `total` server-side from a server-held menu price table (item id × qty ×
extras); reject/flag mismatches; store only the server value. · *Confidence: high · Agent D-F2*

### P0-4 · Stored XSS from the public order form into staff consoles
Customer-controlled fields (`customer_name`, `items_text`, `notes`, `customer_phone` — public
form, only `.trim()`) are rendered **raw** into staff screens:
- **Kitchen Display** has *no* escaping at all: `${order.cliente}`, items, `${notes}` →
  `innerHTML` (`xpizza-kitchen/index.html:1134,1140,1142`). **P1.**
- **Dispatcher alert banner**: `${a.customer_name}` raw (`xpizza-dispatch/index.html:2136,2150`)
  — the only unescaped fields in an otherwise-escaped app. Dispatch is the highest-privilege
  client (cancel/reassign/all PII). **P1.**
- **Driver app `tel:` href**: `customer_phone` unescaped (`xpizza-driver/index.html:1880`, root
  `index.html:1488`) → attribute injection. **P2 (cheap — fix in the same batch).**
A malicious order name like `<img src=x onerror=…>` executes in the kitchen/dispatch session.
**Fix:** add `escapeHtml` to the kitchen app and wrap every interpolated customer field;
escape the two dispatch alert lines; `encodeURIComponent` (or digit-strip) the `tel:` value.
**Best leverage:** server-side sanitization in `createOrder` neutralizes all three at the
source. · *Confidence: high · verified directly · Agent C-F1/F2/F3*

### P1-5 · Any authenticated user can read ALL customer PII + live driver GPS  `[VERIFY-LIVE]`
Repo rules use `.read: "auth != null"` on `orders`, `tasks`, `drivers`
(`database.rules.json:39,24,11`); clients read whole collections. Any account on the project —
either driver, kitchen staff, or anyone who can authenticate — can dump the entire customer
database (names/phones/addresses/payment) and all drivers' coordinates. **No per-driver
scoping.** → **P0 if the Firebase project allows anonymous auth or open self-signup** (verify).
**Fix:** scope `orders` reads to dispatchers; give drivers query-scoped read only to tasks where
`assigned_driver_id === auth.uid`. · *Confidence: high (rules) · Agent A-F1*

### P1-6 · Driver can steal/forge any task (field-level rule gap)
Task write is allowed if `newData.assigned_driver_id === auth.uid` (`database.rules.json:27`)
with no field-level locks. A signed-in driver can **self-assign any task** (the `newData`
branch), rewrite `destination`, `total`, recipient PII, `linked_task_id`, or flip `status` to
`completed` without delivering — and stealing the task also grants order `status`/`delivered_at`
writes (`:44-52`). Low population (2 drivers) but real.
**Fix:** drop the `newData` self-grant branch (assignment = dispatcher/function only); add
per-field `.validate` pinning `assigned_driver_id`, `order_id`, `total`, destination/recipient.
· *Confidence: high · Agent A-F2*

### P1-7 · WhatsApp webhook secret travels in the query string → logged / forgeable
`onIncomingWhatsApp` reads `?secret=` (`index.js:1022-1027`); full URLs (incl. the secret) land
in Cloud Run request logs, recoverable by anyone with Logging read. With it, an attacker forges
`message_received` events → arbitrary outbound WhatsApp + full-`/orders` scan. Always-200 means
unthrottled probing.
**Fix:** use the header path, scrub `secret` from logs, rotate the value. · *Confidence: high ·
Agent B#10*

### P1-8 · Repo Firebase rules are incomplete vs what the apps need — reconcile with deployed  `[VERIFY-LIVE]`
`order_tracking`, `incoming_messages`, and `kitchen` have **no rule** in the repo file, yet the
public tracking page reads `order_tracking/{token}` unauthenticated (`xpizza-track:641`), dispatch
uses `incoming_messages`, and the KDS gate reads `kitchen/{uid}`. Also, kitchen status writes
target `orders/{id}/status` which the rules allow only for dispatcher/assigned-driver
(`:44-46`) — so KDS status updates would be denied. Either the **deployed** rules differ from the
repo (most likely, since test orders work) — in which case reconcile the repo file and confirm
the deployed `order_tracking` read is scoped to a single token and leaks no PII — or these
features are broken. **Fix:** pull live rules (`firebase database:get /.settings/rules`),
reconcile, and add scoped rules for the three paths + a kitchen→status write path.
· *Confidence: high (repo gap) · Agent A-F3/F4/F5 + Codex R1*

### P1-9 · Google Maps API key billing exposure — restrict in console  `[VERIFY-LIVE]`
Public Maps key `AIzaSy…D_Y0A` (`xpizza-orders/index.html:1210`). If unrestricted, anyone can
lift it and run up billing. (The Firebase web `apiKey` in the other apps is public by design —
not a finding.) **Fix:** restrict to your Netlify referrers + only Maps JS/Places, set a billing
cap. · *Confidence: high (exposure) · Agents C-F5, D-F4*

---

## 🟡 Post-launch hardening

**Reliability / correctness**
- **Assignment races** `[DESIGN-RISK]` — auto-assign + timeout-reassign are read-then-write, no
  transaction; concurrent accept/assign can double-assign or yank an accepted order
  (`index.js:1472-1500,1636-1662`). *Fix: `transaction()` on the task slot.* (B#1/#3)
- **Stacking cap miscount** — `orderCount = floor(taskCount/2)` undercounts a driver mid-delivery
  (1 active task), letting a 3rd order stack (`index.js:1308`). High-confidence math bug. *Fix:
  count distinct active `order_id`s.* (B#4)
- **Unbounded reads (degrade over time):** full `/orders` scan on every inbound WhatsApp
  (`index.js:1086`) and full `/tasks` scan on every assignment (`index.js:1261`). *Fix: indexed
  queries; archive terminal records.* (B#7/#8)
- **Fail-open kill switches** — WhatsApp/auto-assign default ENABLED on config-read failure
  (`whatsapp.js:114`, `index.js:118,1434`). *Fix: fail-closed + cache last good.* (B#12)
- **createOrder idempotency is TOCTOU** (`:214-219`→`:333`); **3 triggers** all watch
  `/orders/{id}/status` (cost); **Sheets `A2:I1000`** silent row-1000 cliff; **no `maxInstances`**
  on sleep-based functions. (B#5/#9/#16/#19)

**Security hardening**
- **PII in logs** — phone/name/address/message bodies in plaintext Cloud Logging
  (`index.js:938,1076`; `whatsapp.js`). *Fix: redact/last-4.* (B#13)
- **No input length/charset caps** in `createOrder`; `customer_phone` not format-checked before
  use as a WhatsApp target (`index.js:122-146`). (B#18)
- **No security headers / CSP** on any static app (all `netlify.toml` are bare). *Fix: add
  `X-Frame-Options: DENY`, `nosniff`, a CSP.* (D-F3)
- **Missing `.validate`** on `orders`/`config`/`dispatchers` (dispatcher-only writers, so
  defense-in-depth). (A-F6)
- **Error `e.message` returned to caller** in createOrder (`:222,338`); **UltraMsg replies lack
  idempotency** (possible double-reply). (B#14/#15)
- **npm audit:** 1 high (`fast-xml-builder`), 13 moderate (`qs`/`express`, `protobufjs`,
  `uuid`), 1 low — all transitive DoS/parsing, not remotely exploitable here. `npm audit fix`
  clears most; `uuid` needs `firebase-admin@13`. (D-F5)

**Maintainability**
- `xpizza-delivery.js` is **hand-copied 5×** (currently byte-identical — no drift *yet*, but a
  future edit can silently diverge). Root `/` imports a `xpizza-delivery.js` that isn't in the
  repo. *Fix: single shared source.* (C-A)

---

## ✅ Verified positives (don't regress these)
- **Delivery radius enforced server-side** (`index.js:203-208`) — clients can't bypass the zone.
- **Idempotency exists** for duplicate `order_id` (modulo the TOCTOU note).
- **Tracking token** is high-entropy (12 chars / 54-alphabet) and the public tracking record
  stores only name + short address + status (confirm no PII creep).
- **Secret hygiene:** `.gitignore` correct, `.env.example` clean (placeholders only),
  `firebase.json` ignores `.env`; real `.env`/UltraMsg/VAPID values are **not** in git history.
  (Only the `MAKE_SECRET`/`ORDER_SECRET` value is committed — via the client HTML.)
- **No SDK drift** today; **no unawaited promises** in triggers; **constant-time compare** used
  on the WhatsApp webhook (just not on `createOrder`).
- Most apps escape correctly: **track**, **catering**, **dashboard**, and all of **dispatch
  except the 2 alert lines** use `escapeHtml`/`textContent`.

---

## 🔎 Out-of-repo "verify-yourself" checklist (static review can't confirm)
1. **Firebase Auth:** is anonymous auth / open self-signup enabled? (Decides whether P1-5 is P0.)
2. **Deployed RTDB rules vs repo** (P1-8) — pull and reconcile; confirm `order_tracking` read is
   token-scoped and PII-free.
3. **Maps key restrictions + billing cap** (P1-9).
4. **Firebase App Check** on `createOrder` (real defense for P0-1).
5. **Deployed Cloud Functions revision** — confirm it matches this audited code (manual deploy).
6. **GCP IAM** least-privilege on the function service account; **Google Sheet ACL** (who has
   the SA + human edit access); the **external/legacy full-order Sheets ingestion path**
   (Make/Apps Script) and its formula-injection exposure (the in-repo function only writes
   `'Cancelado'` — no injection there).
7. Rotate `MAKE_SECRET`/`ORDER_SECRET` and the WhatsApp webhook secret; delete/ignore untracked
   `run_patches.sh` (holds the secret, not git-ignored → a careless `git add .` would commit it).

---

## Suggested go-live sequence
1. **P0-3 + P0-4** (server-side total recompute + sanitize/escape) — one server change in
   `createOrder` (validate + recompute + length-cap + strip HTML) closes price tampering *and*
   the stored-XSS source in a single place; add the kitchen/dispatch escaping as defense-in-depth.
2. **P0-2** — do the PixelPay integration the tokenized way (it's already on your 2–3 day plan).
3. **P1-5 / P1-6 / P1-8** — fix the RTDB rules together (scope reads, lock driver task fields,
   add the 3 missing paths) and redeploy rules; verify Auth signup setting.
4. **P0-1 / P1-7 / P1-9** — rotate secrets, add rate-limit/bot-protection, restrict the Maps key.
5. Everything 🟡 after launch.
