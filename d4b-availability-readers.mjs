// Portal 1D · D4-b — TODAY'S FOUR 86 READERS, driven over one generated corpus (plan C.1 / Tests "86").
//
// The four readers, each LOADED FROM ITS REAL FILE (never re-implemented here):
//   • server  — xpizza-functions/availability-gate.js checkItemAvailability (candidate key: the pricing key)
//   • x_pizza form — xpizza-orders/index.html isSoldOut (candidate keys: the page-local key history by dish id)
//   • la_musa form — la-musa-orders/index.html isSoldOut (candidate key: the dish id)
//   • KDS — xpizza-kitchen/index.html isItemOff (candidate key: the manifest key)
// computeDecisions() returns { reader: { caseName: boolean|string[] } }. The capture script freezes this on
// UNMODIFIED readers at main 717f97e; the parity test recomputes it on the D4-b readers (which now go
// through the shared availability-reducer in any_false mode) and requires identical output.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { loadForm, loadAvail, settle, OPEN } from './form-harness.mjs';

const require = createRequire(new URL('./xpizza-functions/x.js', import.meta.url));
const { availKey } = require('./avail-key');

// ── The corpus: one entry value per case, every shape a reader can meet ─────────────────────────────
export const ENTRY_CASES = {
  absent: undefined,
  true_: { available: true, updated_at: 100 },
  false_: { available: false, updated_at: 100 },
  false_no_ts: { available: false },
  true_no_ts: { available: true },
  null_: null,
  number_: 5,
  string_: 'x',
  array_: [false],
  string_false: { available: 'false', updated_at: 100 },
  zero: { available: 0, updated_at: 100 },
  empty_obj: {},
};
// Mixed historical keys (x_pizza form: a dish renamed OLD → NEW keeps both in its page history).
export const HISTORY_CASES = {
  old_false_new_true: [{ available: false, updated_at: 100 }, { available: true, updated_at: 200 }],   // newest_wins would say AVAILABLE
  old_true_new_false: [{ available: true, updated_at: 100 }, { available: false, updated_at: 200 }],
  old_false_new_absent: [{ available: false, updated_at: 100 }, undefined],
  old_absent_new_false: [undefined, { available: false, updated_at: 100 }],
  both_true: [{ available: true, updated_at: 100 }, { available: true, updated_at: 200 }],
  both_false: [{ available: false, updated_at: 100 }, { available: false, updated_at: 200 }],
  old_false_new_malformed: [{ available: false, updated_at: 100 }, 'x'],
};

const mapWith = (pairs) => { const m = {}; for (const [raw, v] of pairs) if (v !== undefined) m[availKey(raw)] = v; return m; };

async function serverDecisions() {
  const { checkItemAvailability } = require('./availability-gate');
  const { createFakeRtdb } = require('./test/d4b-fake-rtdb');
  const out = {};
  for (const [rid, line] of [['x_pizza', { name: 'Carnivora', id: 2, qty: 1 }], ['la_musa', { id: 'dimsum_01', name: 'Wonton', qty: 1 }]]) {
    const raw = rid === 'x_pizza' ? line.name : line.id;
    for (const [c, v] of Object.entries(ENTRY_CASES)) {
      // RTDB never stores a null/undefined leaf; the fake normalises exactly as RTDB does
      const db = createFakeRtdb({ restaurants: { [rid]: { item_availability: mapWith([[raw, v]]) } } });
      out[`${rid}.${c}`] = (await checkItemAvailability(db, [line], rid)).blocked;
    }
    // malformed WHOLE node shapes (not via the fake: RTDB can hand back a primitive at the node)
    for (const [c, node] of Object.entries({ node_null: null, node_string: 'x', node_array: [{ available: false }] })) {
      const db = { ref: () => ({ once: async () => ({ val: () => node }) }) };
      out[`${rid}.${c}`] = (await checkItemAvailability(db, [line], rid)).blocked;
    }
    const failing = { ref: () => ({ once: async () => { throw new Error('UNAVAILABLE'); } }) };
    out[`${rid}.read_failure`] = (await checkItemAvailability(failing, [line], rid)).blocked;
  }
  return out;
}

async function formDecisions(dir, dish, rename) {
  const out = {};
  const keyOf = (item) => (dir === 'xpizza-orders' ? item.name : item.id);
  for (const [c, v] of Object.entries(ENTRY_CASES)) {
    const w = loadForm(dir); await settle();
    await loadAvail(w, mapWith([[keyOf(dish), v]]));
    out[c] = w.isSoldOut(dish);
  }
  if (rename) {
    for (const [c, [vOld, vNew]] of Object.entries(HISTORY_CASES)) {
      const w = loadForm(dir); await settle();
      const renamed = { ...dish, name: `${dish.name} (nuevo)` };
      await loadAvail(w, mapWith([[keyOf(dish), vOld], [keyOf(renamed), vNew]]));
      w.isSoldOut(dish);                    // the page saw the OLD identity first…
      out[`history.${c}`] = w.isSoldOut(renamed);   // …then the catalog renamed it
    }
  }
  // a whole-node READ FAILURE after a sold-out load: the overlay keeps its last state (or fails open)
  {
    const w = loadForm(dir); await settle();
    await loadAvail(w, mapWith([[keyOf(dish), { available: false, updated_at: 1 }]]));
    const prev = w.__respond;
    w.__respond = (url, init) => (/item_availability/.test(url) ? Promise.reject(new Error('offline')) : prev(url, init));
    await w.loadAvailability(); await settle();
    out.read_failure_after_false = w.isSoldOut(dish);
  }
  {
    const w = loadForm(dir); await settle();
    const prev = w.__respond;
    w.__respond = (url, init) => (/item_availability/.test(url) ? Promise.reject(new Error('offline')) : prev(url, init));
    await w.loadAvailability(); await settle();
    out.read_failure_cold = w.isSoldOut(dish);
  }
  return out;
}

function kdsDecisions() {
  // Lift the KDS's own reader out of its page (the two declarations it consists of), run it in a sandbox.
  const html = readFileSync(new URL('./xpizza-kitchen/index.html', import.meta.url), 'utf8');
  const fnSrc = (name) => {
    const m = html.match(new RegExp(`^function ${name}\\([^)]*\\) \\{[^\\n]*\\}`, 'm'));
    if (!m) throw new Error(`KDS: could not find the one-line function ${name}`);
    return m[0];
  };
  const reducerTag = /<script src="availability-reducer\.js"><\/script>/.test(html)
    ? readFileSync(new URL('./xpizza-kitchen/availability-reducer.js', import.meta.url), 'utf8') : '';
  const out = {};
  for (const [c, v] of Object.entries(ENTRY_CASES)) {
    const ctx = { window: {} }; vm.createContext(ctx);
    vm.runInContext(readFileSync(new URL('./xpizza-kitchen/avail-key.js', import.meta.url), 'utf8'), ctx);
    if (reducerTag) vm.runInContext(reducerTag, ctx);
    vm.runInContext(`var availFlags = ${JSON.stringify(mapWith([['Carnivora', v]]))};\n${fnSrc('availKeyOf')}\n${fnSrc('isItemOff')}`, ctx);
    out[c] = vm.runInContext('isItemOff("Carnivora")', ctx);
  }
  return out;
}

export async function computeDecisions() {
  const res = {
    server: await serverDecisions(),
    x_pizza_form: await formDecisions('xpizza-orders', { id: 2, name: 'Carnivora' }, true),
    la_musa_form: await formDecisions('la-musa-orders', { id: 'dimsum_01', name: 'Sichuan Spicy Wonton' }, false),
    kds: kdsDecisions(),
  };
  for (const d of OPEN.splice(0)) { try { d.window.close(); } catch (_) {} }
  return res;
}
