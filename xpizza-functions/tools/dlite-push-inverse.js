'use strict';
// dlite-push — the test-only INVERSE of the dispatch-lite iOS push-refresh slice (hot-file invariant,
// see memory index-js-inverse-fold-invariant). Every hunk this slice made to xpizza-functions/index.js, put
// back to its 32f6f17e text, so the *-wiring.guard fold chains reconstruct their frozen bases. Proof (i):
// unapplyDlitePushIndex(index.js) === 32f6f17e:index.js byte-for-byte (dlite-push-wiring.guard). Each candidate
// hunk must occur EXACTLY once, else this throws. Hunks: the require line (+ staffPushCleanupUpdater, + the
// test-push-core require), the sendStaffPush compare-and-delete removeSub, and the whole sendTestStaffPush export.
// GENERATED from `git diff 32f6f17e -- index.js`; JSON-quoted strings. In the next train (stacked on 798f9edf = release-race +
// brand-agnostic server) the SAME hunks restore 798f9edf:index.js byte-for-byte; the guard pins that base.

const HUNKS = [
  [
    "const { coalesceDecision, formatNewOrder, formatGrouped, pushWithCleanup, staffPushCleanupUpdater, isStuck, stuckDedupe, formatStuck } = require('./staff-push');\nconst { runTestStaffPush, testPushRateUpdater, TEST_PUSH_MIN_INTERVAL_MS } = require('./test-push-core');",
    "const { coalesceDecision, formatNewOrder, formatGrouped, pushWithCleanup, isStuck, stuckDedupe, formatStuck } = require('./staff-push');"
  ],
  [
    "      // Compare-and-delete: only drop the node if it STILL holds the subscription we just sent to. A concurrent\n      // client refresh may have rotated to a fresh endpoint between our read and this cleanup — never delete that\n      // replacement. Transaction is atomic across instances; a rejection is swallowed by pushWithCleanup.\n      removeSub: () => db.ref(`staff_push/${uid}`).transaction(staffPushCleanupUpdater(sub && sub.endpoint)),\n",
    "      removeSub: () => db.ref(`staff_push/${uid}`).remove(),\n"
  ],
  [
    "// sendTestStaffPush — dispatcher self-test: send ONE push to the CALLER's own staff_push subscription so a\n// dispatcher can confirm the phone actually DISPLAYS it (a 2xx only means Apple accepted it). Dispatcher ID\n// token ONLY (never the RECON_SECRET path, never a target from the request); per-uid limit of 1 per 30 s,\n// failing closed. The pure auth/limit/result logic lives in test-push-core.js; this wires the real RTDB\n// transaction + sendStaffPush into it.\nexports.sendTestStaffPush = onRequest(\n  { region: 'us-central1', cors: true, timeoutSeconds: 30, memory: '256MiB', maxInstances: 3 },\n  async (req, res) => {\n    if (req.method !== 'POST') { res.set('Allow', 'POST'); return res.status(405).json({ error: 'Method Not Allowed' }); }\n    const auth = await authorizeDispatcherActionWithUid(req);\n    const db = getDatabase();\n    const out = await runTestStaffPush({\n      auth,\n      rateLimit: async (uid) => {\n        const now = Date.now();\n        const txn = await db.ref(`staff_push_test/${uid}/last_test_at`).transaction(testPushRateUpdater(now, TEST_PUSH_MIN_INTERVAL_MS));\n        if (txn.committed) return { allowed: true, retryAfterSec: 0 };\n        const last = txn.snapshot.val();\n        const retryAfterSec = (typeof last === 'number')\n          ? Math.max(1, Math.ceil((last + TEST_PUSH_MIN_INTERVAL_MS - now) / 1000))\n          : Math.ceil(TEST_PUSH_MIN_INTERVAL_MS / 1000);\n        return { allowed: false, retryAfterSec };\n      },\n      send: (uid, payload) => sendStaffPush(db, uid, payload),\n    });\n    if (out.retryAfterSec) res.set('Retry-After', String(out.retryAfterSec));\n    return res.status(out.httpStatus).json(out.body);\n  }\n);\n\n",
    ""
  ]
];

function unapplyDlitePushIndex(src) {
  let out = src;
  for (const [now, was] of HUNKS) {
    const i = out.indexOf(now);
    if (i < 0 || out.indexOf(now, i + 1) !== -1) throw new Error(`dlite-push-inverse: hunk not found exactly once: ${now.slice(0, 80)}`);
    out = out.slice(0, i) + was + out.slice(i + now.length);
  }
  return out;
}

module.exports = { unapplyDlitePushIndex, HUNKS };
