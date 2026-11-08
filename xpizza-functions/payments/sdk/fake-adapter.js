'use strict';
// TEST / SANDBOX ONLY — a scriptable PSP behind the adapter contract. Never moves real money. Every invocation is logged with
// its ARGUMENTS (calls), so cells assert real provider calls. script[action] is a queue of outcomes or functions; a step may be
// { lost: true, ...outcome } (the PSP acts, the caller sees a throw → unknown) or { pause: Promise } (resolve to continue).
function makeFakePsp(script = {}) {
  const calls = [];
  const state = {};   // uuid → { state, amount_cents } (what the PSP "knows")
  let seq = 0;
  const take = (action) => { const q = script[action] || []; return q.length ? q.shift() : null; };
  async function run(action, args, dflt) {
    calls.push({ action, ...args });
    let step = take(action);
    if (typeof step === 'function') step = await step(args, state);
    if (step && step.pause) { await step.pause; }
    const out = { ...(dflt(args) || {}), ...(step || {}) };
    if (out.effect) out.effect(state, args, out);
    if (out.lost) throw new Error('fake-psp: response lost');
    if (out.throw) throw new Error('fake-psp: transport failure');
    return out;
  }
  const impl = {
    authorize: (a) => run('authorize', a, () => {
      const uuid = `P-${++seq}`;
      return { outcome: 'approved', uuid, amount_cents: a.amount_cents, effect: (st, args, o) => { if (o.outcome === 'approved') st[o.uuid] = { state: 'authorized', amount_cents: o.amount_cents }; } };
    }),
    capture: (a) => run('capture', a, () => ({ outcome: 'captured', uuid: a.uuid, amount_cents: a.amount_cents, effect: (st, args, o) => { if (o.outcome === 'captured' && st[args.uuid]) st[args.uuid].state = 'captured'; } })),
    void: (a) => run('void', a, () => ({ outcome: 'voided', uuid: a.uuid, effect: (st, args, o) => { if (o.outcome === 'voided' && st[args.uuid]) st[args.uuid].state = 'voided'; } })),
    status: (a) => run('status', a, () => (state[a.uuid] ? { state: state[a.uuid].state, uuid: a.uuid, amount_cents: state[a.uuid].amount_cents } : { state: 'inconclusive', uuid: a.uuid })),
  };
  const count = (action) => calls.filter((c) => c.action === action).length;
  return { impl, calls, state, count };
}
module.exports = { makeFakePsp };
