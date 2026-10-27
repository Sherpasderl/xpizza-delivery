// Customer app S7a-1 (PLAN-capp-S7a r2 §1.3 + N4, APPROVED as a plan) — the SHELL's navigation: ONE browser-history owner. Pure
// logic over an injected window-like { history, addEventListener, removeEventListener }; no DOM rendering (the shell screens are
// drawn by S7a-2 against the directory). DARK: no page loads it yet.
//
//   shell stack   [{ name, params, saved }] — Inicio / Buscar / a store … ; each push records its PREDECESSOR (the entry below it)
//   store mount   adapterFor(entry) → the `history` option CappUI takes — EXACTLY the approved adapter { push, back, go, owns,
//                 subscribe } (r2 §1.3; Codex r1 P2-9): its in-store steps become real
//                 browser entries owned by that mount; a device back is delivered to the mount's deviceBack:
//                   consumed ⇒ its entry is gone (the mount handled it) · blocked ⇒ the entry is RE-PUSHED, nothing changes ·
//                   pass ⇒ the store is left: back to the RECORDED PREDECESSOR (Buscar keeps its query / scroll), Inicio only as
//                   the fallback (prototype go/back :1355-1367)
//   accounting    a UI-caused back (the shell's or the mount's) marks its own popstate as self-caused (skip), never re-delivered
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappShellNav = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createShellNav(opts) {
    const o = opts || {};
    const win = o.win;
    const home = o.home || { name: 'home' };
    const onShow = typeof o.onShow === 'function' ? o.onShow : () => {};    // (entry, { from }) ⇒ render that shell screen
    const onLeave = typeof o.onLeave === 'function' ? o.onLeave : () => {};  // (storeEntry) ⇒ destroy its mount (only after `pass` / a tab)
    const stack = [{ ...home, saved: null }];   // shell screens
    const subs = [];                            // in-store browser entries owned by the TOP store mount (one per push)
    let n = 0, skip = 0, mountBack = null;
    const push = (tag) => { n++; try { win.history.pushState({ sh: n, ...tag }, ''); } catch (_) {} };
    const top = () => stack[stack.length - 1];
    const predecessor = () => (stack.length > 1 ? stack[stack.length - 2] : null);

    // a shell screen on top of the current one (open-store, Buscar, a dish result…) — the current screen's state is saved first
    function go(entry, saved) {
      top().saved = saved === undefined ? top().saved : saved;
      stack.push({ ...entry, saved: null }); subs.length = 0; push({ screen: entry.name });
      onShow(top(), { from: stack[stack.length - 2] });
    }
    // a tab: the stack restarts at that tab (prototype tab(): S.stack = []); a store mount on top is left first
    function tab(entry) {
      if (top().name === 'store') onLeave(top());
      stack.length = 0; stack.push({ ...entry, saved: null }); subs.length = 0; mountBack = null;
      onShow(top(), { from: null });
    }
    // leave the top store (pass) or a shell screen ⇒ its recorded predecessor, else the fallback
    function popScreen() {
      const left = stack.pop();
      if (left && left.name === 'store') { onLeave(left); mountBack = null; }
      subs.length = 0;
      if (!stack.length) stack.push({ ...home, saved: null });
      onShow(top(), { from: left, restored: top().saved });
    }
    // the shell's own back control (a «‹» / X on a shell screen): UI-caused ⇒ its popstate is skipped
    function back() {
      if (stack.length <= 1) return false;
      skip++; try { win.history.back(); } catch (_) { skip--; }
      popScreen(); return true;
    }

    // the history option a store mount takes (CappUI opts.history): push / back / go(-k) replace pushState / history.back() /
    // history.go(-k); owns() replaces ownHist() — the top shell record is THIS mount's; subscribe delivers device backs
    function adapterFor(storeEntry) {
      return {
        push() { subs.push(1); push({ store: storeEntry.rid || true }); },
        back() { if (!subs.length) return; subs.pop(); skip++; try { win.history.back(); } catch (_) { skip--; } },
        go(k) { const m = Math.min(-k, subs.length); if (m <= 0) return; subs.length -= m; skip++; try { win.history.go(-m); } catch (_) { skip--; } },
        owns() { return top() === storeEntry && subs.length > 0; },
        subscribe(fn) { mountBack = fn; return () => { if (mountBack === fn) mountBack = null; }; },
      };
    }

    // a DEVICE / browser back (not caused by the shell or the mount)
    function onPop() {
      if (skip > 0) { skip--; return 'self'; }
      if (top().name === 'store' && typeof mountBack === 'function') {
        const r = mountBack();
        if (r === 'consumed') { subs.pop(); return r; }
        if (r === 'blocked') { push({ store: true, reblock: true }); return r; }   // the browser already went back: restore the entry
        if (r === 'pass') { popScreen(); return r; }
      }
      if (stack.length > 1) { popScreen(); return 'popped'; }
      return 'exit';   // nothing of ours left: the browser leaves (forward moves are never walked)
    }

    if (win && typeof win.addEventListener === 'function') win.addEventListener('popstate', onPop);
    return {
      go, tab, back, adapterFor, onPop, predecessor, current: top, depth: () => stack.length,
      destroy() { if (win && typeof win.removeEventListener === 'function') win.removeEventListener('popstate', onPop); },
    };
  }

  return { createShellNav };
});
