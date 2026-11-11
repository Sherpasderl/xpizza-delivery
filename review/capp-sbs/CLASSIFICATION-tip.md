# Tip step — side-by-side vs the APPROVED tip mockup (PLAN-capp-tip-step r7)

Run: `node review/capp-sbs/sbs.mjs --set tip --pkg <package-capp web @ca376ccc>` · 5 scenes × light/dark = 10 renders · 0 unmapped requests · contrast fails 0.
Frame 5 (cash settlement) is SUPERSEDED by the owner's card-only decision (11-09) and is not rendered.

| scene | diff | classification |
|---|---|---|
| tip-1-default (L 20 preselected) | 3.2 % | DATA: totals (fixture cart L 294 vs mockup L 565). MINOR: footer block ~8 px higher than mockup |
| tip-2-sin-propina | 3.3 % | same as tip-1 |
| tip-3-otro-sheet | 2.1–2.7 % | MINOR: sheet top ~6 px higher than mockup; content identical |
| tip-3b-otro-saved («Otro · L N», chip.two) | 3.3 % | same as tip-1 |
| tip-4-member-last (last tip L 40) | 3.2 % | same as tip-1 |

No STRUCTURE / COPY / COLOR differences. Copy, chip set, payline («Total L X · Se cobra al recibir tu pedido.» + «Más información»), card row and CTA match the mockup in both themes.
