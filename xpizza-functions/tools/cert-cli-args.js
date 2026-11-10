'use strict';
// STRICT argument parsing for the `--rid=<rid>` operator CLIs (backfill-identities, bootstrap-identity, rollback-version) —
// Codex cert r1 #1: the old `argv.find(startsWith('--x='))` took the FIRST of a repeated option and ignored every unknown
// argument, so `--apply --dry-run` WROTE and rollback `--to=v2 --dry-run` moved the pointer. Here every argument must be one
// the tool declares: a `--name=<value>` option (once, non-empty) or a bare `--flag` (once); `--project <id>` / `--project=<id>`
// pass through (requireProject validates them). Anything else — an unknown flag, a positional, a repeat, an empty value, the
// `--rid <rid>` space form — is REFUSED before any client exists. Exit 1: exit 2 stays the project guard's alone here.
function parseCertArgs(tool, argv, { options = [], flags = [] } = {}) {
  const out = {}; const seen = new Set();
  const refuse = (why) => ({ refused: `${tool}: REFUSED — ${why}` });
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') { i += 1; continue; }
    if (a.startsWith('--project=')) continue;
    if (a === '--rid') return refuse('"--rid <rid>" is not this tool\'s form: use --rid=<rid>');
    const m = /^--([a-z][a-z-]*)(?:=(.*))?$/.exec(a);
    if (!m) return refuse(`unrecognised argument "${a}"`);
    const [, name, value] = m;
    if (seen.has(name)) return refuse(`--${name} was given more than once`);
    seen.add(name);
    if (value !== undefined) {
      if (!options.includes(name)) return refuse(`unrecognised option "--${name}="`);
      if (value.trim() === '') return refuse(`--${name}= needs a value`);
      out[name] = value.trim();
    } else {
      if (!flags.includes(name)) return refuse(`unrecognised argument "--${name}"${options.includes(name) ? ` (write --${name}=<value>)` : ''}`);
      out[name] = true;
    }
  }
  return out;
}
module.exports = { parseCertArgs };
