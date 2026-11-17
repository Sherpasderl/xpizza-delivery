// The «reward group» refusal layer on RGB_BASE (eb3d1cb9c, asm10 main): review.js's code table gains reward_group_add_blocked — 5f
// bd0157bdd (Codex #119 P2), the approved copy (advisor 11-16) — and nothing else, [now, was] per file. Folded out FIRST by
// portalui-guards (the newest layer, above REND), so REND, RP and every older pin judge exactly what they judged before. Regenerated only
// from the change's diff; an edit outside this hunk, or inside it, fails.
export const RGB_BASE = 'eb3d1cb9c';
export const RGB_FOLD = {
 "review.js": [
  [
   "  extras_catalog_not_supported_yet: { icon: 'info', title: 'Agregar extras todavía no está disponible',\n    detail: 'Tus otros cambios siguen acá.',\n    action: { id: PUBLISH_ACTIONS.FIX, label: 'Entendido' } },\n  // 5f bd0157bdd (Codex #119 P2): a NEW extra in a group that feeds a reward picker while the legacy forms remain (400, field extras)\n  reward_group_add_blocked: { icon: 'info', title: 'Este grupo se usa para recompensas, así que por ahora no podés agregarle extras nuevos.',\n    detail: 'Tus otros cambios siguen acá.',\n    action: { id: PUBLISH_ACTIONS.FIX, label: 'Entendido' } },\n",
   "  extras_catalog_not_supported_yet: { icon: 'info', title: 'Agregar extras todavía no está disponible',\n    detail: 'Tus otros cambios siguen acá.',\n    action: { id: PUBLISH_ACTIONS.FIX, label: 'Entendido' } },\n"
  ]
 ]
};
