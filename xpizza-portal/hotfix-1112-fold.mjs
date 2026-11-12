// LIVE HOTFIX 2026-11-12 (hotfix/portal-ux-1112): the photo uploader's op_id is `op_…`, never `op:…` (the server's OP_ID_RE refused
// the colon — every upload start was 400). The fix's EXACT hunk, [now, was], cut against HF_BASE (main at the hotfix). The NEWEST layer:
// portalui-guards folds it out at the very lowest read, so every older pin judges exactly what it judged before; its own cell pins it.
export const HF_BASE = '6de78614';
export const HF_FOLD = {
 "app.js": [
  [
   "  // LIVE 2026-11-12: `op_`, never `op:` — the server's OP_ID_RE (photos/upload-start.js) is [A-Za-z0-9_-]{8,64} (portal-request-ids.test)\n  newOpId: () => `op_${(globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`,\n",
   "  newOpId: () => `op:${(globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`}`,\n"
  ]
 ]
};
