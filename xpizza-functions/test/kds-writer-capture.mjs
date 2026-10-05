// TEST-ONLY: run the REAL KDS availability writer (xpizza-kitchen/xpizza-delivery.js setItemAvailability)
// with the firebase client SDK stubbed — the same loader xpizza-kitchen/avail-write.test.mjs uses — and
// return the exact multi-path update() payload it would send. The emulator suite applies that payload (with
// the serverTimestamp sentinel resolved to the server clock), so its 86 fixtures ORIGINATE from the real
// writer rather than from a hand-built shape.
import { readFileSync } from 'node:fs';

const KITCHEN = new URL('../../xpizza-kitchen/', import.meta.url);
export const TS = Object.freeze({ __serverTimestamp: true });
const writes = [];
globalThis.__fbWrites = writes;
globalThis.__fbTS = TS;
const stubSrc = `
export function initializeApp() { return {}; }
export function getAuth() { return {}; }
export function signInWithEmailAndPassword() { return Promise.resolve({ user: {} }); }
export function signOut() { return Promise.resolve(); }
export function onAuthStateChanged() { return () => {}; }
export function getDatabase() { return {}; }
export function ref(_db, path) { return { path: path == null ? "" : path }; }
export function onValue() { return () => {}; }
export function set(r, v) { globalThis.__fbWrites.push({ scope: r.path, payload: { __set: v } }); return Promise.resolve(); }
export function update(r, obj) { globalThis.__fbWrites.push({ scope: r.path, payload: obj }); return Promise.resolve(); }
export function get() { return Promise.resolve({ val: () => null, exists: () => false }); }
export function remove(r) { globalThis.__fbWrites.push({ scope: r.path, payload: { __remove: true } }); return Promise.resolve(); }
export function runTransaction() { return Promise.resolve({ committed: true, snapshot: { val: () => null } }); }
export function serverTimestamp() { return globalThis.__fbTS; }
export function off() {}
`;
await import('data:text/javascript,' + encodeURIComponent(readFileSync(new URL('./avail-key.js', KITCHEN), 'utf8')));
globalThis.location = { hostname: 'xpizza-kitchen.example' };
const stubUrl = ('data:text/javascript,' + encodeURIComponent(stubSrc)).replace(/'/g, '%27');
let sdk = readFileSync(new URL('./xpizza-delivery.js', KITCHEN), 'utf8');
sdk = sdk
  .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-app\.js/g, stubUrl)
  .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-auth\.js/g, stubUrl)
  .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-database\.js/g, stubUrl)
  .replace(/from '\.\/order-filter\.js'/g, `from '${new URL('./order-filter.js', KITCHEN).href}'`);
const XPD = await import('data:text/javascript,' + encodeURIComponent(sdk));
XPD.initDelivery({});

// → { [path]: value } exactly as the KDS sends it (TS = the serverTimestamp sentinel).
export async function captureSetItemAvailability(rid, rawKey, available, uid) {
  writes.length = 0;
  await XPD.setItemAvailability(rid, rawKey, available, uid);
  if (writes.length !== 1 || writes[0].scope !== '') throw new Error('KDS writer contract changed (expected ONE root multi-path update)');
  return writes[0].payload;
}
export const availKey = (raw) => globalThis.availKey(raw);
