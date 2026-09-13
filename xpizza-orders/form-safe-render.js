"use strict";
// ── form-safe-render — AUTHORED CATALOG STRINGS, RENDERED BY CONTEXT (Portal 1B Task 8) ───────────
//
// 🔴 WHY THIS EXISTS NOW AND NOT BEFORE. Until 1B the menu was a literal spliced into the page at
// deploy time: authored by us, reviewed by us, changed only by a deploy. 1B makes it a LIVE FEED a
// merchant edits through the portal — so every authored string is now untrusted input arriving at
// runtime, and the forms render those strings into five different contexts that each have their own
// rules. One escape function does not cover five contexts; using the body-text one for a URL or a style
// attribute is the classic way an "escaped" page still executes.
//
//   BODY TEXT       name, desc, emoji            → escape the five HTML metacharacters
//   ATTRIBUTE       alt, aria-label, data-*      → same escaping; the quoting is what matters
//   URL             img src                      → a POLICY, not an escape: https or same-origin
//                                                  relative, nothing else. `javascript:` is a perfectly
//                                                  well-formed URL and escaping does not make it inert.
//   CSS             tile background colour       → a constrained grammar, not an escape
//   IDENTIFIER      ids reaching a click handler → never concatenated into code at all; see below
//
// 🔴 THE IDENTIFIER CONTEXT IS CLOSED BY CONSTRUCTION, NOT BY ESCAPING. The forms used to build
// onclick="chg(${p.id},1)" from authored ids. No escape makes that safe in general — it is authored
// data inside a script context — so the class is removed instead: ids go into `data-` attributes and the
// click is handled by ONE delegated listener per container that reads the attribute and resolves it back
// through MENU/EXTRAS. Nothing authored is ever concatenated into executable text. That also survives a
// re-render for free, which matters because 1B re-renders the menu underneath the customer.
//
// A NOTE ON WHAT THIS IS NOT. It is defence in depth, not the guarantee. 1A validates and publishes the
// catalog, and that publish-time gate is the primary control; these renderers are the second line, for
// the day something gets through it or the publish path changes. The census in the copy test lists the
// converted sites and is a LINT — it cannot see a site nobody has written yet.
//
// UMD-lite (no `export`), canonical here, byte-identical copy in la-musa-orders/, with a drift test.

// BODY TEXT and QUOTED ATTRIBUTES. The same five replacements serve both: inside a quoted attribute the
// quote characters are what ends the attribute, and inside body text the angle brackets are what starts
// a tag. Escaping all five makes one function correct for both, which is why it is one function.
function safeText(raw) {
  if (raw == null) return "";
  return String(raw)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

/* URL — A POLICY. Escaping is the wrong tool: javascript:alert(1) contains no HTML metacharacter, so an
   escaped page still executes it. Only two shapes pass, and everything else becomes the empty string so
   the caller falls back to its placeholder:
     • an absolute https:// URL
     • a same-origin relative path
   Rejected on purpose, each for its own reason: http:// (mixed content on an https checkout),
   protocol-relative //host (inherits the page scheme, different origin), data: (can carry an SVG that
   scripts), blob:, and every other scheme. Control characters, spaces, quotes, angle brackets and
   backslashes are refused outright — they are how a value escapes the attribute it sits in, and a tab
   inside "java<TAB>script:" is how a scheme hides from a naive prefix check. */
function safeImgUrl(raw) {
  if (raw == null) return "";
  const s = String(raw);
  if (/[\x00-\x20"'<>\\`]/.test(s)) return "";
  if (/^https:\/\/[A-Za-z0-9._~\-]+(:\d+)?(\/[A-Za-z0-9._~\-%!$&()*+,;=:@\/]*)?(\?[A-Za-z0-9._~\-%!$&()*+,;=:@\/?]*)?$/.test(s)) return s;
  // Relative: must begin with a path segment or a single slash — never "//", and never "scheme:".
  if (/^\/?[A-Za-z0-9._~\-]+(\/[A-Za-z0-9._~\-]+)*(\?[A-Za-z0-9._~\-%=&]*)?$/.test(s)) return s;
  return "";
}

/* CSS — A CONSTRAINED GRAMMAR. The value lands in style="background:…", where a semicolon starts a new
   declaration and a quote ends the attribute. Rather than escape those, only shapes that cannot contain
   them are accepted: a hex colour, an rgb()/rgba() with numeric components, or a bare colour keyword
   (letters only — with no parens, expression(...)-style values cannot form). Anything else returns the
   caller's fallback, so a hostile colour degrades to the brand default rather than to no styling. */
function safeColor(raw, fallback) {
  const fb = fallback == null ? "" : String(fallback);
  if (raw == null) return fb;
  const s = String(raw).trim();
  if (/^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/.test(s)) return s;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/.test(s)) return s;
  if (/^[A-Za-z]{3,20}$/.test(s)) return s;
  return fb;
}

if (typeof module !== "undefined" && module.exports) module.exports = { safeText, safeImgUrl, safeColor };
if (typeof window !== "undefined") { window.safeText = safeText; window.safeImgUrl = safeImgUrl; window.safeColor = safeColor; }
