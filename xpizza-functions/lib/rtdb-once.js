'use strict';
// PLAN-rtdb-get-once-race-r3 §7: a one-shot RTDB read UNDER A CALLER'S DEADLINE. firebase-js-sdk #10653 (open; @firebase/database
// 1.0.8 pinned by tools/rtdb-sdk-pin.guard.test.js): a pending ref.get() orphans an overlapping listener's connection listen and the
// next subscription asserts «listen() called twice». So these reads are value LISTENERS, never get(). A bare once('value') under a
// caller's Promise.race would keep its listener after the caller gave up; this one is OWNED: the first value resolves it and removes
// THIS callback (off for this callback only, never a blanket off); if no value arrived within `ms`, the callback is detached and the
// promise never settles — the caller's own race has already answered at its deadline, so no caller decision can change. `ms` is the
// caller's deadline, and the detach timer starts with the read (after the caller's), so it never fires before the caller gives up.
// A listen the server cancels (permission denied …) rejects with the SDK's own error, exactly as once('value') does.
function onceWithin(ref, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timer = null;
    const finish = () => { done = true; if (timer) clearTimeout(timer); ref.off('value', onValue); };
    function onValue(snap) { if (done) return; finish(); resolve(snap); }
    timer = setTimeout(() => { if (!done) finish(); }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    ref.on('value', onValue, (err) => { if (done) return; done = true; clearTimeout(timer); reject(err); });
  });
}

module.exports = { onceWithin };
