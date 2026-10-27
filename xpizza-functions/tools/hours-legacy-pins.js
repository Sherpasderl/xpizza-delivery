#!/usr/bin/env node
'use strict';
// S4 C′ G1 (PLAN-capp-S4-r5 §1 + r5.1 BC-2) — the LEGACY HOURS BYTE PINS. Each record pins an inclusive region of a legacy
// hours reader/parser (L1-L12, PLAN-capp-S4-r4 §1) by a LITERAL unique start line and end line plus the sha256 of the exact
// bytes from the first byte of the start line to the last byte (incl. newline) of the end line. Ruling A: those regions stay
// byte-identical until HOURS-ONE-SOURCE migrates a consumer — which REMOVES its record (never re-hashes it).
//   node tools/hours-legacy-pins.js --write   (build base only) resolve SPEC line ranges → tools/hours-legacy-pins.json
//   node tools/hours-legacy-pins.js --check   exit 1 on any anchor / hash mismatch (the guard runs the same check)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FN = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'hours-legacy-pins.json');

// [id, family, file, startLine, endLine] — line numbers at the BUILD BASE only (--write), kept in hours-legacy-pins.spec.json;
// the generated hours-legacy-pins.json stores the LITERAL anchors the guard checks.
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'hours-legacy-pins.spec.json'), 'utf8'));

const linesOf = (src) => src.split('\n');
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
// the inclusive region between the unique start and end anchors (full-line equality); throws on non-unique / missing
function region(src, start, end) {
  const L = linesOf(src);
  const idx = (t) => { const hits = []; L.forEach((l, i) => { if (l === t) hits.push(i); }); return hits; };
  const s = idx(start), e = idx(end);
  if (s.length !== 1) throw new Error(`start anchor occurs ${s.length}× (must be exactly once): ${start.trim().slice(0, 80)}`);
  if (e.length !== 1) throw new Error(`end anchor occurs ${e.length}× (must be exactly once): ${end.trim().slice(0, 80)}`);
  if (e[0] < s[0]) throw new Error('end anchor precedes start anchor');
  return L.slice(s[0], e[0] + 1).join('\n') + '\n';
}

function build() {
  const out = [];
  for (const [id, family, file, a, b] of SPEC) {
    const src = fs.readFileSync(path.join(FN, file), 'utf8');
    const L = linesOf(src);
    let s = a, e = b;
    if (id === 'L3-confirm') {   // located by content: the deps.getIdentity hours read + its releaseTimeValid use
      const i = L.findIndex((l) => l.includes('if (deps.getIdentity) { try { hours = (await deps.getIdentity(db, order.restaurant_id'));
      s = i + 1; e = i + 2;
    }
    const start = L[s - 1], end = L[e - 1];
    let r;
    try { r = region(src, start, end); } catch (err) { throw new Error(`${id} ${file}:${s}-${e}: ${err.message}`); }
    out.push({ id, family, file, start_anchor: start, end_anchor: end, inclusive: true, sha256: sha(r) });
  }
  return out;
}

function check(records) {
  const bad = [];
  for (const rec of records) {
    let r;
    try { r = region(fs.readFileSync(path.join(FN, rec.file), 'utf8'), rec.start_anchor, rec.end_anchor); }
    catch (e) { bad.push(`${rec.id} (${rec.file}): ${e.message}`); continue; }
    if (sha(r) !== rec.sha256) bad.push(`${rec.id} region sha256 mismatch (${rec.file})`);
  }
  return bad;
}

module.exports = { region, check, sha, SPEC };

if (require.main === module) {
  const mode = process.argv[2];
  if (mode === '--write') { fs.writeFileSync(OUT, JSON.stringify(build(), null, 2) + '\n'); console.log(`wrote ${OUT}`); }
  else if (mode === '--check') { const bad = check(JSON.parse(fs.readFileSync(OUT, 'utf8'))); if (bad.length) { console.error(bad.join('\n')); process.exit(1); } console.log('hours-legacy-pins: OK'); }
  else { console.error('usage: hours-legacy-pins.js --write | --check'); process.exit(2); }
}
