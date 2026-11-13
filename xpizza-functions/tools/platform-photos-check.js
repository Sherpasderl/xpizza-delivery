#!/usr/bin/env node
'use strict';
/* PRE-DEPLOY (PLAN-photos-public-bucket-config r5 §1): the photos config the functions are about to deploy is present, identical to the
 * canonical repo copy, valid, and carries a verified private bucket for the DEPLOYING project — fail closed. firebase.json runs it as a
 * functions predeploy step after the env guard:
 *   node "$RESOURCE_DIR/tools/platform-photos-check.js" --root "$RESOURCE_DIR" --project "$GCLOUD_PROJECT"
 * (the CLI sets both for hooks). Exit 1 when: no project; the root is not a directory; <root>/platform/photos.json or the canonical
 * <root>/../platform/photos.json is missing; the two differ by one byte; the shape is invalid (photos/photos-config.js validatePhotosConfig,
 * the SAME validator the runtime loader uses — a public "" passes, a private "" fails); no private_bucket entry for the project.
 * It prints FILE names and the project id only — never a bucket value. */
const fs = require('fs');
const path = require('path');
const { validatePhotosConfig } = require('../photos/photos-config');

function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; }
const fail = (why) => { console.error(`platform-photos-check: 🔴 BLOCKED — ${why}`); process.exit(1); };

const root = arg('--root');
const project = arg('--project') !== undefined ? arg('--project') : process.env.GCLOUD_PROJECT;
if (!root) fail('no --root');
let st = null; try { st = fs.statSync(root); } catch (_) { st = null; }
if (!st || !st.isDirectory()) fail(`the functions root ${root} is not a directory`);
if (!project) fail('no deploying project (--project / $GCLOUD_PROJECT)');
const bundledPath = path.join(root, 'platform', 'photos.json');
const canonPath = path.join(root, '..', 'platform', 'photos.json');
let bundled; let canon;
try { bundled = fs.readFileSync(bundledPath); } catch (_) { fail(`${bundledPath} is missing`); }
try { canon = fs.readFileSync(canonPath); } catch (_) { fail(`${canonPath} is missing`); }
if (!bundled.equals(canon)) fail(`${bundledPath} differs from ${canonPath} — run npm run sync:platform and commit both`);
let c; try { c = JSON.parse(bundled.toString('utf8')); } catch (_) { fail(`${bundledPath} is not valid JSON`); }
const v = validatePhotosConfig(c);
if (!v.ok) fail(`${bundledPath} is invalid (${v.reason})`);
if (!Object.prototype.hasOwnProperty.call(c.private_bucket, project)) fail(`${bundledPath} has no private_bucket entry for the deploying project ${project}`);
console.log(`platform-photos-check: OK — platform/photos.json (both copies identical, valid, private entry present for ${project})`);
