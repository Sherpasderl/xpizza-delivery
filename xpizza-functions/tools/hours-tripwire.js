#!/usr/bin/env node
'use strict';
// S4 C′ G2 (PLAN-capp-S4-r5 §1 + r5.1 BC-1) — a CONSERVATIVE LEXICAL TRIPWIRE for new hours readers/parsers. It is a
// BEST-EFFORT tripwire, NOT a completeness guarantee: the completeness backstop is the Codex gate on every build.
// Scans every production .js under xpizza-functions/ (excluding tests, tools/, test/, contract/, node_modules, the grammar
// module schedule/hours-grammar.js and every G1-pinned region) line by line and flags a line matching ANY rule:
//   R1 an hours path token: /hours  'hours'  "hours"  `hours`  .hours  child('hours')/child("hours")
//   R2 an H:MM regex literal piece: \d{1,2} | \d{2} | [01]\d | 2[0-3] next to ':' (or ':' next to \d{2} | [0-5]\d)
//   R3 a 7-day key set with start/end: a line with ≥3 of sun..sat whose ±2-line window mentions start or end
//   R4 an ancestor read: `restaurants` with `identity` AND a read call (.ref( .child( .get( .once( getIdentity
//      getRestaurantIdentity) within ±3 lines
//   R5 a validator-body shape: a line naming DAYS (or ≥3 day keys) within ±5 lines of an HHMM identifier or an R2 piece
// Each hit is keyed by OCCURRENCE: {file, line_sha256 (sha256 of the trimmed line), occurrence (1-based index of that exact
// trimmed line among identical lines in the file)}. tools/hours-tripwire.allow.json must cover every hit (set inclusion,
// never counts), every entry must still match a hit (no stale entries), and allow ⊆ tools/hours-tripwire.baseline.json
// (fixed at the build base; it only SHRINKS in HOURS-ONE-SOURCE or grows by an advisor-approved, recorded commit).
//   node tools/hours-tripwire.js --list          print current hits
//   node tools/hours-tripwire.js --write-baseline (build base only) write allow + baseline from the current hits
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PINS = require('./hours-legacy-pins');
const FN = path.join(__dirname, '..');
const ALLOW = path.join(__dirname, 'hours-tripwire.allow.json');
const BASELINE = path.join(__dirname, 'hours-tripwire.baseline.json');
const GRAMMAR = 'schedule/hours-grammar.js';

const DAY = /\b(sun|mon|tue|wed|thu|fri|sat)\b/g;
const R1 = /\/hours\b|'hours'|"hours"|`hours`|\.hours\b|child\(\s*['"]hours['"]\s*\)/;
const R2 = /(\\d\{1,2\}|\\d\{2\}|\[01\]\\d|2\[0-3\])\)?:|:\(?(\\d\{2\}|\[0-5\]\\d)/;
const READ = /\.ref\(|\.child\(|\.get\(|\.once\(|getIdentity\b|getRestaurantIdentity\b/;
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const days = (l) => new Set((l.match(DAY) || [])).size;
const win = (L, i, k) => L.slice(Math.max(0, i - k), i + k + 1).join('\n');

function isProduction(rel) {
  if (!rel.endsWith('.js')) return false;
  if (/(^|\/)(node_modules|tools|test|contract)\//.test(rel)) return false;
  if (/\.test\.js$|\.emulator\.|\.proof\.|\.guard\./.test(rel)) return false;
  return rel !== GRAMMAR;
}
function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) out.push(...walk(path.join(dir, e.name), r)); }
    else if (isProduction(r)) out.push(r);
  }
  return out;
}
// the line indexes (0-based) inside any G1-pinned region of this file
function pinnedLines(file, text, pins) {
  const L = text.split('\n'); const set = new Set();
  for (const p of pins.filter((x) => x.file === file)) {
    // anchors are a literal line or a run of consecutive literal lines (hours-legacy-pins multi-line closing anchors)
    const find = (a) => { const q = Array.isArray(a) ? a : [a]; for (let i = 0; i + q.length <= L.length; i++) if (q.every((t, k) => L[i + k] === t)) return [i, i + q.length - 1]; return null; };
    const S = find(p.start_anchor), E = find(p.end_anchor);
    if (S && E && E[1] >= S[0]) for (let i = S[0]; i <= E[1]; i++) set.add(i);
  }
  return set;
}
// files: [{file, text}] → hits [{file, line, text, line_sha256, occurrence, rules}]
function scan(files, pins) {
  const hits = [];
  for (const { file, text } of files) {
    if (!isProduction(file)) continue;
    const L = text.split('\n'); const skip = pinnedLines(file, text, pins);
    const seen = new Map();
    L.forEach((line, i) => {
      const t = line.trim(); const occ = (seen.get(t) || 0) + 1; seen.set(t, occ);
      if (skip.has(i) || !t) return;
      const rules = [];
      if (R1.test(line)) rules.push('R1');
      if (R2.test(line)) rules.push('R2');
      if (days(line) >= 3 && /\b(start|end)\b/.test(win(L, i, 2))) rules.push('R3');
      if (/\brestaurants\b/.test(line)) { const w = win(L, i, 3); if (/\bidentity\b/.test(w) && READ.test(w)) rules.push('R4'); }
      if (/\bDAYS\b/.test(line) || days(line) >= 3) { const w = win(L, i, 5); if (/\bHHMM\w*\b/.test(w) || R2.test(w)) rules.push('R5'); }
      if (rules.length) hits.push({ file, line: i + 1, text: t, line_sha256: sha(t), occurrence: occ, rules });
    });
  }
  return hits;
}
const key = (h) => `${h.file}\u0000${h.line_sha256}\u0000${h.occurrence}`;
// → list of human-readable failures (empty = pass)
function evaluate(hits, allow, baseline) {
  const bad = [];
  const A = new Set(allow.map(key)), B = new Set(baseline.map(key)), H = new Set(hits.map(key));
  for (const h of hits) if (!A.has(key(h))) bad.push(`new hours hit not in allowlist: ${h.file}:${h.line} [${h.rules.join(',')}] ${h.text.slice(0, 100)}`);
  for (const a of allow) if (!H.has(key(a))) bad.push(`stale allowlist entry (matches no hit): ${a.file} occurrence ${a.occurrence} (${a.reason})`);
  for (const a of allow) if (!B.has(key(a))) bad.push(`allowlist entry not in the fixed baseline: ${a.file} occurrence ${a.occurrence} (${a.reason})`);
  for (const a of allow) if (typeof a.reason !== 'string' || !a.reason.trim()) bad.push(`allowlist entry without a reason: ${a.file}`);
  return bad;
}
const readFiles = () => walk(FN).map((file) => ({ file, text: fs.readFileSync(path.join(FN, file), 'utf8') }));
const loadPins = () => JSON.parse(fs.readFileSync(path.join(__dirname, 'hours-legacy-pins.json'), 'utf8'));

module.exports = { scan, evaluate, isProduction, readFiles, loadPins, key, sha, ALLOW, BASELINE };

if (require.main === module) {
  const hits = scan(readFiles(), loadPins());
  const mode = process.argv[2];
  if (mode === '--list') { for (const h of hits) console.log(`${h.file}:${h.line} [${h.rules.join(',')}] #${h.occurrence} ${h.text.slice(0, 120)}`); console.log(`${hits.length} hits`); }
  else if (mode === '--write-baseline') {
    const reasons = JSON.parse(process.env.TRIPWIRE_REASONS || '{}');   // { file: reason } supplied at the build base
    const entries = hits.map((h) => ({ file: h.file, line_sha256: h.line_sha256, occurrence: h.occurrence, rules: h.rules, line: h.line, text: h.text.slice(0, 160), reason: reasons[h.file] || reasons['*'] }));
    if (entries.some((e) => !e.reason)) { console.error('every file needs a reason (TRIPWIRE_REASONS)'); process.exit(2); }
    const body = JSON.stringify(entries, null, 2) + '\n';
    fs.writeFileSync(ALLOW, body); fs.writeFileSync(BASELINE, body); console.log(`wrote allow + baseline (${entries.length})`);
  } else { console.error('usage: hours-tripwire.js --list | --write-baseline'); process.exit(2); }
}
