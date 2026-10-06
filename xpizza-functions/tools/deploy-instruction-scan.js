'use strict';
// ---------------------------------------------------------------------------
// Every `firebase … deploy` instruction in the repo, normalized — for the PINNED ALLOWLIST in
// tools/deploy-instruction-pins.js (codex stats build r5; advisor ruling: stop pattern-matching bad forms,
// which always leaks; pin every occurrence and fail on anything new or changed).
//
// NORMALIZATION, per file:
//   • a line ending in `\` is joined with the next (shell continuation);
//   • a continued line's leading comment marker (`//`, `#`, `*`) and indentation are stripped, and the line is
//     joined when the previous one ended MID-COMMAND: a trailing `\`, a trailing `,` in a target list, a
//     trailing flag that takes a value (`--only`, `--project`, `-P`, `--config`), or the next line starting
//     with a flag `-…` (a comment- or prose-wrapped command).
// BOUNDING: a command runs from `firebase` to the first newline (after joins), `;`, `&&`, `||`, `|`, or the
// closing backtick / quote of the inline-code span it sits in — it NEVER borrows the next command's flags.
// OCCURRENCE: the token `firebase`, then only flags (and their values), then the token `deploy` — so a
// short-flag form with the project before the verb is one, and a bare prose mention is one too (pinned as a
// mention). Prose boundaries (` (`, `, `) end a command; a comma INSIDE a target list does not.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const COMMENT = /^\s*(?:\/\/+|#+|\*+(?!\/)|<!--)?\s*/;
const BOUND = /;|&&|\|\||\||`|'|"|\)|\s\(|,\s|$/;

// Logical lines with their starting line numbers.
function normalize(text) {
  const raw = text.split(/\r?\n/);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let line = raw[i];
    const start = i + 1;
    for (;;) {
      const next = raw[i + 1];
      if (next === undefined) break;
      const trimmed = line.replace(/\s+$/, '');
      const nextBody = next.replace(COMMENT, '');
      const shellCont = /\\$/.test(trimmed);
      const inCmd = /\bfirebase\b[^`'"]*$/.test(trimmed);
      const listCont = inCmd && /,$/.test(trimmed);
      const valueCont = inCmd && /(?:^|\s)(?:--only|--project|-P|--config)$/.test(trimmed);
      const flagCont = inCmd && /\bdeploy\b/.test(trimmed) && /^-/.test(nextBody);
      if (!(shellCont || listCont || valueCont || flagCont)) break;
      line = shellCont ? trimmed.slice(0, -1) + ' ' + nextBody : listCont ? trimmed + nextBody : trimmed + ' ' + nextBody;
      i++;
    }
    out.push({ line, start });
  }
  return out;
}

// → [{ line, command }] — every firebase…deploy occurrence, its command normalized to single spaces.
function occurrences(text) {
  const found = [];
  for (const { line, start } of normalize(text)) {
    const re = /\bfirebase\b/g;
    let m;
    while ((m = re.exec(line))) {
      const rest = line.slice(m.index);
      const end = rest.slice('firebase'.length).search(BOUND);
      const cmd = (end < 0 ? rest : rest.slice(0, 'firebase'.length + end)).replace(/\s+/g, ' ').trim();
      const toks = cmd.split(' ');
      if (toks[0] !== 'firebase') continue;          // `firebase.json`, `firebase-tools` … are not the CLI
      let j = 1;
      while (j < toks.length && toks[j] !== 'deploy') {
        if (!toks[j].startsWith('-')) break;
        // a flag's separate value (e.g. `-P xpizza-delivery`, `--project x`)
        if (!toks[j].includes('=') && toks[j + 1] && !toks[j + 1].startsWith('-') && toks[j + 1] !== 'deploy') j++;
        j++;
      }
      if (toks[j] === 'deploy') found.push({ line: start, command: cmd });
    }
  }
  return found;
}

const SKIP = new Set(['node_modules', '.git', '.claude', '.firebase', '.impeccable']);
const EXT = /\.(md|js|mjs|cjs|json|sh|txt|html|yml|yaml|toml)$/;
// Fixture files: scanner probes and mutant catalogues, whose strings are deliberately unpinned commands.
const FIXTURES = new Set([
  'xpizza-functions/tools/deploy-instruction-scan.test.js',
  'xpizza-functions/tools/deploy-instruction-pins.js',
  'xpizza-functions/tools/deploy-instruction-classify.js',   // a REGEX of the wrapper's command, not an instruction
  'xpizza-functions/tools/mutation-sweep.mutants.json',
]);

function scanRepo(repo) {
  const hits = [];
  let files = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!EXT.test(e.name)) continue;
      const rel = path.relative(repo, p).split(path.sep).join('/');
      if (FIXTURES.has(rel)) continue;
      if (fs.statSync(p).size > 5 * 1024 * 1024) continue;
      files++;
      for (const o of occurrences(fs.readFileSync(p, 'latin1'))) hits.push({ file: rel, ...o });   // latin1: NUL-safe
    }
  };
  walk(repo);
  return { hits, files };
}

module.exports = { normalize, occurrences, scanRepo, FIXTURES };
