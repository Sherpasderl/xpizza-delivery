// EVERY id the portal GENERATES and sends to a server, against the server's REAL shape check (LIVE 2026-11-12: the photo uploader
// sent `op:<uuid>`, the server's OP_ID_RE refused the colon → «No se pudo subir la foto.» on every upload; the contract fake had
// accepted any non-empty string — a stub laxer than production). The server regexes are read from the SERVER SOURCE (one source,
// no copy); each portal generator is its OWN code (an exported function, or the app.js expression extracted verbatim and
// evaluated), sampled with and without crypto.randomUUID. Run: node --test portal-request-ids.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newOpId as branchOpId } from './branch-1b-logic.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const FN = (f) => readFileSync(join(DIR, '..', 'xpizza-functions', f), 'utf8');
const APP = readFileSync(join(DIR, 'app.js'), 'utf8');
const CLIENT = readFileSync(join(DIR, 'sherpa-client.js'), 'utf8');
const serverRe = (file, name) => {
  const m = new RegExp(`const ${name} = \\/(.+)\\/;`).exec(FN(file));
  assert.ok(m, `premise: ${file} declares ${name}`);
  return new RegExp(m[1]);
};
const RE = {
  photoOp: serverRe('photos/upload-start.js', 'OP_ID_RE'),     // photoUploadStart op_id
  tmpRef: serverRe('catalog/add-product.js', 'TMP_RE'),          // a new product's / option's tmp reference (editCatalog)
  branchOp: serverRe('branches/branch-store.js', 'OP_ID_RE'),    // createBranchDraft op_id
  instance: serverRe('client-version.js', 'INSTANCE_RE'),        // the X-Client instance (every SherpaClient request)
};
// an app.js expression, verbatim (the source is the generator), evaluated as code
const appExpr = (re, what) => { const m = re.exec(APP); assert.ok(m, `premise: app.js has ${what}`); return (0, eval)(m[1]); };
const withCrypto = (on, fn) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  if (!on) Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
  try { return fn(); } finally { if (saved) Object.defineProperty(globalThis, 'crypto', saved); }
};
const sample = (gen) => [true, false].flatMap((c) => withCrypto(c, () => Array.from({ length: 40 }, gen)));

test('photoUploadStart: the uploader’s op_id matches the server’s OP_ID_RE (the LIVE 400)', () => {
  const newOpId = appExpr(/newOpId: (\(\) => `[^\n]*`),\n/, 'the uploader’s newOpId');
  for (const id of sample(() => newOpId())) assert.match(id, RE.photoOp, `the uploader's op_id matches the server's OP_ID_RE (${id})`);
});
test('editCatalog: a new product’s and a new option’s tmp references match the server’s TMP_RE', () => {
  const exprs = [...APP.matchAll(/(`tmp:\$\{\(globalThis\.crypto[^\n]*?\}`)(?=[;,)])/g)].map((m) => m[1]);
  assert.ok(exprs.length >= 2, `premise: the product and option tmp-ref generators (${exprs.length})`);
  for (const e of exprs) for (const id of sample(() => (0, eval)(e))) assert.match(id, RE.tmpRef, `a tmp reference matches the server's TMP_RE (${id})`);
});
test('createBranchDraft: «Nueva sucursal»’s op_id matches the server’s OP_ID_RE', () => {
  for (const id of sample(() => branchOpId())) assert.match(id, RE.branchOp, `the branch op_id matches (${id})`);
  for (const r of [() => 0, () => 0.9999999]) assert.match(branchOpId(r), RE.branchOp, 'the injected-random path too');
});
test('SherpaClient: the instance id matches the server’s INSTANCE_RE, at the random extremes', () => {
  const m = /instance = ('i' \+ Math\.floor\(rand\(\) \* 0xffffffff\)\.toString\(36\) \+ Math\.floor\(rand\(\) \* 0xffffffff\)\.toString\(36\) \+ now\(\)\.toString\(36\));/.exec(CLIENT);
  assert.ok(m, 'premise: sherpa-client.js builds the instance id');
  const make = new Function('rand', 'now', `return ${m[1]};`);
  for (const r of [() => 0, () => 0.9999999, Math.random]) assert.match(make(r, () => Date.parse('2026-11-12T00:00:00Z')), RE.instance, 'the instance id matches');
});
test('non-vacuity: the planted LIVE shape (`op:` + uuid) is what the server refuses', () => {
  assert.doesNotMatch('op:dea43f08-db1c-4832-a185-4233bfa243f0', RE.photoOp);
  assert.match('op_dea43f08-db1c-4832-a185-4233bfa243f0', RE.photoOp);
});
