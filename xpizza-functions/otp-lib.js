'use strict';
const crypto = require('crypto');
const { normalizePhone } = require('./whatsapp');            // reuse: full international digits
const SALT = process.env.OTP_SALT || '';
if (SALT.length < 32) { throw new Error('OTP_SALT missing or too short (need >=32 chars) — refusing to start (fail-closed)'); }
function sha(s){ return crypto.createHash('sha256').update(String(s)+SALT).digest('hex'); }
function phoneHash(raw){ const d = normalizePhone(raw); if(!d) return null; return sha('p:'+d); }
function genCode(){ return String(crypto.randomInt(0, 1000000)).padStart(6,'0'); }
function hashCode(c){ return sha('c:'+c); }
function constEq(a,b){ const A=Buffer.from(String(a)), B=Buffer.from(String(b)); return A.length===B.length && crypto.timingSafeEqual(A,B); }

// ── Rate-limit + OTP-verify state machines (PURE; run inside RTDB transactions; unit-tested) ──
// Kept here as the single source of truth so the handler transaction and the tests exercise the
// exact same logic. Returning `undefined` from a transaction updater ABORTS the write (Firebase).
const LIMITS = { WINDOW: 10*60e3, MIN_GAP: 30e3, MAX_PER_WINDOW: 3, IP_MAX_PER_HR: 10, CODE_TTL: 5*60e3, MAX_ATTEMPTS: 5 };

// per-IP hourly cap (secondary control; req.ip is Cloud Run-trusted). next state, or undefined to ABORT.
function ipReserve(v, now){
  v = (v && v.window_start > now - 3600e3) ? v : { window_start: now, count: 0 };
  if (v.count >= LIMITS.IP_MAX_PER_HR) return undefined;
  return { window_start: v.window_start, count: v.count + 1 };
}

// per-phone slot reservation (GLOBAL across brands): 30s min-gap + 3-per-10min sliding window.
// Returns { next, code }; next===undefined ABORTS (too soon / too many). Generates+hashes the code.
function sendReserve(v, now){
  v = v || { sends: [] };
  const sends = (v.sends || []).filter(t => t > now - LIMITS.WINDOW);
  if (sends.length && sends[sends.length-1] > now - LIMITS.MIN_GAP) return { next: undefined, code: null };
  if (sends.length >= LIMITS.MAX_PER_WINDOW) return { next: undefined, code: null };
  const code = genCode();
  return { next: { code_hash: hashCode(code), expires_at: now + LIMITS.CODE_TTL, attempts: 0, sends: [...sends, now] }, code };
}

// verify + one-time consume: returns { next, outcome }. Checks expiry/consumed/attempt-cap, then
// constant-time code compare. success → mark consumed (BEFORE any mint); mismatch → attempts++.
function verifyConsume(v, now, code){
  if (!v || v.consumed || v.expires_at < now || (v.attempts||0) >= LIMITS.MAX_ATTEMPTS) return { next: v, outcome: 'fail' };
  if (constEq(v.code_hash, hashCode(String(code)))) return { next: { ...v, consumed: true }, outcome: 'ok' };
  return { next: { ...v, attempts: (v.attempts||0) + 1 }, outcome: 'fail' };
}

module.exports = { phoneHash, genCode, hashCode, constEq, normalizePhone, LIMITS, ipReserve, sendReserve, verifyConsume };
