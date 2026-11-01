# Dish photos B — side-by-side classification

Build: `feat/portal-dish-photos-b` (base bd777b6d). The approved mockup is `MOCKUP-portal-dish-photo.html` (owner-approved 2026-10-26, copied to `./mockup`). It is compared with the REAL portal (`xpizza-portal/index.html`, real modules and `styles.css`; only auth / firebase / invite-mail are stubbed). The Cloud Functions calls and the signed PUT are answered by `fixture.js` in the §2.2 shapes.

- **Coverage:** 23 frames × light + dark = 46 pairs. Each pair is mockup | build | 50 % overlay: `shots/{frame}.{theme}.pair.png`, listed in `index.html`.
- **Frames:**
  - Desktop 1280: P1, the P1 «Nuevo producto» inset, P2, P3, P4, P5, the P5 no-photo inset, P6a/b/c, P7, the P7 removal inset, the P7 row inset, P8, the P8 no-seal inset, P9, P10a, P10b.
  - Phone 390: P1, P1 cajón, P2, P3, P7.
- **Dark:** set the way the theme toggle sets it (`data-theme="dark"` on both pages; both ship `data-theme="light"`).
- **⚠️ UNCONFIRMED:** the public bucket name `xpizza-delivery-photos` (A0 has not created it). The captures do not depend on it; the CSP and its test pins do.
- **Review:** the advisor reviews the 46 overlays before any MATCH counts. The verdicts below are mine.

## The photo delta — every new piece, per frame

| Frame | Element | Verdict | Note |
|---|---|---|---|
| P1 | Row camera «Subir foto» (50×50, dashed, camera); drawer «Foto» field first, `.uploader` zone with «Subí una foto» + limits | MATCH | light + dark |
| P1 inset | «Nuevo producto» drawer: the zone replaces «Foto: próximamente» | MATCH | 1 px vertical offset |
| P2 | Zone focus state (accent border, tint, focus ring) | MATCH | `:focus-visible` |
| P3 | «Ajustar foto» step: segmented control, crop area + grid, hint, Zoom slider, «Vista previa» with the order page's card and detail, Cancelar / Listo | MATCH | See D1 |
| P4 | Dimmed photo, 62 % determinate bar, «Subiendo foto…», «Cancelar» chip | MATCH | |
| P5 | Photo stays + «No se pudo subir la foto.» + Reintentar | MATCH | See D2 |
| P5 inset | No previous photo: red zone + error + Reintentar right-aligned | MATCH | |
| P6a/b/c | `.fld.invalid` red zone + the three messages with the warning icon | MATCH | The mockup draws them at 404 px (three across); the drawer is 452 px |
| P7 | `.uphoto` + «Cambiar» / «Quitar»; row thumb + green draft outline + «Foto sin publicar»; bar «1 cambio sin publicar · 1 foto» | MATCH | The tag wraps under the name when the row is narrow, as drawn |
| P7 removal inset | Empty zone + «La foto actual se quita al publicar.» + «Deshacer» | MATCH | |
| P7 row inset | Dimmed grayscale thumb + outline + «Se quita la foto» | MATCH | Pill positions follow the row width (the mockup inset is 700 px) |
| P8 | «Fotos» group (3), «Foto nueva / cambiada / quitada», 64×48 antes → después thumbs, «Sin foto»; photos seal (header, body, rows, «Autorizo publicar las fotos de estos 3 productos.»), Publicar gated | MATCH | See D3 |
| P8 no-seal inset | The same group; Publicar enabled at once | MATCH | See E5 |
| P9 | Receipt «La foto de «Pepperoni» ya está en el menú publicado.» + Versión v143 | MATCH | See E6 |
| P10a | Same uploader; bar «1 cambio sin publicar · 1 foto · el dueño confirma y publica con la autorización fiscal» | MATCH | See E4 |
| P10b | Published card as a plain thumb (no button / camera / cursor); a dish without one shows no square | MATCH | See E4 |
| 390 P1 / P1 cajón | Rows with the camera; the drawer opens on the plain zone | MATCH | Built after the first shoot (B1) |
| 390 P2 | The same zone, expanded in place: «Tomar foto» (camera, `capture="environment"`) / «Elegir de la galería», each ≥ 44 px | MATCH | Built after the first shoot (B1) |
| 390 P3 / P7 | Crop step and the photo + chips at phone width | MATCH | |

### Differences inside the delta (classified, not bugs)

- **D1 — P3 previews.** The mockup applies its 118 % zoom to BOTH previews. The build applies it to the card only; «Detalle» keeps its own untouched view. That is what the approved hint says («cada uno guarda su posición»). The mockup draws one sample state.
- **D2 — Photo framing.** The mockup positions its sample photos with an inline `object-position:50% 45%`. The build shows the E-P2 card centred (`object-fit:cover`, 50 % 50 %). The CSP forbids inline styles, and the server's crop decides the framing.
- **D3 — P8 bar behind the modal.** The mockup bar reads «3 cambios sin publicar · 3 fotos». In the build the fixture loads the map as already saved (orig = state), so the count is today's «Revisá si hay algo sin publicar». This is sample state; the live-count path is P7/P10a.
- **D4 — Small text colour (AA).** New small text on the card (`.phzl`, `.phpvcap`) uses `--mute`, not the mockup's `--mute2`, which is 4.46:1 in dark — the 1a/1b AA rule. In light the two greys are #6C6C70 vs #6E6E72, so it looks the same.
- **D5 — Order-page shades.** The order page's photo shades are drawn by a real `<i>` element rather than `::after`, because the portal's colour grammar refuses pseudo-element colour sites. The look is identical.

### Bugs found by the side-by-side, fixed

- **B1 — The phone zone.** At 390 the drawer showed the two buttons at once. The mockup draws «P1 cajón» (the plain zone) and P2 (the same zone, expanded) as two states. Fixed: on ≤ 560 px a tap on the zone, or the row camera («con el selector ya abierto»), expands it in place; at 1280 the zone opens the system picker. Pinned by photo-flow «P1 cajón → P2 on a PHONE» and real-Chrome cell 4.
- **B2 — Crop arrow keys (found while writing the Chrome cells).** The arrows moved the frame, opposite to the drag. Fixed: they move the photo like a drag. Pinned by photo-flow «P3 keyboard» and real-Chrome cell 1.

## Existing chrome — not in the photo delta (unchanged by this slice)

- **E1 — Drawer scrim.** The mockup dims the page behind the drawer (`.dscrim.show`). The real editor has never rendered a drawer scrim: the CSS exists, but no element uses it. Unchanged.
- **E2 — Drawer close.** The mockup uses an icon-only ✕ button (`aria-label="Cerrar"`). The real drawer's `.dwx` carries the text «Cerrar» (app.js). The crop step reuses the real drawer head for consistency.
- **E3 — Review bar.** The real portal shows the bar whenever a draft is loaded («Revisá si hay algo sin publicar»); the mockup's P1–P6 omit it.
- **E4 — Manager shell (P10a / P10b).** The manager's shell is scoped to one branch («Mi sucursal», 1a). The read-only list is 1a's: toggles instead of pills, the read-only lede, «Solo lectura» pills, the row chevron to «Disponibilidad por sucursal». The mockup draws the older R1b template. The photo delta in P10b is the thumb only.
- **E5 — Non-fiscal review footer.** The review always appends the attestation container; it stays empty without a seal, so the footer sits about 19 px lower than the mockup's static inset.
- **E6 — Receipt subtitle.** The receipt keeps the review's subtitle («Esto es exactamente lo que cambia…») under «Revisá tus cambios»; the mockup's receipt clears it.
- **E7 — Sample data.** The sidebar user is the stub's `dueno@ejemplo.test` (also on the manager frames). «Especiales» / «Bebidas» items are invented: the mockup draws only their counts.

## Advisor review follow-ups (2026-10-27)

- **R1 — P8 «Volver a editar / Publicar» looks lower.** Measured in Chrome (`getBoundingClientRect`, P8 fiscal, 1280×1000): inside the modal the geometry is IDENTICAL, mockup = build, offsets from the modal's top:

  | Part | Offset |
  |---|---|
  | `.mh` | +1 |
  | `.mb` | +96 |
  | `.seal` | +397 |
  | `.mf` | +712 |
  | Modal height | 785 |

  `.mb` padding is 18/18 in both, and there are no margins on the group or the seal. The only difference is where the modal sits in the capture: the mockup page draws the frame under its caption, while the real scrim centres the modal in the viewport. That is a capture artifact, not a ph* rule, so there is no fix. The ~19 px the eye catches is the NO-SEAL inset (`p8-sinsello`), which is **E5**: today's review always appends the attestation container (`attBox`), which stays empty without a seal. That is existing review chrome, unchanged.
- **R2 — P6a/b/c horizontal misalignment.** Re-cropped both to the zone box (the dashed border + the error line): `shots/p6{a,b,c}.{light,dark}.zone.png`, centred overlay.
  - The zone is 366 px in the mockup (its 404 px three-across artboard) and 415 px in the build (the real 452 px drawer). The difference, 49 px, is exactly the artboard difference.
  - Heights are identical (145 / 144 px). The centred icon, «Subí una foto» and the limits line overlay exactly, in light and dark.
  - The only remaining offset is the left-aligned error line, which shifts with the narrower box; its text is identical. Capture-width artifact, confirmed. MATCH.

## Real-Chrome cells (`chrome-cells.mjs`, PLAN §4.2) — all PASS

1. A pointer drag, two ArrowUp presses and the zoom slider move the rect E-P2 receives (800×600 at 150 % → 533×400; the hero keeps its own view).
2. The progress bar is 62 % in place, with `aria-valuenow`; the review is disabled while uploading; «Cancelar» aborts the XHR and E-P2 never runs.
3. A preview that fails to load triggers exactly one `getEditableCatalog` re-read; a second failure shows the camera, never a broken image.
4. At 390 the plain zone opens first, a tap expands it (two ≥ 44 px buttons, «Tomar foto» = `capture=environment`); at 1280 the zone opens the picker.
5. CSP under netlify.toml's REAL header:
   - no violation: the public `photos/` prefix, the drafts `/drafts/` prefix, `blob:`, and a PUT to `uploads/`;
   - violation: another bucket, virtual-hosted, an order site, `uploads/` as an image, and a PUT to `drafts/` or to another bucket.
