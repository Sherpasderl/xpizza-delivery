# Sucursales 1b — side-by-side vs the approved canvas v25 (heavy slot 2026-10-26, step 2)

**Capture.**
- Mockup: `SucV2e` (canvas CvvXXuDUijMvA1pRZ4L2rd, version 1793023555-a08b), rendered by the canvas's own `dc-runtime.js`. That file isn't committed (it is the type's vendored runtime); fetch it with the Artifact tool, `read` path `artifact-type/dc-runtime.js`, and save it as `review/portal-1b/mockup/support.js`.
- Build: the real `xpizza-portal/index.html`, with every real module and `styles.css`. Only `firebase.js` / `auth.js` / `invite-mail.js` are stubbed, and `fixture.js` answers the Functions calls with the frames' sample data.
- Browser: headless Chrome over CDP, at 1280 and 390 wide.
- Output: `shots/{frame}.{width}.pair.png`, 17 frames × 2 widths = 34 pairs, approved left and build right. `index.html` shows them all.

Run: `node review/portal-1b/shoot.mjs`.

**Result after the in-slot fix commit (52de0ad3): 0 BUG, 0 UNSURE.**

## BUG — found on the first capture, fixed in 52de0ad3, re-captured

| # | Frame | Difference | Fix |
|---|---|---|---|
| 1 | S2 | The cards were ordered by name. The frame orders them live → Desactivada → Por activar → drafts. | `listOrder` |
| 2 | S2–S11 (nav) | The «Sucursales» count was 4 while the list showed 5 cards. The frame counts the drafts. | The count includes the brand's drafts with W on (owner); W off stays 1a. |
| 3 | S8 / S8b | The checklist was one column; the frame draws two. | `.brows1b` is a 2-column grid (one column at 390). |
| 4 | S9a | The pre-selected chip didn't show as selected (CSS specificity). | `#sucmodal .chip1b.chipon1b` |
| 5 | S3 / S9a | A valid WhatsApp stayed as typed («3390 5521»). The frame shows «+504 3390-5521». | Formatted once the field is left; an invalid value is kept as typed. |
| 6 | s2-empty | The second line rendered in ink, about 20px high. | Dedicated classes, muted, with the frame's spacing. |

## Approved-truth deviation (advisor rulings, plan §2f T1–T8 / B1–B7)

| Frame(s) | Frame shows | Build shows | Ruling |
|---|---|---|---|
| S3, S5, S7, S11a | Pill «Ocupada +15 min», button «Ocupado / Pausa» | 1a pill (Abierta / Pausada / …), «Pausar pedidos» | T1 (slice-1 P1-10 / Q2) |
| S3, S5, S8, S9b, S11a | Prep help «…que ve el cliente…», fnote «(−5 … +15) y el modo Ocupado suma encima» | 1a D3 strings | T2 |
| S3, S5, S8, S11a; S2 cards | «Último pedido» + «Próximo», «La numera Sherpa; no se puede reiniciar…»; cards «Próximo #N» | «Último pedido de hoy», «La numeración la lleva Sherpa.»; drafts unnumbered | T3 / B2 (1a D12) |
| S3, S5, S8, S11a | Zone fnote «Si la zona de dos sucursales se cruza…» | Dropped | T4 (O2 dark) |
| S3, S8, S9b, S11a | «Lo ve el cliente: «Tu pedido lo prepara …»» | Dropped | T5 (no reader) |
| S8, S8b, S8c | Code column «… [pendiente]», «provisional» notes | Dropped | T8 (mockup annotations) |
| S2, s2-empty, s2-onedraft | Legend «Abierta / Ocupada / Pausada recibe pedidos según su horario» | Segment dropped | B1 |
| S2 | «… · desactivada el 12 oct» | «… · desactivada» | B3 / E-i ruling (B) |
| S2 | «Le falta: el horario de sábado y domingo · un equipo vinculado.» | «Le falta: horario de los 7 días · al menos un equipo vinculado.» | B4 |
| S8 | «Marcela Pineda (dueña)», «Pizzería Del Valle · 8 productos» subs | No sub | B5 |
| S9a | «Definir después» chip | Absent | B6 |
| S9a, S10 | Prose «el teléfono» | «el WhatsApp» | D-d (approved 2026-10-25, text-only) |
| S2 title | «v2» annotation chip | Absent | Mockup annotation (T8 class) |

## Data / environment (not a difference in the product)

- **Sample data.** The copy chips list the fixture's siblings: «Bulevar del Norte · Centro · Col. Trejo» on Andes and «Bulevar del Norte · Centro» on Trejo, where the frame shows «Centro · Col. Trejo». The rule is per T6: the same brand's identity rows except this one, with valid hours.
- **Map.** The zone circle radius uses 1a's display scale (radius × 9 px); the frame uses a hand-set sample. The frame's road line renders black under the canvas runtime.
- **Focus.** The confirm modals focus their first button, so a focus ring shows on Cancelar (deliberate). S5's last-typed hour input keeps focus at capture.
- **Footer user.** The stub signs in as «duena@ejemplo.hn».

## Existing 1a / 3a chrome, unchanged by 1b (not in the 1b delta)

- **Sidebar.** Section labels «Menú» / «Operación» / «Negocio»; Ventas sits under Negocio; «Marca» is not registered on this base; the manager has no Ventas (1a A3).
- **Brand switcher sub-line and width.** It shows the scope label (1a). The lifecycle-only shell shows «N sucursal(es)» per the approved Fable choice.
- **Mobile.** The top bar has no account button, and the mobile nav wraps where the frame scrolls (1a).
- **1a components.** The prep stepper's 30px value (the canvas renders the frame's value small), the crumb's 32px touch height, and the «Cambios sin guardar en {name}» bar text weight are all 1a's.
