// H1b — the boot router and the device-auth watch, PURE and unit-tested (codex H1b r2 P1-1 / P1-2). app.js only drives them.
//
// decideBoot: ONE serialized decision. It awaits BOTH the bridge status and the FIRST Auth state, then routes exactly once:
//   a persisted session + a DIFFERENT authenticated uid  → login, after a sign-out (a foreign identity never reaches the list)
//   a persisted session + a PIN                          → checks when the native bridge is blocked (the plugin missing included),
//                                                           else main (also offline: the banner shows until the first snapshot)
//   a persisted session, no PIN, its own uid signed in   → checks (then the PIN)
//   anything else                                        → login
// Late duplicates (a second status, a second Auth callback) never re-route: the caller routes once, on this result.
export async function decideBoot({ saved, hasPin, statusP, firstAuthP }) {
  const [st, u] = await Promise.all([statusP, firstAuthP]);
  const status = st || {};
  if (saved && u && u.uid !== saved.uid) return { route: 'login', signOut: true, status };
  if (saved && hasPin) return { route: status.native && status.blocked ? 'checks' : 'main', signOut: false, status };
  if (saved && u && u.uid === saved.uid) return { route: 'checks', signOut: false, status };
  return { route: 'login', signOut: false, status };
}

// createAuthWatch: the persistent Auth observer's rule. expect(uid) is called BEFORE the device signs in (pairing) or when a
// persisted session is restored; from then on:
//   the expected uid observed          → seen
//   a DIFFERENT uid observed           → loss
//   null observed AFTER it was seen    → loss (a null before the device sign-in lands is the pre-sign-in state, not a loss)
// clear() at sign-out; loss is reported once until the next expect().
export function createAuthWatch({ onLoss }) {
  let expected = null; let seen = false; let lost = false;
  const loss = (why) => { if (lost) return; lost = true; onLoss(why); };
  return {
    expect(uid) { expected = uid || null; seen = false; lost = false; },
    clear() { expected = null; seen = false; lost = false; },
    observe(u) {
      if (!expected) return;
      if (u && u.uid === expected) { seen = true; return; }
      if (u && u.uid !== expected) { loss('other_uid'); return; }
      if (!u && seen) loss('signed_out');
    },
    state: () => ({ expected, seen, lost }),
  };
}
