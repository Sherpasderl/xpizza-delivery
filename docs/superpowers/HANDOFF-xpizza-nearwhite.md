# HANDOFF → order-form executor session — X. Pizza near-white + enhanced photos

**What:** Move the **X. Pizza** order form from warm cream to near-white `#FCFCFB` + swap in the owner's enhanced photos. **La Musa stays cream, byte-identical.** Owner-approved (end-state mockup: https://claude.ai/code/artifact/e76345ce-16c7-40f4-8a91-e44ea2f81ef6). Pure color-token + image-asset change; NO logic/money-path.

**Branch:** `feat/xpizza-nearwhite` (tip = design docs, off live `main` `4b64e80`). Check out fresh.

**Read (on the branch):**
- Spec (codex design-gate APPROVED R2): `docs/superpowers/specs/2026-07-26-xpizza-nearwhite-design.md`
- Plan (6 tasks, exact tokens/values): `docs/superpowers/plans/2026-07-26-xpizza-nearwhite.md`

**Order of work (the gate hinges on Task 1 first):**
1. **Task 1 — COMPLETE warm-literal inventory + classify** every hex SWAP / KEEP-EXACT / TEXT (commit the inventory doc). This is the auditable control before touching the shared account.js. Missed literal = stray cream on X. Pizza.
2. Task 2 — X. Pizza `index.html` ground tokens → near-white.
3. Task 3 — core cards get a small default shadow (borders alone are ~1.2–1.4:1 on near-white = too weak) + mobile visual QA.
4. Task 4 — `account.js` `CONFIG.palette` (per-brand): X. Pizza near-white, **La Musa palette = exact current literals**. Prove La Musa byte-identical THREE ways (code-diff past CONFIG + zero-stray-warm grep + computed-style render diff).
5. Task 5 — copy the 16 enhanced JPEGs from `/Users/xavierlacayo/Downloads/xpizza-images/Enhanced/` over `xpizza-orders/images/` (same filenames). No CSS filter.
6. Task 6 — a11y (no required label on `#B3A594`) + final proofs + push.

**Hard lines:**
- **La Musa byte-identical** — `la-musa-orders/index.html` UNTOUCHED; `la-musa-orders/account.js` renders exactly as today (its `CONFIG.palette` = current literals); La Musa images untouched. This is the safety line the gate checks.
- `account.js` **CODE identical past the CONFIG block** between forms — only CONFIG (now incl. `palette`) differs.
- **This batch DOES edit `xpizza-orders/index.html`** (that's the point) — but NOT `la-musa-orders/index.html`.
- No money-path/logic change. No CSS photo filter (enhanced files carry the brightness). No cheap emoji.

**FILE COORDINATION:** advisor is NOT editing these files — you are the SOLE editor on this branch. Advisor reads + runs codex-on-diff only. Push the branch, report the tip SHA. Do NOT deploy/merge/run codex. On APPROVED, owner deploys (Netlify CLI per-folder: xpizzaorders 6f09559f / lamusaorders f8bac377 — NOTE: only xpizza-orders changes; La Musa deploy is a no-op but harmless if run).
