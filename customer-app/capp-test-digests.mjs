// Test support for the customer-app suites (never loaded by the app). WebCrypto digests (the quote's cartSig, the menu fingerprint)
// resolve on libuv's THREADPOOL, not on the event loop: a harness that waits a fixed number of ticks (capp-ui's settle) or a fixed
// 30 ms (capp-s7a2's flush) races them under CPU load — the «one quote on entry» / map-idle / placing flakes. The suites count the
// digests in flight and wait for them to land before their assertions read state. The code under test is untouched.
let inFlight = 0, installed = false;
export function trackDigests() {
  if (installed) return; installed = true;
  const s = globalThis.crypto && globalThis.crypto.subtle; if (!s) return;
  const orig = s.digest.bind(s);
  s.digest = (...x) => { inFlight++; let p; try { p = orig(...x); } catch (e) { inFlight--; throw e; } return p.finally(() => { inFlight--; }); };
}
export const digestsInFlight = () => inFlight;
// resolves once no digest is in flight (bounded: a digest that never settles is a failure, never a silent pass)
export async function digestsSettled(maxMs = 5000) {
  const t0 = Date.now();
  while (inFlight && Date.now() - t0 < maxMs) await new Promise((r) => setTimeout(r, 1));
  if (inFlight) throw new Error(`${inFlight} WebCrypto digest(s) never settled within ${maxMs} ms`);
}
