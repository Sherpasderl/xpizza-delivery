'use strict';
// The Admin SDK's public PATH API for a fake RTDB Reference (Codex #404 P1): lib/rtdb-gate.pathOf reads ref.toString() and
// ref.root.toString(), and a Query's .ref. A fake ref gets the SAME strings the SDK gives: toString() = the database URL + the path,
// each segment URI-encoded (the SDK's pathToUrlEncodedString), root.toString() = the database URL; key = the last segment (null at
// the root). Never laxer than the SDK: a fake Query without .ref still fails loudly at the gate.
const URL = 'https://fake-rtdb.local';
function refPath(p) {
  const segs = String(p == null ? '' : p).split('/').filter(Boolean);
  const s = segs.length ? `${URL}/${segs.map(encodeURIComponent).join('/')}` : `${URL}/`;
  return { toString: () => s, root: { toString: () => `${URL}/` }, key: segs.length ? segs[segs.length - 1] : null };
}
// attach the path API to an existing fake ref object (keeps the object identity the fake's own methods close over); enumerable, so a
// test that derives a fake by spreading one ({ ...r, once }) keeps the same path
const withPath = (ref, p) => Object.defineProperties(ref, Object.fromEntries(Object.entries(refPath(p)).map(([k, v]) => [k, { value: v, configurable: true, writable: true, enumerable: true }])));
// a test object standing in for a REAL Admin SDK ref (emulator suites): the real ref's own path API (toString / root / key)
const pathFrom = (real) => ({ toString: () => real.toString(), root: real.root, key: real.key });
module.exports = { refPath, withPath, pathFrom, URL };
