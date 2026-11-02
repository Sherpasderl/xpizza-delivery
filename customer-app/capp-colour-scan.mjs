// capp-dark (PLAN-capp-dark-mode r2 §5) — THE colour-literal inventory of the customer app: every hex / rgb / hsl literal OUTSIDE the
// token blocks in capp.css (rule by rule) and every colour literal a JS module writes (SVG attributes, inline styles, CSSOM, string
// constants). The guard (capp-dark.test.mjs) compares it to capp-colour-allowlist.json: a literal that is not listed — a post-v6 rule
// that would not follow dark — fails; each listed site carries its disposition.
//   node customer-app/capp-colour-scan.mjs --print   (the current inventory, for a reviewed allowlist update)
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LIT = /#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g;

// the rules of a stylesheet source (comments stripped, braces matched) → flat [{ selector, body, media }]
export function cssRules(src) {
  const t = src.replace(/\/\*[\s\S]*?\*\//g, ''); let i = 0; const flat = [];
  function list(media) {
    while (i < t.length) {
      while (i < t.length && /\s/.test(t[i])) i++;
      if (i >= t.length) return;
      if (t[i] === '}') { i++; return; }
      const open = t.indexOf('{', i); if (open < 0) { i = t.length; return; }
      const head = t.slice(i, open).trim(); i = open + 1;
      if (head.startsWith('@media')) { list(head.slice(6).trim()); continue; }
      if (head.startsWith('@')) { let d = 1; while (i < t.length && d) { d += (t[i] === '{') - (t[i] === '}'); i++; } continue; }
      const close = t.indexOf('}', i); flat.push({ selector: head.replace(/\s+/g, ' '), body: t.slice(i, close), media }); i = close + 1;
    }
  }
  list(null);
  return flat;
}
// a token block: custom properties on .app / :root (light, or one of the three dark forms) — its literals ARE the theme
const isTokenBlock = (r) => /--[a-z0-9-]+\s*:/.test(r.body) && /^(\.app|:root)/.test(r.selector);

// the sources default to the served files; a test passes its own (the negative controls)
export const servedSources = () => ({ css: readFileSync(join(HERE, 'capp.css'), 'utf8'),
  js: Object.fromEntries(readdirSync(HERE).filter((x) => /\.js$/.test(x)).sort().map((f) => [f, readFileSync(join(HERE, f), 'utf8')])) });
export function inventory(srcs = servedSources()) {
  const sites = [];
  for (const r of cssRules(srcs.css)) {
    if (isTokenBlock(r)) continue;
    for (const d of r.body.split(';')) {
      const c = d.indexOf(':'); if (c < 0) continue;
      const prop = d.slice(0, c).trim();
      for (const l of new Set(d.slice(c + 1).match(LIT) || [])) sites.push(`css ${r.media ? `@media ${r.media} ` : ''}${r.selector} | ${prop} ${l.replace(/\s+/g, '')}`);
    }
  }
  // every served module (the ported byte copies too): a hex after any non-word character except '&' (an HTML entity such as
  // &#039; is not a colour), and every rgb()/hsl() — in SVG attributes, template styles, cssText and string constants alike
  for (const [f, raw] of Object.entries(srcs.js)) {
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    for (const l of new Set(src.match(/(?<![\w&])#[0-9A-Fa-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) || [])) sites.push(`js ${f} ${l.replace(/\s+/g, '')}`);
  }
  return [...new Set(sites)].sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--print')) console.log(inventory().join('\n'));
