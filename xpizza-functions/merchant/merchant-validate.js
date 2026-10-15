'use strict';
// H1a input + stored-shape validators. Type and finiteness are checked BEFORE any coercion or clamp (codex r1 P2-17):
// null / '' / booleans / numeric strings / ±Infinity / -0 are refused, never clamped into a valid value.
// Return value: the normalised value, or null when absent-or-invalid for required fields. Optional free text (note, items)
// returns null/[] when ABSENT and undefined when PRESENT BUT INVALID, so a caller can refuse bad input instead of dropping it.

const isNum = (x) => typeof x === 'number' && Number.isFinite(x) && !Object.is(x, -0);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const PREP_MIN = 5, PREP_MAX = 90;
const vPrep = (x) => (isNum(x) ? Math.min(PREP_MAX, Math.max(PREP_MIN, Math.round(x))) : null);
const vAdd = (x) => ([5, 10, 15].includes(x) ? x : null);
const REASONS = new Set(['agotado', 'saturada', 'cerrando', 'otro']);
const vReason = (x) => (typeof x === 'string' && REASONS.has(x) ? x : null);

// Location ids follow the brand/location id syntax (lowercase, digits, underscore; no reserved or all-digit ids).
const RID = /^[a-z0-9_]{1,40}$/;
const RESERVED = new Set(['unknown', '__proto__', 'constructor', 'prototype', 'hasownproperty']);
const vRid = (x) => (typeof x === 'string' && RID.test(x) && !RESERVED.has(x) && !/^\d+$/.test(x) ? x : null);
// RTDB-key-safe order id (push ids start with '-').
const vOid = (x) => (typeof x === 'string' && x.length >= 1 && x.length <= 128 && /^[^./#$\[\]\x00-\x1f\x7f]+$/.test(x) ? x : null);
const vOpId = (x) => (typeof x === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(x) ? x : null);
const vLabel = (x) => { if (typeof x !== 'string') return null; const t = x.trim(); return t.length >= 1 && t.length <= 40 ? t : null; };

function vNote(x) {
  if (x === undefined || x === null) return null;
  if (typeof x !== 'string') return undefined;
  const t = x.trim();
  return t.length <= 140 ? t : undefined;
}
function vItems(x) {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x) || x.length > 20) return undefined;
  return x.every((s) => typeof s === 'string' && s.length >= 1 && s.length <= 80) ? x.slice() : undefined;
}

// C-5: the two valid stored `prep` shapes. 'full' must be internally consistent (ready_at is derived, never trusted).
const FULL = ['committed_min', 'extra_min', 'accepted_at', 'ready_at'];
function vStoredPrep(p) {
  if (!isObj(p)) return null;
  const keys = Object.keys(p);
  if (keys.length === 1 && keys[0] === 'ready_marked_at') return isNum(p.ready_marked_at) ? 'ready_only' : null;
  if (keys.some((k) => !FULL.includes(k) && k !== 'ready_marked_at')) return null;
  if (!FULL.every((k) => isNum(p[k]))) return null;
  if ('ready_marked_at' in p && !isNum(p.ready_marked_at)) return null;
  if (p.ready_at !== p.accepted_at + (p.committed_min + p.extra_min) * 60000) return null;
  return 'full';
}

module.exports = { PREP_MIN, PREP_MAX, vPrep, vAdd, vReason, vRid, vOid, vOpId, vLabel, vNote, vItems, vStoredPrep };
