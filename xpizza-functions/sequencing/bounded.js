'use strict';
// BUILD-stacked-seq-server r4 P2-4 — every await of a sequencing decision races the remaining budget. A stall (a DB read, a
// transaction, an HTTP body) rejects with a marked `deadline` error instead of holding the writer. The raced promise keeps
// running; a late completion is harmless by construction (see plan-stack.js).
const DEADLINE = Symbol('stackseq.deadline');

function bounded(p, msLeft) {
  let timer;
  const expiry = new Promise((_, reject) => {
    const fire = () => { const e = new Error('deadline'); e[DEADLINE] = true; reject(e); };
    if (!(msLeft > 0)) fire(); else timer = setTimeout(fire, msLeft);
  });
  return Promise.race([Promise.resolve(p), expiry]).finally(() => clearTimeout(timer));
}

const isDeadline = (e) => !!e && e[DEADLINE] === true;

module.exports = { bounded, isDeadline };
