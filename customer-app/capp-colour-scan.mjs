// capp-dark (PLAN-capp-dark-mode r2 §5) — THE colour-literal inventory of the customer app. Every exemption is PER SITE (Codex dark r1
// #5): capp.css declaration by declaration (its full at-rule ancestry in the key — @media / @supports / @container / @layer are
// scanned, never skipped), where only the custom properties of the SIX exact token homes are the theme itself; every served module's
// literal OCCURRENCES keyed by their enclosing declaration and counted, so a new literal anywhere — a new rule, a token-looking rule,
// a named colour, another inline style in an exempted file — is a new site. The guard (capp-dark.test.mjs) compares it to
// capp-colour-allowlist.json, where each site carries its disposition.
//   node customer-app/capp-colour-scan.mjs --print   (the current inventory, for a reviewed allowlist update)
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// the CSS named colours (CSS Color 4) — a literal like any hex when it sits in a colour-bearing property or a custom property
const NAMED = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ');
const COLOR_PROP = /^(color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|(box|text)-shadow|caret-color|accent-color|column-rule(-color)?|text-decoration(-color)?|filter|stop-color|flood-color|lighting-color|scrollbar-color)$/;
// Codex dark r2 #5: every CSS colour FUNCTION, any case (rgb()/RGB(), hsl, hwb, lab, lch, oklab, oklch, color()) — color-mix() itself is
// not a colour (its literal arguments are matched on their own)
const FN = '(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\\([^)]*\\)';
export const LIT = new RegExp(`#[0-9A-Fa-f]{3,8}\\b|(?<![\\w-])${FN}`, 'gi');
const JS_LIT = new RegExp(`(?<![\\w&])#[0-9A-Fa-f]{3,8}\\b|(?<![\\w$.-])${FN}`, 'gi');
// a CSS declaration written in JS (an inline style string, an SVG attribute, a style object / CSSOM assignment): a named colour in it is
// a literal exactly as in capp.css
const JS_DECL = /(?<![\w$-])(color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|stop-color)\s*[:=]\s*['"]?([^;'"`}>\n]*)/gi;
const NAMED_RE = new RegExp(`(?<![\\w-])(${NAMED.join('|')})(?![\\w-])`, 'gi');
// the theme itself: ONLY the custom properties of these six exact homes (the light tokens, the three dark forms, the canvas pair)
const AUTO = '@media (prefers-color-scheme: dark)';
const TOKEN_HOMES = new Set(['|:root', `${AUTO}|:root:not([data-theme="light"])`, '|:root[data-theme="dark"]', '|.app', '|.app.dark,:root[data-theme="dark"] .app', `${AUTO}|:root:not([data-theme="light"]) .app`]);

// the rules of a stylesheet source (comments stripped, braces matched) → flat [{ selector, body, anc: [grouping at-rule heads] }]
export function cssRules(src) {
  const t = src.replace(/\/\*[\s\S]*?\*\//g, ''); let i = 0; const flat = [];
  function list(anc) {
    while (i < t.length) {
      while (i < t.length && /\s/.test(t[i])) i++;
      if (i >= t.length) return;
      if (t[i] === '}') { i++; return; }
      const open = t.indexOf('{', i); if (open < 0) { i = t.length; return; }
      const head = t.slice(i, open).trim(); i = open + 1;
      if (/^@(media|supports|container|layer|document)\b/.test(head)) { list([...anc, head.replace(/\s+/g, ' ')]); continue; }
      if (head.startsWith('@')) { let d = 1; while (i < t.length && d) { d += (t[i] === '{') - (t[i] === '}'); i++; } continue; }   // @font-face / @keyframes
      const close = t.indexOf('}', i); flat.push({ selector: head.replace(/\s+/g, ' '), body: t.slice(i, close), anc }); i = close + 1;
    }
  }
  list([]);
  return flat;
}

// a JS occurrence's site: its enclosing declaration (the nearest `const|let|var|function NAME` at or above its line)
function anchorOf(lines, ln) {
  for (let k = ln; k >= 0; k--) { const m = lines[k].match(/^\s*(?:export\s+)?(?:const|let|var|async\s+function|function\*?)\s+([\w$]+)/); if (m) return m[1]; }
  return '(top)';
}

// the sources default to the served files; a test passes its own (the negative controls)
export const servedSources = () => ({ css: readFileSync(join(HERE, 'capp.css'), 'utf8'),
  js: Object.fromEntries(readdirSync(HERE).filter((x) => /\.js$/.test(x)).sort().map((f) => [f, readFileSync(join(HERE, f), 'utf8')])) });
export function inventory(srcs = servedSources()) {
  const sites = [];
  for (const r of cssRules(srcs.css)) {
    const anc = r.anc.join(' '), home = `${anc}|${r.selector}`;
    for (const d of r.body.split(';')) {
      const c = d.indexOf(':'); if (c < 0) continue;
      const prop = d.slice(0, c).trim(), val = d.slice(c + 1);
      if (prop.startsWith('--') && TOKEN_HOMES.has(home)) continue;   // the theme's own tokens — only in their homes
      const lits = new Set((val.match(LIT) || []).map((l) => l.replace(/\s+/g, '')));
      if (COLOR_PROP.test(prop) || prop.startsWith('--')) for (const n of val.match(NAMED_RE) || []) lits.add(n.toLowerCase());
      for (const l of lits) sites.push(`css ${anc ? anc + ' ' : ''}${r.selector} | ${prop} ${l}`);
    }
  }
  // every served module (the ported byte copies too): a hex after any non-word character except '&' (an HTML entity such as &#039;
  // is not a colour) and every rgb()/hsl() — SVG attributes, template styles, cssText, string constants — counted per enclosing site
  for (const [f, raw] of Object.entries(srcs.js)) {
    const lines = raw.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1').split('\n');
    const count = new Map();
    lines.forEach((line, ln) => {
      const hits = [...(line.match(JS_LIT) || []).map((l) => l.replace(/\s+/g, ''))];
      for (const m of line.matchAll(JS_DECL)) for (const n of m[2].match(NAMED_RE) || []) hits.push(n.toLowerCase());
      for (const l of hits) { const k = `@${anchorOf(lines, ln)} ${l}`; count.set(k, (count.get(k) || 0) + 1); }
    });
    for (const [k, n] of count) sites.push(`js ${f} ${k} ×${n}`);
  }
  return [...new Set(sites)].sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--print')) console.log(inventory().join('\n'));
