'use strict';
// PORTAL-UI 1a (PLAN-portal-ui-slice1-sucursales r5 §6) — the merchant-portal BRANCH-OPERATIONS HTTPS functions (1a: five; slice 2: + getBranchDevices, revokeBranchDevice), isolated.
// Loaded two ways: by index.js's ops early branch when FUNCTION_TARGET is one of PORTAL_OPS_TARGETS (only this group loads), and by
// index.js's full load (Object.assign onto its exports, so emulator / deploy discovery see all five). Thin wrappers only:
// every decision is in portal/ops-core.js. The dependency closure of this file is pinned EXACTLY by
// portal/ops-split.test.js (no catalog-publish, stats, factura, portal-reads, merchant-orders, index.js).
require('../lib/admin');   // the ONE Admin app — before any module that may touch it, as in index.js
const crypto = require('crypto');
const { onRequest, HttpsError } = require('firebase-functions/v2/https');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { PORTAL_ORIGINS } = require('./origins');
const { withPreflightMaxAge } = require('./preflight-max-age');
const C = require('./ops-core');

const PORTAL_OPS_TARGETS = Object.freeze(['getMyBranches', 'updateBranch', 'setBranchPause', 'getBranchAvailability', 'setBranchAvailability', 'getBranchDevices', 'revokeBranchDevice', 'createBranchDraft', 'updateBranchProfile', 'setBranchActive', 'deleteBranchDraft']);
const verifyIdToken = (t) => getAuth().verifyIdToken(t);

function handler(name, core, deps) {
  return async (req, res) => {
    try {
      const out = await core(deps(), req);
      return res.status(out.status).json(out.body);
    } catch (e) {
      console.error(name, e && e.message);
      return res.status(500).json({ error: 'error' });
    }
  };
}

const READ_OPTS = { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 20, memory: '256MiB', maxInstances: 10 };
const WRITE_OPTS = { region: 'us-central1', cors: PORTAL_ORIGINS, timeoutSeconds: 30, memory: '256MiB', maxInstances: 10 };

exports.getMyBranches = onRequest(READ_OPTS, handler('getMyBranches', C.getMyBranchesCore,
  () => ({ db: getDatabase(), verifyIdToken })));

exports.updateBranch = onRequest(WRITE_OPTS, handler('updateBranch', C.updateBranchCore,
  () => ({ db: getDatabase(), verifyIdToken })));

exports.setBranchPause = onRequest(WRITE_OPTS, handler('setBranchPause', C.setBranchPauseCore,
  () => ({
    db: getDatabase(),
    verifyIdToken,
    now: () => Date.now(),
    timestamp: () => ServerValue.TIMESTAMP,
    newOpId: () => `oc_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`,   // the handheld's op-id shape
  })));

exports.getBranchAvailability = onRequest(READ_OPTS, handler('getBranchAvailability', C.getBranchAvailabilityCore,
  () => ({ db: getDatabase(), fs: getFirestore(), verifyIdToken })));

exports.setBranchAvailability = onRequest(WRITE_OPTS, handler('setBranchAvailability', C.setBranchAvailabilityCore,
  () => ({ db: getDatabase(), fs: getFirestore(), verifyIdToken, timestamp: () => ServerValue.TIMESTAMP })));

// PORTAL-UI slice 2 (PLAN-portal-ui-slice2-equipos r1.1 §3): Equipos — list the linked handhelds; revoke one (the H1 core,
// unmodified) and, when it was a 'handheld' branch's last device, pause the branch through the same writer as E3.
exports.getBranchDevices = onRequest(READ_OPTS, handler('getBranchDevices', C.getBranchDevicesCore,
  () => ({ db: getDatabase(), verifyIdToken })));

exports.revokeBranchDevice = onRequest(WRITE_OPTS, handler('revokeBranchDevice', C.revokeBranchDeviceCore,
  () => ({
    db: getDatabase(),
    verifyIdToken,
    adminAuth: getAuth(),
    HttpsError,
    now: () => Date.now(),
    timestamp: () => ServerValue.TIMESTAMP,
    newOpId: () => `oc_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`,
  })));

// ORCHESTRATION O1b (PLAN-orch-o1b r3 §2): the branch-LIFECYCLE endpoints of slice 1b — E6 / E7 / E8 / E10, thin wrappers over
// portal/branch-lifecycle-core.js (write gate, authorization, the O1a writers, publish after commit).
const L = require('./branch-lifecycle-core');
const lifecycleDeps = () => ({ db: getDatabase(), verifyIdToken, now: () => Date.now() });
exports.createBranchDraft = onRequest(WRITE_OPTS, handler('createBranchDraft', L.createBranchDraftCore, lifecycleDeps));
exports.updateBranchProfile = onRequest(WRITE_OPTS, handler('updateBranchProfile', L.updateBranchProfileCore, lifecycleDeps));
exports.setBranchActive = onRequest(WRITE_OPTS, handler('setBranchActive', L.setBranchActiveCore, lifecycleDeps));
exports.deleteBranchDraft = onRequest(WRITE_OPTS, handler('deleteBranchDraft', L.deleteBranchDraftCore, lifecycleDeps));

for (const name of PORTAL_OPS_TARGETS) exports[name] = withPreflightMaxAge(exports[name]);

Object.defineProperty(exports, 'PORTAL_OPS_TARGETS', { value: PORTAL_OPS_TARGETS, enumerable: false });
