// Customer app S7a-1 (PLAN-capp-S7a r2 §1.3 + N4, APPROVED as a plan) — the SHELL's navigation: ONE browser-history owner. Pure
// logic over an injected window-like { history, addEventListener, removeEventListener }; no DOM rendering (the shell screens are
// drawn by S7a-2 against the directory). DARK: no page loads it yet.
//
//   shell stack   [{ name, params, saved }] — Inicio / Buscar / a store … ; each push records its PREDECESSOR (the entry below it)
//   history       the SINGLE-SENTINEL pattern (advisor ruling, Codex r3 #4): the shell owns exactly ONE browser entry (pushed once;
//                 a remount standing on it does not push again). Every navigation is IN-APP. A device / browser Back leaves the
//                 sentinel ⇒ popstate ⇒ the sentinel is re-pushed and ONE in-app back runs. A Forward therefore has nothing to
//                 reach, and no physical offset is ever computed (branching, blocked Backs and remounts cannot desynchronize it).
//                 Nothing left in-app (Inicio at the root) ⇒ the sentinel is NOT re-pushed: the next Back leaves the app.
//   store mount   adapterFor(entry) → the `history` option CappUI takes — EXACTLY the approved adapter { push, back, go, owns,
//                 subscribe } (r2 §1.3; Codex r1 P2-9): its in-store steps are counted in-app; a device back is delivered to the
//                 mount's fn(): consumed ⇒ it handled it · blocked ⇒ nothing changes · pass ⇒ the store is left: back to the
//                 RECORDED PREDECESSOR (Buscar keeps its query / scroll), Inicio only as the fallback (prototype go/back :1355-1367)
//   exits         EVERY shell exit from a store (a tab, the shell's own back, a screen opened over it, a store-root pass) goes
//                 through ONE leave(): it asks the mount fn('leave') (r3.2) — `blocked` ⇒ nothing changes — and then tears the
//                 mount down (onLeave ⇒ destroy, which cancels a «Realizando pedido…» countdown) (Codex r2 New 3, r3 #2)
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappShellNav = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SENTINEL = { capp_shell: 1 };
  const isSentinel = (st) => !!st && typeof st === 'object' && st.capp_shell === 1;

  function createShellNav(opts) {
    const o = opts || {};
    const win = o.win;
    const home = o.home || { name: 'home' };
    const onShow = typeof o.onShow === 'function' ? o.onShow : () => {};    // (entry, { from, restored }) ⇒ render that shell screen
    const onLeave = typeof o.onLeave === 'function' ? o.onLeave : () => {};  // (storeEntry) ⇒ destroy its mount
    const stack = [{ ...home, saved: null }];   // shell screens
    const subs = [];                            // in-store steps of the TOP store mount (one per push), in-app only
    let mountBack = null;
    const top = () => stack[stack.length - 1];
    const predecessor = () => (stack.length > 1 ? stack[stack.length - 2] : null);
    const hist = () => (win && win.history) || null;
    const pushSentinel = () => { try { hist().pushState({ ...SENTINEL }, ''); } catch (_) {} };
    // the one owned entry: pushed once — a remount already standing on it (a reload) does not push again
    try { if (!isSentinel(hist() && hist().state)) pushSentinel(); } catch (_) {}

    // THE leave + teardown of a top store (every exit path): asked first; blocked ⇒ false, nothing changed
    function leave() {
      const t = top();
      if (t.name !== 'store') return true;
      if (typeof mountBack === 'function' && mountBack('leave') === 'blocked') return false;
      onLeave(t); mountBack = null; subs.length = 0;
      return true;
    }
    // a shell screen on top of the current one (open-store, Buscar, a dish result…) — the current screen's state is saved first
    function go(entry, saved) {
      if (!leave()) return false;
      top().saved = saved === undefined ? top().saved : saved;
      stack.push({ ...entry, saved: null }); subs.length = 0;
      onShow(top(), { from: stack[stack.length - 2] });
      return true;
    }
    // a tab: the stack restarts at that tab (prototype tab(): S.stack = [])
    function tab(entry) {
      if (!leave()) return false;
      stack.length = 0; stack.push({ ...entry, saved: null }); subs.length = 0; mountBack = null;
      onShow(top(), { from: null });
      return true;
    }
    // to the recorded predecessor, else the fallback (the top store was already left)
    function popScreen() {
      const left = stack.pop();
      subs.length = 0;
      if (!stack.length) stack.push({ ...home, saved: null });
      onShow(top(), { from: left, restored: top().saved });
    }
    // the shell's own back control (a «‹» / X on a shell screen): in-app only
    function back() {
      if (stack.length <= 1 || !leave()) return false;
      popScreen(); return true;
    }

    // the history option a store mount takes (CappUI opts.history): every step in-app; owns() — this mount has a step to undo
    function adapterFor(storeEntry) {
      return {
        push() { subs.push(1); },
        back() { if (subs.length) subs.pop(); },
        go(k) { const m = Math.min(-k, subs.length); if (m > 0) subs.length -= m; },
        owns() { return top() === storeEntry && subs.length > 0; },
        subscribe(fn) { mountBack = fn; return () => { if (mountBack === fn) mountBack = null; }; },
      };
    }

    // a DEVICE / browser Back (the shell never moves the browser itself): the sentinel is put back first, then ONE in-app back
    function onPop() {
      try { if (isSentinel(hist().state)) return 'none'; } catch (_) {}   // standing on the sentinel already: nothing to undo
      const inApp = stack.length > 1 || top().name === 'store';
      if (!inApp) return 'exit';   // Inicio at the root: the sentinel is not re-pushed — the next Back leaves the app
      pushSentinel();
      if (top().name === 'store' && typeof mountBack === 'function') {
        const r = mountBack();
        if (r === 'consumed') { if (subs.length) subs.pop(); return r; }
        if (r === 'blocked') return r;
        if (r === 'pass') { if (!leave()) return 'blocked'; popScreen(); return r; }
      }
      if (!leave()) return 'blocked';
      popScreen(); return 'popped';
    }

    if (win && typeof win.addEventListener === 'function') win.addEventListener('popstate', onPop);
    return {
      go, tab, back, adapterFor, onPop, predecessor, current: top, depth: () => stack.length,
      destroy() { if (win && typeof win.removeEventListener === 'function') win.removeEventListener('popstate', onPop); },
    };
  }

  return { createShellNav, SENTINEL };
});
