#!/usr/bin/env node
'use strict';
// ── P-SELFUPDATE §1 — the per-site BUILD STAMP ───────────────────────────────────────────────────────────────────────
//
// Runs as each manifest site's Netlify build command, from the site's base directory:
//     node ../platform/stamp-version.js
// Netlify provides SITE_NAME (→ the manifest deployment whose `netlify_site` matches), COMMIT_REF and CONTEXT.
//
// It writes, into the site folder only:
//   • /version.json  {app, deployment, build, compat, commit}
//   • into every manifest entrypoint, one marked block of <meta> tags (identity; CSP-safe — no inline script), read by
//     the committed shared module (sherpa-client.js).
//
//   build  = sha256 over the site's canonical runtime files (sorted relative paths + bytes; the shared module copy is
//            INCLUDED; generated metadata — version.json and the stamp block itself — is EXCLUDED), so unchanged files →
//            the same build → no reload. Tests, docs and node_modules are not runtime and are excluded.
//   compat = platform/compat.json for the deployment's logical app (source-controlled; raised by hand).
//
// FAILURE IS NEVER A FAILED BUILD (advisor ruling CP2 Q2): an unknown SITE_NAME, a folder that is not the deployment's,
// or any error → the site ships UNSTAMPED (the module is inert: no reload, no heartbeat, no X-Client headers), the
// build log carries a loud error, and the exit code is 0 so git-CD keeps shipping. On ANY failure the folder is left CLEAN
// UNSTAMPED: every stamp block stripped and version.json deleted — never the previous bytes (codex CP2 r1 S7).
// An unstamped deployment can never report a heartbeat, so the owner's coverage report shows it as MISSING.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BEGIN = '<!-- sherpa-stamp:begin -->';
const END = '<!-- sherpa-stamp:end -->';
const STAMP_BLOCK_RE = /<!-- sherpa-stamp:begin -->[\s\S]*?<!-- sherpa-stamp:end -->\n?/g;
const GENERATED = new Set(['version.json']);
const NOT_RUNTIME_RE = /(^|\/)(node_modules|\.[^/]+)(\/|$)|\.test\.(m?js|cjs)$|\.md$/;
const BUILD_LEN = 20;

function listFiles(root) {
  const out = [];
  (function walk(rel) {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (NOT_RUNTIME_RE.test(r)) continue;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && !GENERATED.has(r)) out.push(r);
    }
  })('');
  return out.sort();
}

// The canonical form of a file for hashing: an entrypoint is hashed WITHOUT its stamp block, so re-stamping is
// idempotent and the stamp never feeds its own hash.
const canonicalBytes = (root, rel, entrypoints) => {
  const buf = fs.readFileSync(path.join(root, rel));
  return entrypoints.includes(rel) ? Buffer.from(buf.toString('utf8').replace(STAMP_BLOCK_RE, ''), 'utf8') : buf;
};

function computeBuild(root, entrypoints) {
  const h = crypto.createHash('sha256');
  for (const rel of listFiles(root)) {
    const b = canonicalBytes(root, rel, entrypoints);
    h.update(`${rel}\0${b.length}\0`); h.update(b); h.update('\0');
  }
  return h.digest('hex').slice(0, BUILD_LEN);
}

const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function metaBlock(d, build, compat, env) {
  const tags = [['sherpa-app', d.app], ['sherpa-deployment', d.id], ['sherpa-context', d.context],
    ['app-build', build], ['app-compat', String(compat)], ['sherpa-env', env]];
  return `${BEGIN}\n${tags.map(([n, v]) => `<meta name="${n}" content="${escAttr(v)}">`).join('\n')}\n${END}\n`;
}

// Insert after the charset <meta> when there is one (it must stay within the first 1024 bytes), else after <head>.
function injectBlock(html, block) {
  const clean = html.replace(STAMP_BLOCK_RE, '');
  const charset = clean.match(/<meta\s+charset=[^>]*>\s*\n?/i);
  const at = charset ? charset.index + charset[0].length : (() => { const m = clean.match(/<head[^>]*>\s*\n?/i); return m ? m.index + m[0].length : -1; })();
  if (at < 0) throw new Error('entrypoint has no <head>');
  return clean.slice(0, at) + block + clean.slice(at);
}

function loadPlatform(platformDir) {
  const sites = JSON.parse(fs.readFileSync(path.join(platformDir, 'sites.json'), 'utf8'));
  const compat = JSON.parse(fs.readFileSync(path.join(platformDir, 'compat.json'), 'utf8'));
  return { sites, compat };
}

// → { ok: true, deployment, build, compat, files } | { ok: false, error }   — never throws; never leaves partial output
function stamp(siteDir, { siteName, commit = 'unknown', env = 'unknown', platformDir = __dirname } = {}) {
  try {
    const { sites, compat } = loadPlatform(platformDir);
    const matches = (sites.deployments || []).filter((d) => d.netlify_site && d.netlify_site === siteName);
    if (matches.length !== 1) throw new Error(`SITE_NAME ${JSON.stringify(siteName)} matches ${matches.length} manifest deployments (need exactly 1)`);
    const d = matches[0];
    if (path.basename(path.resolve(siteDir)) !== d.folder) throw new Error(`site folder ${path.basename(path.resolve(siteDir))} is not deployment ${d.id}'s folder ${d.folder}`);
    const g = compat && compat.generations && compat.generations[d.app];
    if (!Number.isInteger(g) || g < 1) throw new Error(`no compat generation for app ${d.app}`);
    const build = computeBuild(siteDir, d.entrypoints);
    const block = metaBlock(d, build, g, env);
    const outputs = d.entrypoints.map((e) => [path.join(siteDir, e), injectBlock(fs.readFileSync(path.join(siteDir, e), 'utf8'), block)]);
    outputs.push([path.join(siteDir, 'version.json'), `${JSON.stringify({ app: d.app, deployment: d.id, build, compat: g, commit: String(commit || 'unknown').slice(0, 64) })}\n`]);
    for (const [abs, content] of outputs) fs.writeFileSync(abs, content);
    return { ok: true, deployment: d.id, build, compat: g, files: outputs.map(([a]) => path.relative(siteDir, a)) };
  } catch (e) {
    // codex CP2 r1 S7: a failure must leave CLEAN UNSTAMPED output — never the previous bytes, which on a re-stamped
    // (manual-deploy) folder would keep an OLD active stamp and version.json alive under a "ships UNSTAMPED" log line
    const left = cleanUnstamped(siteDir);
    const err = String((e && e.message) || e);
    return { ok: false, error: left.length ? `${err}; and could NOT remove the stamp from: ${left.join(', ')}` : err };
  }
}

// Strip every stamp block from every HTML file in the folder and delete version.json. → the files it could NOT clean
function cleanUnstamped(siteDir) {
  const left = [];
  const vj = path.join(siteDir, 'version.json');
  try { if (fs.existsSync(vj)) fs.unlinkSync(vj); } catch (_) { left.push('version.json'); }
  (function walk(rel) {
    let ents; try { ents = fs.readdirSync(path.join(siteDir, rel), { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (/(^|\/)(node_modules|\.[^/]+)$/.test(r)) continue;
      if (e.isDirectory()) { walk(r); continue; }
      if (!/\.html?$/.test(e.name)) continue;
      const abs = path.join(siteDir, r);
      try {
        const html = fs.readFileSync(abs, 'utf8');
        if (!html.includes(BEGIN)) continue;
        fs.writeFileSync(abs, html.replace(STAMP_BLOCK_RE, ''));
      } catch (_) { left.push(r); }
    }
  })('');
  return left;
}

module.exports = { stamp, cleanUnstamped, computeBuild, listFiles, injectBlock, metaBlock, STAMP_BLOCK_RE };

if (require.main === module) {
  const r = stamp(process.cwd(), { siteName: process.env.SITE_NAME, commit: process.env.COMMIT_REF, env: process.env.CONTEXT || 'unknown' });
  if (r.ok) console.log(`sherpa-stamp: ${r.deployment} build ${r.build} compat ${r.compat} → ${r.files.join(', ')}`);
  else {
    console.error('\n' + '!'.repeat(78));
    console.error(`!!! SHERPA STAMP FAILED — this deploy ships UNSTAMPED (self-update + heartbeat inert): ${r.error}`);
    console.error('!'.repeat(78) + '\n');
  }
  process.exit(0);   // never fail the build (ruling CP2 Q2)
}
