'use strict';
// ---------------------------------------------------------------------------
// Phase 1c-b3 — splice the catalog-generated menu bundle INTO the order form HTML.
//
// The form renders the bundle inline (zero runtime fetch — nothing to fail offline, CDN-down or
// RTDB-down), so the committed HTML *is* production. That makes the splice itself the risk surface,
// and everything here is fail-closed: the generator refuses to write on ANY assertion failure, so a
// bad splice never reaches the committed file.
//
// 🔒 THE LOAD-BEARING PART — SCRIPT-SAFE SERIALIZATION.
// `JSON.stringify` alone is NOT safe to inline in HTML. The HTML tokenizer, not the JS parser, decides
// where a `<script>` element ends: it ends at the first `</script` followed by whitespace, `/` or `>`,
// wherever that appears — including inside what JS would consider a string. So a dish named
//     Pizza</script><script>alert(1)</script>
// would terminate the script tag EARLY, before any JS runs: the rest of the bundle becomes stray HTML
// text and the attacker's script becomes a real script element. `<!--` and `-->` can likewise flip the
// tokenizer into an escaped state, and an injected `FORM-MENU-BUNDLE:END` comment could fool the next
// regeneration's marker count.
//
// Escaping `<` → `<` after stringify neutralizes ALL of those at once: no `<` survives in the
// payload, so no HTML construct can be formed. It stays valid JSON/JS — `<` is a legal escape and
// parses back to `<`, so the dish name round-trips with its literal `</script>` intact.
// ---------------------------------------------------------------------------
const { writeFileSync, renameSync, readFileSync } = require('fs');

const BEGIN = '<!-- FORM-MENU-BUNDLE:BEGIN -->';
const END = '<!-- FORM-MENU-BUNDLE:END -->';
const SCRIPT_OPEN = '<script id="form-menu-bundle">';
const GLOBAL = 'window.__FORM_MENU_BUNDLE__';

// JSON, then neutralise every `<`. See the header — this is the whole safety property.
const scriptSafeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003C');

function bundleScript(bundle) {
  const payload = scriptSafeJson(bundle);
  // Belt: the escape must have removed every `<`. If this ever trips, the serializer regressed and we
  // must NOT write — an unescaped `<` is exactly the injection vector.
  if (payload.includes('<')) throw new Error('splice_unescaped_lt: serialized bundle still contains a raw "<"');
  return `${SCRIPT_OPEN}${GLOBAL} = ${payload};</script>`;
}

// HTML "script data" state: the element's text ends at the first `</script` followed by whitespace,
// `/` or `>` (ASCII case-insensitive). This is the exact rule a `</script>` payload exploits, so the
// extractor implements it rather than assuming the JS-level string boundaries hold.
function scriptDataEnd(html, from) {
  const re = /<\/script[\t\n\f\r />]/gi;
  re.lastIndex = from;
  const m = re.exec(html);
  return m ? m.index : -1;
}

// Pull the generated script's TEXT back out of a finished HTML document, the way a browser would.
function extractGeneratedScriptText(html) {
  const open = html.indexOf(SCRIPT_OPEN);
  if (open < 0) throw new Error('splice_script_missing: no <script id="form-menu-bundle">');
  if (html.indexOf(SCRIPT_OPEN, open + 1) >= 0) throw new Error('splice_script_duplicated');
  const start = open + SCRIPT_OPEN.length;
  const end = scriptDataEnd(html, start);
  if (end < 0) throw new Error('splice_script_unterminated');
  return html.slice(start, end);
}

// Parse the global back to a value — via JSON.parse, never eval. `<` is a legal JSON escape, so a
// dish name containing a literal `</script>` round-trips exactly.
function extractBundle(html) {
  const text = extractGeneratedScriptText(html);
  const prefix = `${GLOBAL} = `;
  if (!text.startsWith(prefix) || !text.endsWith(';')) throw new Error('splice_script_shape_unexpected');
  return JSON.parse(text.slice(prefix.length, -1));
}

function markerBounds(html, formLabel) {
  const begins = html.split(BEGIN).length - 1;
  const ends = html.split(END).length - 1;
  if (begins !== 1 || ends !== 1) {
    throw new Error(`splice_marker_count: ${formLabel} has ${begins} BEGIN / ${ends} END markers (need exactly 1 each)`);
  }
  const b = html.indexOf(BEGIN), e = html.indexOf(END);
  if (e < b) throw new Error(`splice_marker_order: ${formLabel} END precedes BEGIN`);
  return { b, e };
}

// Replace ONLY the marked region. Surrounding form JS is never touched, so hand edits elsewhere in the
// form are safe across regenerations.
function spliceBundle(html, bundle, formLabel = 'form') {
  const { b, e } = markerBounds(html, formLabel);
  const out = `${html.slice(0, b)}${BEGIN}\n${bundleScript(bundle)}\n${END}${html.slice(e + END.length)}`;

  // POST-SPLICE VALIDATION, fail-closed. Re-read the result the way a browser tokenizes it and assert
  // the payload survived intact. A `</script>` break shows up HERE: the extracted text would be
  // truncated and JSON.parse would fail (or, worse, silently parse a prefix — so we deep-compare).
  const back = extractBundle(out);
  if (JSON.stringify(back) !== JSON.stringify(bundle)) throw new Error(`splice_roundtrip_mismatch: ${formLabel}`);
  // The markers must still be exactly-once — an injected marker string in the payload would break the
  // NEXT regeneration, so catch it now rather than one release later.
  markerBounds(out, `${formLabel} (post-splice)`);
  return out;
}

// Atomic: write a temp file then rename, so a crash mid-write can never leave the committed form
// half-spliced (which would be a blank menu in production).
function writeAtomic(path, contents) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, contents, 'utf8');
  renameSync(tmp, path);
}

function spliceFormFile(path, bundle, formLabel) {
  const before = readFileSync(path, 'utf8');
  const after = spliceBundle(before, bundle, formLabel || path);
  const changed = after !== before;
  if (changed) writeAtomic(path, after);
  return { changed, html: after };
}

module.exports = { BEGIN, END, SCRIPT_OPEN, GLOBAL, scriptSafeJson, bundleScript, spliceBundle, spliceFormFile, extractBundle, extractGeneratedScriptText, scriptDataEnd, writeAtomic };
