'use strict';

/**
 * Minimal in-memory stand-in for the firebase-admin RTDB surface the factura helpers use:
 *   db.ref(path).once('value') -> { val() }
 *   db.ref(path).set(v) / .update(obj) / .remove()
 *   db.ref(path).transaction(fn) -> { committed, snapshot:{ val() } }
 * Transactions are synchronous here (single-threaded), which is enough to exercise the
 * helper's ordering + idempotency. Path segments split on '/'.
 */

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function makeFakeDb(initial = {}) {
  const root = clone(initial);

  function getAt(path) {
    if (!path) return root;
    const segs = path.split('/').filter(Boolean);
    let node = root;
    for (const s of segs) {
      if (node == null || typeof node !== 'object') return null;
      node = node[s];
    }
    return node === undefined ? null : node;
  }

  function setAt(path, value) {
    const segs = path.split('/').filter(Boolean);
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (node[s] == null || typeof node[s] !== 'object') node[s] = {};
      node = node[s];
    }
    const last = segs[segs.length - 1];
    if (value === null || value === undefined) delete node[last];
    else node[last] = clone(value);
  }

  function ref(path) {
    return {
      async once() {
        const v = clone(getAt(path));
        return { val: () => v };
      },
      async set(value) {
        setAt(path, value);
      },
      async update(obj) {
        const cur = getAt(path) || {};
        setAt(path, { ...cur, ...clone(obj) });
      },
      async remove() {
        setAt(path, null);
      },
      async transaction(updateFn) {
        const current = clone(getAt(path));
        const next = updateFn(current);
        if (next === undefined) {
          return { committed: false, snapshot: { val: () => clone(getAt(path)) } };
        }
        setAt(path, next);
        return { committed: true, snapshot: { val: () => clone(next) } };
      },
    };
  }

  return { ref, _dump: () => clone(root) };
}

module.exports = { makeFakeDb };
