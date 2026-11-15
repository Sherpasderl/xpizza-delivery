'use strict';
// Calificaciones v2 (PLAN-3a-merchant-reviews-v2 r1 §1) — the AES-256-GCM sealed cursor primitives for a merchant read, keyed by an
// HKDF-SHA256 derivation of OTP_SALT under the CALLER's own label (domain separated from the phone hash and from every other cursor;
// no new owner secret). A fresh IV each seal; the AAD binds the label, so a token sealed for one endpoint never opens at another.
// v1 (merchant-comments.js) keeps its own copy until the P-1 client is done; converging it here is a bytes-only follow-up (rule 4).
const crypto = require('crypto');

function makeSealer(label) {
  if (typeof label !== 'string' || !label) throw new Error('makeSealer: a label is required');
  const aad = Buffer.from(label);
  const deriveKey = (salt) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(salt, 'utf8'), Buffer.alloc(0), label, 32));
  function seal(key, payload) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(aad);
    const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
  }
  // → the parsed payload, or null for ANY failure (malformed, tampered, another label, a rotated key)
  function open(key, token) {
    try {
      const raw = Buffer.from(String(token), 'base64url');
      if (raw.length < 12 + 16 + 2) return null;
      const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12)); d.setAAD(aad); d.setAuthTag(raw.subarray(12, 28));
      return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
    } catch (_) { return null; }
  }
  return { deriveKey, seal, open };
}

module.exports = { makeSealer };
