// Portal 1D · D4-b — the KDS 86 machinery, driven through a CONCURRENT two-tablet scenario (PLAN-D4b §C.3).
//
// The KDS's availability block — availFlags / availPending / isItemOff / renderAvailPanel / toggleAvail — is
// lifted out of an xpizza-kitchen/index.html TEXT (today's, or the base commit's) and run in a sandbox with a
// minimal document and a controllable XPD.setItemAvailability. Tablet A toggles a key (its write pending),
// tablet B's write for the SAME key arrives through the subscription (whole-map replacement), then A's write
// is REJECTED (revert to the saved value). The panel HTML and the next-toggle direction are recorded after
// every step. D4-b must reproduce the base trace exactly: in 'any_false' mode the optimistic / subscription /
// revert machinery is unchanged.
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

export function kdsTrace(html, { reducerSrc = null } = {}) {
  const start = html.indexOf('let availFlags = {};');
  const end = html.indexOf('function startAvailPanel(');
  if (start < 0 || end < start) throw new Error('KDS availability block not found');
  const block = html.slice(start, end);
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', hidden: true, textContent: '', classList: { toggle() { return false; } }, setAttribute() {} });
  let settle = null;
  const ctx = {
    console, setTimeout: () => 0, clearTimeout: () => {},
    document: { getElementById: (id) => el(id) },
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    XPD: { setItemAvailability: () => new Promise((resolve, reject) => { settle = { resolve, reject }; }) },
    AVAIL_RID: 'x_pizza',
  };
  vm.createContext(ctx);
  vm.runInContext('var window = this;', ctx);           // in a browser the UMD globals ARE window's
  vm.runInContext(readFileSync(new URL('./xpizza-kitchen/avail-key.js', import.meta.url), 'utf8'), ctx);
  if (reducerSrc) vm.runInContext(reducerSrc, ctx);
  vm.runInContext(`var availManifest = [{key:'Carnivora',label:'Carnívora',category:'individual'},{key:'Margherita',label:'Margherita',category:'individual'}];\n${block}\n
    this.__api = { setFlags: (f) => { availFlags = f || {}; renderAvailPanel(); }, toggle: (k) => toggleAvail(k), off: (k) => isItemOff(k), pending: () => JSON.stringify(availPending) };`, ctx);
  const api = ctx.__api;
  const snap = (label) => ({ label, panel: el('avail-panel').innerHTML, summary: el('avail-summary-list').innerHTML, pending: api.pending(),
    nextIsAvailable_Carnivora: api.off('Carnivora'), note: el('avail-note').textContent });
  return (async () => {
    const steps = [];
    api.setFlags({ [ctx.availKey('Carnivora')]: { available: true, updated_at: 100 } });
    steps.push(snap('initial: Carnivora available'));
    const p = api.toggle('Carnivora');                                   // tablet A: 86 it (optimistic + pending)
    steps.push(snap('tablet A pending (optimistic off)'));
    api.toggle('Carnivora');                                             // a second tap while pending is ignored
    steps.push(snap('tablet A tap while pending (ignored)'));
    api.setFlags({ [ctx.availKey('Carnivora')]: { available: false, updated_at: 300 }, [ctx.availKey('Margherita')]: { available: false, updated_at: 310 } });   // tablet B's writes land (whole-map replace)
    steps.push(snap('tablet B write arrives via subscription'));
    settle.reject(new Error('PERMISSION_DENIED'));                       // tablet A's write rejected → revert
    await p;
    steps.push(snap('tablet A rejected → revert'));
    const p2 = api.toggle('Carnivora');                                  // the next toggle's direction comes from the displayed state
    steps.push(snap('next toggle'));
    settle.resolve(); await p2;
    steps.push(snap('next toggle acknowledged'));
    return steps;
  })();
}
