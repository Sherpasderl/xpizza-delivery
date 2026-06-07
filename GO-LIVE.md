# X Pizza — Go-Live Checklist
_Pre-launch hardening (v1.8.0). Created 2026-06-07. Tracks PR #1 (`security/pre-launch-hardening`)._

## Already done & verified live
- [x] **Cloud Functions deployed** — `createOrder` (server-side total recompute + input sanitization + rate limiter + `maxInstances`), `blockPublicSignup`, stacking auto-assign fix. *(Deployed from the branch; identical to what's in the PR.)*
- [x] **Identity Platform enabled** + `blockPublicSignup` wired to `beforeCreate` — **probe-verified**: non-staff signup blocked, staff allowed.
- [x] **RTDB security rules deployed** — driver task-theft branch removed; reconciled (live == repo).
- [x] **Order intake verified** — direct POST returns 200 fast with CORS; orders flow to dispatch/KDS/driver.

> The only things NOT live yet are the **client-side** changes — Netlify deploys from `main`, so they go live when PR #1 merges.

---

## 1. Merge PR #1 → `main`
- [ ] Review the diff on GitHub, then **merge** `security/pre-launch-hardening` → `main`.
  - Makes `main` the source of truth (matches the already-deployed functions) **and** triggers Netlify to rebuild every static app.

## 2. Confirm Netlify rebuilds (these carry the not-yet-live client fixes)
- [ ] **order form** — resilient submit (retry on transient failure, idempotency-safe)
- [ ] **dispatch** — picker order-counts + confirm-to-override stacking guard *(auto-assign already enforces the policy; this makes the manual UI match)*
- [ ] **kitchen** — XSS escaping
- [ ] **driver** + root `index.html` — `tel:` href escaping
- Functions need **no** redeploy (already running this code). *Optional:* `npm run deploy` from `main` later for clean provenance.

## 3. Post-merge smoke checks (~2 min)
- [ ] Place one order → reaches the **success screen** (resilient form).
- [ ] In dispatch, open the assign picker → each driver shows **"1 pedido / 2 pedidos · lleno"**; assigning a 2nd to an `assigned`/`at_restaurant` driver is 1-click; a **full** or **en camino** driver pops the confirm-to-override.

---

## 4. 🔴 Renew UltraMsg (WhatsApp)
- [ ] Reactivate the instance (currently *"Stopped due to non-payment"*). Until then customers get **no** order messages (recibido / en camino / entregado). Orders still work — the send is caught.
- [ ] After renewing: test order → confirm the WhatsApp actually arrives.

## 5. Rotate secrets (do pre-launch — zero customer impact)
The order secret lives in **two** places that must match (function env + client HTML), so change both together:
- [ ] Pick a new value: `openssl rand -hex 32`
- [ ] Set it in **both**:
  - `xpizza-functions/.env` → `MAKE_SECRET=<new>`
  - `xpizza-orders/index.html:1226` → `ORDER_SECRET = '<new>'`
- [ ] Deploy both:
  ```bash
  cd xpizza-functions && npm run deploy     # function picks up new MAKE_SECRET
  git add -A && git commit && git push      # Netlify rebuilds the form
  ```
  *(brief mismatch window between the two deploys — fine while pre-launch)*
- [ ] Rotate `WHATSAPP_WEBHOOK_SECRET` in `.env` + update the UltraMsg webhook config.

## 6. Restrict the Maps API key
- [ ] Google Cloud console → the Maps key (`xpizza-orders/index.html:1210`) → HTTP-referrer allowlist (your domains) + restrict to Maps JS/Places + set a **billing cap**.

## 7. PixelPay (the 2–3 day integration)
- [ ] Integrate with **tokenization / hosted fields** so PAN/CVV never touch your code (avoids PCI scope).
- [ ] Remove the demo `payment_status='confirmed'` shortcut; downstream should trust `payment_method:'online'` only with a verified `payment_reference`.

---

## Reference
- Full findings + severity: `AUDIT-FINDINGS.md`
- Release notes: `VERSION.md` (v1.8.0)
- Rules deploy: `npm run deploy:rules` (from `xpizza-functions/`)
- Re-verify signup is blocked (after deploy): POST `accounts:signUp` with a non-staff email → expect `BLOCKING_FUNCTION_ERROR_RESPONSE` ("Account creation is restricted to X Pizza staff").
