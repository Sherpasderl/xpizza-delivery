# «Marca» + F-2 notice — side-by-side classification (portal-ui slot, 2026-11-08)

Build: `feat/portal-marca` (tip after this review's fixes). Targets: the owner-approved mockups R1pshGArpS5Af2tzcdCvTW («Marca») and ENrjdkJmw3mzy9PkFCy4D1 (notice), copied to `./mockup`. Headless Chrome over CDP, the REAL portal (index.html, its modules, styles.css; firebase/auth/invite-mail stubbed; `fixture.js` answers the Cloud Functions in the server's shapes). 8 frames × light + dark = 16 pairs, each `shots/{frame}.{theme}.pair.png` = mockup | build | 50 % overlay. Run: `node review/portal-marca/shoot.mjs`.

## Found and FIXED in this review (2 BUGs)

| # | Frame | Defect | Fix | Proof |
|---|---|---|---|---|
| 1 | B1, B2, B3, P1 | Every field below «Nombre de la marca» sat 7 px low per field (14 px by «Logo»): each field carried an EMPTY error slot `<div>`, and `.fld`'s 7 px flex gap counted it | `mk-errslot` class + `.mk-errslot:empty{display:none}` | Reshoot: text bands at «COLOR DE LA MARCA» / «LOGO» are row-identical to the mockup at 1280 and 390 |
| 2 | N1, NP1 | «Cambiar nombre» was drawn and CLICKABLE while Sherpa updates (the mockup draws none; the notice says nothing can be saved) | no rename control while `platformPending`; `renameStart` / `renameSave` refuse at admission | platform-notice cell «no «Cambiar nombre» while Sherpa updates» (named sections; non-vacuity: unflagged → the control is back); mutant G15 KILLED (F-2 sweep 15/15) |

Harness fix: B4's build was blank (the CDP clip is in document coordinates; the frame scrolls) — it now clips at the scroll offset.

## Per frame (after the fixes)

| Frame | Verdict | Remaining differences |
|---|---|---|
| B1 · default | MATCH | INTENDED: no logo uploader (`LOGO_ENABLED = false`, M2 — the logo lands with NEXT2 + Part A's frame), so «Para recoger» and below move up by the uploader's height. SHELL: the branch chip («+ Todas las sucursales») is today's shell control, unchanged by this slice. |
| B2 · edited | MATCH | INTENDED (M2): no uploaded logo, so the preview keeps the monogram and the save line reads «color, nota.» (the mockup's «color, logo, nota.»). |
| B3 · saved | MATCH | Toast «Marca guardada» in the mockup's position; the fixture recorded exactly one POST {brand_id, expected_version: 1, fields} — the contract. INTENDED (M2) as B2. |
| B4 · Datos de Sherpa | MATCH | Panel content identical; it sits ~24 px lower because the page is shorter without the uploader and the scroll clamps at the bottom (consequence of M2). |
| P1 · 390 | MATCH | INTENDED (M2) as B1. Nav pills and header identical. |
| N1 · notice | MATCH (1 item for the advisor) | PRE-EXISTING chrome the notice mockup's simplified builder never drew (also absent from its BEFORE frame): the «AGOTADOS AHORA» branch strip; the section header's «Agregar producto», shown in its existing OFF state (disabled — the state the approved annotation names); the dashed photo placeholders (the read-only photo state); the «Marca» nav entry (this branch). **Advisor:** keep the header «Agregar producto» disabled (my reading of the approved text), or hide it while pending? Hiding it touches only the pending state. |
| N2 · refused reset | MATCH | Panel identical in both themes. |
| NP1 · 390 | MATCH | As N1. SHELL: the mockup's phone nav pills are drawn taller than today's shell (the «Marca» mockup's P1 and the build agree with each other). |

Dark: checked on every frame; same verdicts.
