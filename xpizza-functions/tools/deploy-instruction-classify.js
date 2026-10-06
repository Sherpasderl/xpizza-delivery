'use strict';
// Classify ONE normalized `firebase … deploy` command (tools/deploy-instruction-scan.js) by what it would
// deploy. FORBIDDEN = the force flag anywhere, a bare `firestore` target, `firestore:indexes` outside the sanctioned
// wrapper's documented command, or flags with NO --only (that deploys everything, indexes included).
const WRAPPER_DOC = /^firebase deploy --only firestore:indexes --non-interactive(?: |$)/;

function classify(command) {
  const toks = command.split(' ');
  if (toks.some((t) => t === '--force' || t.startsWith('--force='))) return 'FORBIDDEN';
  const di = toks.indexOf('deploy');
  const after = toks.slice(di + 1);
  let only = null;
  for (let i = 0; i < after.length; i++) {
    if (after[i] === '--only') only = after[i + 1] || '';
    else if (after[i].startsWith('--only=')) only = after[i].slice('--only='.length);
  }
  const hasFlags = toks.slice(1).some((t) => t.startsWith('-'));
  if (only === null) return hasFlags ? 'FORBIDDEN' : 'mention';
  const targets = only.split(',').filter(Boolean);
  if (!targets.length) return 'FORBIDDEN';
  if (targets.some((t) => t === 'firestore' || t.startsWith('firestore:indexes'))) {
    return (targets.length === 1 && targets[0] === 'firestore:indexes' && WRAPPER_DOC.test(command)) ? 'wrapper-doc' : 'FORBIDDEN';
  }
  if (targets.every((t) => t === 'firestore:rules')) return 'rules-only';
  if (targets.every((t) => t === 'functions' || t.startsWith('functions:'))) return 'functions-only';
  if (targets.every((t) => t === 'database' || t === 'hosting' || t.startsWith('hosting:'))) return 'hosting-database';
  return 'FORBIDDEN';
}

module.exports = { classify, WRAPPER_DOC };
