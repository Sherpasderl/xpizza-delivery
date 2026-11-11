// S1c MINT panel (advisor 11-11: mint_unavailable's designed RETRY panel, for the MINT_OPAQUE flip bbd11fc3): the change's EXACT
// hunks, [now, was] per file, cut against MINT_BASE (origin/main it is built on). Folded out FIRST by portalui-guards (the newest
// layer), so every older pin judges exactly what it judged before; an edit outside these hunks, or inside one, fails.
export const MINT_BASE = '9269859d';
export const MINT_FOLD = {
 "review.js": [
  [
   "  // S1c opaque minting (advisor 11-11): a new product's minted key collided — TRANSIENT (the server says retryable), so the same\n  // draft is simply sent again\n  mint_unavailable: { icon: 'warn', title: 'No pudimos guardar el producto nuevo',\n    detail: 'Fue un problema momentáneo. Intentá de nuevo.',\n    action: { id: PUBLISH_ACTIONS.RETRY, label: 'Reintentar' } },\n",
   ""
  ]
 ]
};
