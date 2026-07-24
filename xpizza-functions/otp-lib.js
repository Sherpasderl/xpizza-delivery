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
module.exports = { phoneHash, genCode, hashCode, constEq, normalizePhone };
