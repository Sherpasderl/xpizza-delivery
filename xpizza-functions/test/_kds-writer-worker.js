'use strict';
// A SEPARATE PROCESS for kds-manifest-writer.test.mjs: one manifest writer, optionally held inside its
// transaction callback (after the read, before the decision) until the parent releases it.
//   node test/_kds-writer-worker.js <argsJsonFile>   → prints one JSON line {result, saw:[storedGen per invocation]}
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { writeKdsManifest } = require('../catalog/kds-manifest');

const args = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!process.env.FIREBASE_DATABASE_EMULATOR_HOST) { console.error('refusing: no RTDB emulator'); process.exit(2); }
admin.initializeApp({ databaseURL: `http://${process.env.FIREBASE_DATABASE_EMULATOR_HOST}?ns=${args.ns}`, projectId: args.ns });
const rtdb = admin.database();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);   // a SYNCHRONOUS pause
const saw = [];
(async () => {
  // A PERSISTENT listener keeps /menus in the local cache, so the transaction's first invocation runs on the REAL
  // value (a one-shot once() leaves the cache cold and the first invocation would see null).
  await new Promise((resolve) => rtdb.ref('menus').on('value', () => resolve()));
  let first = true;
  const result = await writeKdsManifest(rtdb, args.rid, {
    catalog: args.catalog, generation: args.generation, versionId: args.versionId, now: () => args.now,
    _onRead: (current) => {
      const m = current && current._meta && current._meta[args.rid];
      saw.push(m ? m.source_generation : null);
      if (args.hold && first && current !== null) {          // held after its first REAL read
        first = false;
        fs.writeFileSync(path.join(args.barrier, `${args.name}.inside`), String(Date.now()));
        const deadline = Date.now() + 30000;
        while (!fs.existsSync(path.join(args.barrier, `${args.name}.release`))) {
          if (Date.now() > deadline) throw new Error('barrier timeout');
          sleep(20);
        }
      }
    },
  });
  process.stdout.write(`${JSON.stringify({ result, saw })}\n`, () => process.exit(0));
})().catch((e) => { process.stdout.write(`${JSON.stringify({ error: String(e && e.message) })}\n`, () => process.exit(1)); });
