# Runbook: adding products in the portal ("Agregar producto", Phase A)

Phase A adds **plain** products only: no required choices. A product can be added only to a section the brand's order page shows. Only the restaurant **owner** can add products, at most 20 per publish.

## Before the first deploy (advisor): the drift report
From `xpizza-functions`, read-only:

```
node tools/draft-drift-report.js --project xpizza-delivery
```

From this release on, every save is compared with the published menu. Any row that says `drift` means that brand's saved draft already differs from what is published, and its next price edit would be refused.
- Decide before enabling: either `resetDraftToLive`, or a reviewed publish of that draft.
- `publishable` rows (including unpublished additions) are fine.

## Deploy order (everything before the portal)
1. **RTDB rules:** `/menus/_meta` becomes Admin-only.
2. **Functions:** `createOrder`, `chargeOnlineOrder`, `editCatalog`, `publishEdited`, `getEditableCatalog`, `resetDraftToLive`.
   - The renderer contract ships inside the functions package.
   - Verify the revisions.
3. **The portal (Netlify, manual).**

No form change and no client-floor change. Old and new order pages already show new plain products.

## What happens when a product is published
- New page loads show it after ≤ 30 s (browser cache) / 120 s (shared cache). Pricing instances learn it after ≤ 45 s.
- In that window, an order containing it may get a **retryable** `503 menu_updating` ("El menú se está actualizando — probá de nuevo en un momento"), or today's `400 unknown menu item`. It is **refused, never mispriced**.
- **The kitchen (KDS) Disponibilidad list gets the new row automatically.**
  - If the publish response says `kds_sync_pending`, the portal shows "La cocina se actualizará en unos minutos".
  - Resync it with `node publish-menus.mjs --commit`. It derives the list from the **active** catalog and never overwrites a newer one.

## Rollback after an add
From `xpizza-functions`:
1. **Optional:** pause the brand (c4 "Pausar pedidos") if orders for the product must stop immediately.
2. List the versions, then roll back:

   ```
   node tools/rollback-version.js --project xpizza-delivery --rid=<rid>
   node tools/rollback-version.js --project xpizza-delivery --rid=<rid> --to=<versionId>
   ```

   It also rewrites the kitchen list from the newly active catalog. If it prints a warning, run `node publish-menus.mjs --commit`.
3. **Verify:** `node tools/verify-catalog.js --vs-active`. The active pointer, the kitchen list and the public menu no longer carry the product (≤ 120 s cache).
4. **The saved draft still contains the product, as an unpublished addition.** The owner removes it with **"Quitar"** in the portal, or uses **"Volver al menú publicado"** (`resetDraftToLive`).
5. Resume the brand if it was paused.

**Identity after a rollback:**
- **Certified** target: the added product's identity is **retired**.
- **Uncertified** target: it **stays live** (no reconciliation for uncertified targets, as today).

**Re-adding the same name afterwards:**
- refused ("Ese nombre ya existió en tu menú") when the identity stays live (uncertified target, either brand);
- refused for a **slug** brand (La Musa) even after retirement, because the retired id keeps the slug reserved;
- **allowed** for a **name**-keyed brand (X. Pizza) after a certified rollback, which deletes the key row. The re-added product gets a fresh identity.

**Window:** for ≤ 45 s an instance may still price the removed product. Orders accepted then are normal orders; staff fulfil or cancel them with the existing tools. There is no refund automation.

## Notes for operators
- **`node publish-menus.mjs`** (dry run AND `--commit`) now reads the **active catalog** from Firestore, so it needs credentials (ADC) even for the dry run. The dry run prints, per brand, the active version, the row count and any keys not in the code-derived manifest.
- **`getEditableCatalog` on an invalid stored draft** is still the `503 source_unavailable` it was, but the body now also carries `draft_unpublishable {code, detail}` and `sourceUpdateTime`, which is what "Volver al menú publicado" needs.
- **`resetDraftToLive` is not one of the isolated portal functions:** a cold start loads the full functions bundle. Measured locally (module load, median of 5): about 110 ms isolated vs about 710 ms full, so roughly +0.6 s per cold start of this rarely used recovery action.

## A draft that cannot publish
`getEditableCatalog` reports `draft_unpublishable` (code + reason). The portal then offers **"Volver al menú publicado"**:
- it replaces the saved draft with the published menu, conditional on the revision the owner saw;
- it clears any standing deletion claim;
- it never moves the pointer.

## Rolling the code back
Before any product was added: revert the functions and the portal; no data is involved. After an add: first roll the catalog back as above, then revert the code.
