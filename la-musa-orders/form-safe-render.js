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

/* URL — A POLICY, APPLIED TO A PARSED URL RATHER THAN TO ITS TEXT. Escaping is the wrong tool:
   javascript:alert(1) contains no HTML metacharacter, so an escaped page still executes it. Only two
   shapes pass — an absolute https:// URL, or a same-origin relative path — and everything else becomes
   the empty string so the caller falls back to its placeholder.

   🔴 THE FIRST VERSION MATCHED SUBSTRINGS AND PREFIXES, AND THAT IS WRONG IN BOTH DIRECTIONS:
     • `indexOf("..") === -1` is a text search, so it rejected the ordinary filename `pizza..jpg` while
       missing `%2e%2e` entirely — the encoded spelling of the same climb — and it never ran on the
       https branch at all, which returned earlier.
     • "a colon before the first slash is a scheme" read the colon in `photo.png?next=https://…` as a
       scheme and refused a perfectly ordinary query.
   Both are the same mistake: asking a question about the characters instead of about the URL. So the
   string is SPLIT first — fragment, then query, then path — and each part is judged as what it is. A
   climb is a path SEGMENT that decodes to "..", whatever spelling arrived; a scheme is a colon in the
   PATH part before any slash, which a query can no longer counterfeit.

   Over-rejection is a real failure, not a safe default: a policy that turns a merchant's photo into a
   placeholder is a silent outage of the thing they are watching, and it fails in the direction nobody
   notices — the tile still renders. Rejected on purpose, each for its own reason: http:// (mixed
   content on an https checkout), protocol-relative //host (inherits the page scheme, different origin),
   data: (can carry an SVG that scripts), blob:, userinfo (user@host reads as a different host), and
   every other scheme. Control characters, spaces, quotes, angle brackets, backticks and backslashes are
   refused outright — they are how a value escapes the attribute it sits in, and a tab inside
   "java<TAB>script:" is how a scheme hides from a naive prefix check. */
var SAFE_URL_SEG = /^[A-Za-z0-9._~\-%!$&()*+,;=:@]*$/;          // one path segment
var SAFE_URL_TAIL = /^[A-Za-z0-9._~\-%!$&()*+,;=:@\/?#]*$/;     // a query or fragment, taken whole
var SAFE_URL_IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/* A query or fragment gets the SAME decode-or-refuse treatment a path segment gets. The character
   class admits `%` but says nothing about what follows it, so `?x=%ZZ` and `#%2` — truncated and
   malformed escapes — sailed through a check that looked like it covered them. A percent sign is a
   promise about the next two characters; validating the character and not the promise is not
   validation. Taken whole rather than per-parameter: the question is whether the text can be decoded
   at all, and splitting on & first would just move the same hole into the pieces. */
function safeUrlTailOk(t) {
  if (!SAFE_URL_TAIL.test(t)) return false;
  try { decodeURIComponent(t); } catch (e) { return false; }
  return true;
}

// A segment that cannot be decoded is refused: a malformed percent escape is not a filename, and
// guessing what it meant is how the two spellings drift apart again.
function safeUrlSegmentOk(seg) {
  if (!SAFE_URL_SEG.test(seg)) return false;
  var decoded;
  try { decoded = decodeURIComponent(seg); } catch (e) { return false; }
  if (decoded === "..") return false;                 // the climb, however it was spelled
  // A segment that decodes to something containing a separator is a segment pretending not to be one.
  if (decoded.indexOf("/") !== -1 || decoded.indexOf("\\") !== -1) return false;
  return true;
}

function safeUrlPathOk(path) {
  var segs = path.split("/");
  for (var i = 0; i < segs.length; i++) if (!safeUrlSegmentOk(segs[i])) return false;
  return true;
}

// A real IPv6 literal, so `[::1]` and `[::ffff:192.0.2.1]` load and `[:::]` does not. Written out
// rather than approximated by a character class, because "looks like hex and colons" accepts nonsense.
function safeUrlIPv6Ok(t) {
  if (!/^[0-9A-Fa-f:.]+$/.test(t)) return false;
  if (t.indexOf(":::") !== -1) return false;
  var parts = t.split("::");
  if (parts.length > 2) return false;
  var head = parts[0] === "" ? [] : parts[0].split(":");
  var tail = parts.length === 2 ? (parts[1] === "" ? [] : parts[1].split(":")) : [];
  var need = 8;
  /* 🔴 AN EMBEDDED IPv4 IS ONLY LEGAL AS THE FINAL COMPONENT OF THE ADDRESS. Concatenating head and
     tail before looking for it threw away WHERE it sat: in `192.0.2.1::` the IPv4 is last in the
     concatenation while the address itself ends in compression, and that was accepted. So the search
     happens in the list that actually ends the address — the tail when there is a `::`, the head when
     there is not — and an address ending in `::` has no final component to be an IPv4 at all. */
  var lastList = parts.length === 2 ? tail : head;
  if (lastList.length && lastList[lastList.length - 1].indexOf(".") !== -1) {
    if (!SAFE_URL_IPV4.test(lastList[lastList.length - 1])) return false;
    lastList.pop();                                       // a trailing IPv4 literal fills two groups
    need = 6;
  }
  var groups = head.concat(tail);
  for (var i = 0; i < groups.length; i++) if (!/^[0-9A-Fa-f]{1,4}$/.test(groups[i])) return false;
  // "::" stands for AT LEAST one omitted group, so a compressed address must be short of the full count.
  return parts.length === 2 ? groups.length <= need - 1 : groups.length === need;
}

function safeUrlAuthorityOk(authority) {
  var host = authority, port = "";
  if (authority.charAt(0) === "[") {
    var close = authority.indexOf("]");
    if (close === -1) return false;
    host = authority.slice(0, close + 1);
    var after = authority.slice(close + 1);
    if (after) { if (after.charAt(0) !== ":") return false; port = after.slice(1); }
    if (!safeUrlIPv6Ok(host.slice(1, -1))) return false;
  } else {
    var c = authority.lastIndexOf(":");
    if (c !== -1) { host = authority.slice(0, c); port = authority.slice(c + 1); }
    // No userinfo, no empty host: `evil.test@cdn.test` is a different origin than it reads as.
    /* 🔴 THE HOST POLICY, STATED SO IT STOPS BEING RE-LITIGATED.
       safeImgUrl is an INTENTIONAL RESTRICTIVE SAFETY ALLOWLIST, not a WHATWG URL parser. Accepted
       hosts: standard dotted-quad IPv4 (octets 0-255), bracketed IPv6, and dotted or dotless
       hostnames. Exotic host forms — hex (0x7f.1), integer (2130706433), octal, abbreviated (127.1),
       trailing-dot (cdn.test.), IDNA — are OUT OF SCOPE BY DESIGN.

       Both directions of the residual mismatch with `new URL()` are safe, and that is why chasing
       parity here is not worth it:
         • an over-rejected exotic host fails safe — the caller falls back to its placeholder;
         • an accepted-but-invalid host is inert — it simply will not resolve;
         • no attribute breakout is reachable either way, because every caller passes the result
           through safeText before it lands between quotes.
       Do not chase `new URL()` parity in this function. Widening it to match a browser parser trades a
       bounded, readable allowlist for an unbounded one, and the thing being defended is an <img src>.

       An all-numeric DOTTED host is an IPv4 address rather than a name, and has to be a valid one: the
       bare character class accepted 999.999.999.999. A host with no dot (`localhost`, a bare `123`)
       is still a name and keeps the hostname rule. */
    if (/^[0-9]+(?:\.[0-9]+)+$/.test(host)) { if (!SAFE_URL_IPV4.test(host)) return false; }
    else if (!/^[A-Za-z0-9._~\-]+$/.test(host)) return false;
  }
  if (port !== "") {
    /* The bound is on the VALUE. Capping the text at five characters rejected `:000443`, which is port
       443 written with leading zeros — a real URL, refused for its spelling. The digit cap stays only
       so an absurdly long run of digits is not parsed at all. */
    if (!/^\d{1,7}$/.test(port)) return false;
    if (Number(port) > 65535) return false;
  }
  return true;
}

function safeImgUrl(raw) {
  if (raw == null) return "";
  var s = String(raw);
  if (/[\x00-\x20"'<>\\`]/.test(s)) return "";

  // SPLIT FIRST — fragment, then query, then path. Every question below is asked of the right piece.
  var hashAt = s.indexOf("#");
  var beforeHash = hashAt === -1 ? s : s.slice(0, hashAt);
  var fragment = hashAt === -1 ? "" : s.slice(hashAt + 1);
  var qAt = beforeHash.indexOf("?");
  var pathPart = qAt === -1 ? beforeHash : beforeHash.slice(0, qAt);
  var query = qAt === -1 ? "" : beforeHash.slice(qAt + 1);
  if (!safeUrlTailOk(query) || !safeUrlTailOk(fragment)) return "";

  // A SCHEME is a colon in the PATH part before any slash. The query cannot counterfeit one, because
  // it is no longer part of what is being read.
  var slashAt = pathPart.indexOf("/");
  var colonAt = pathPart.indexOf(":");
  var hasScheme = colonAt !== -1 && (slashAt === -1 || colonAt < slashAt);

  if (hasScheme) {
    if (pathPart.slice(0, colonAt).toLowerCase() !== "https") return "";
    var rest = pathPart.slice(colonAt + 1);
    if (rest.indexOf("//") !== 0) return "";              // https:evil — a scheme with no authority
    rest = rest.slice(2);
    var pSlash = rest.indexOf("/");
    var authority = pSlash === -1 ? rest : rest.slice(0, pSlash);
    var path = pSlash === -1 ? "" : rest.slice(pSlash);
    if (!safeUrlAuthorityOk(authority)) return "";
    if (path && !safeUrlPathOk(path)) return "";          // the climb check runs HERE too
    return s;
  }

  if (pathPart.indexOf("//") === 0) return "";            // protocol-relative: a different origin
  if (!safeUrlPathOk(pathPart)) return "";
  return s;
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
