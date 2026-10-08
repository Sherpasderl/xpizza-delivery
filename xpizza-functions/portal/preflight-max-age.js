'use strict';
// PORTAL SPEED P1 (PLAN-portal-speed rev 3 §1) — Access-Control-Max-Age on CORS preflights, applied OUTSIDE Firebase.
// Firebase builds cors({ origin }) itself and its preflight ends the response before the handler, so the header cannot
// be set from inside a handler. This wraps the RETURNED CloudFunction: for OPTIONS it sets the header, then delegates
// with the same arguments and returns the original invocation's result. Every own property of the original — enumerable
// or not, getters included (__endpoint, __trigger, …) — and its prototype are carried over unchanged, so discovery
// and the deployed configuration are identical. Without it the Fetch default caches a preflight for ~5 s.
const PREFLIGHT_MAX_AGE_SECONDS = 600;

function withPreflightMaxAge(fn) {
  if (typeof fn !== 'function') throw new TypeError('withPreflightMaxAge: not a function');
  const wrapped = (...args) => {
    const [req, res] = args;
    if (req && req.method === 'OPTIONS') res.setHeader('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));
    return fn(...args);
  };
  for (const key of Reflect.ownKeys(fn)) Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(fn, key));
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fn));
  return wrapped;
}

module.exports = { withPreflightMaxAge, PREFLIGHT_MAX_AGE_SECONDS };
