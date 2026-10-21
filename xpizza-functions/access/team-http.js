'use strict';
// PLAN-portal-membership (codex build r1 P1-1) — the deployable team endpoints: thin onRequest wrappers over the tested core
// (access/team-http-core.js). CORS = the portal origins. index.js re-exports each by name in its /* membership:begin team */
// block. Every write is DARK until platform_config/membership_writes_enabled === true.
const crypto = require('crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { getDatabase } = require('firebase-admin/database');
const { getAuth } = require('firebase-admin/auth');
const { PORTAL_ORIGINS } = require('../portal/origins');
const { handle, ROUTES } = require('./team-http-core');

const deps = () => ({
  db: getDatabase(),
  verifyIdToken: (t) => getAuth().verifyIdToken(t),
  now: () => Date.now(),
  randomToken: () => crypto.randomBytes(16).toString('base64url'),   // 128-bit invite id (22 chars)
});
const endpoint = (name) => onRequest(
  { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 30, memory: '256MiB', maxInstances: 5 },
  async (req, res) => {
    try {
      const out = await handle(name, deps(), req);
      return res.status(out.status).json(out.body);
    } catch (e) {
      console.error(name, e && e.message);
      return res.status(500).json({ error: 'error' });
    }
  },
);

module.exports = Object.fromEntries(Object.keys(ROUTES).map((n) => [n, endpoint(n)]));
