// REVIEW ONLY — the H1b fidelity harness (PLAN-H1b T7 "screenshot each prototype state beside the build at 360×720").
//   proto: the approved prototype's OWN logic (its <script> Component, run on a 6-line DCLogic shim) driven by its own handlers.
//   build: view.js buildVM on fixture state (real /orders shapes, a synthetic third brand).
// Both render through tmpl.js with the shipped styles.css. Sets window.__ready when painted.
import { compile } from '../../xpizza-handheld/tmpl.js';
import { buildVM } from '../../xpizza-handheld/view.js';
import { fixture } from './fixtures.js';

const qs = new URLSearchParams(location.search);
const side = qs.get('side') || 'build';
const state = qs.get('state') || 'login';
const MIN = 60000;
const noop = () => {};

async function protoRender() {
  const src = await (await fetch('../../xpizza-handheld/spec/P-prototipo.dc.html')).text();
  const a = src.indexOf('<div class="phone">') + '<div class="phone">'.length;
  const b = src.indexOf('<div style="flex:1;display:flex;flex-direction:column;gap:14px;min-width:0">');
  let phone = src.slice(a, b); phone = phone.slice(0, phone.trimEnd().lastIndexOf('</div>'));
  const js = src.slice(src.indexOf('data-dc-script'), src.lastIndexOf('</script>'));
  const code = js.slice(js.indexOf('>') + 1);
  class DCLogic { constructor(props) { this.props = props; this.state = {}; } setState(p) { Object.assign(this.state, typeof p === 'function' ? p(this.state) : p); } }
  const Component = new Function('DCLogic', `${code}\nreturn Component;`)(DCLogic);
  const c = new Component({});
  c.audio = () => null; c.beep = noop;                 // silent in review
  const v = () => c.renderVals();
  const press = (digits) => (x) => { for (const d of digits) { const k = v().keys.find((kk) => kk.label === d); k.press(); } };
  const setup = ['skipSetup'];
  const toDetailNew = [...setup, 'simNew', (x) => x.openAlert()];
  const toDetailPrep = [...toDetailNew, (x) => x.d.accept(), (x) => x.prepCards[0].open()];
  const STEPS = {
    login: [], branch: ['goBranch'], checks: ['goBranch', 'goChecks'], pin: ['goBranch', 'goChecks', 'fixBattery', 'goPinCreate'],
    empty: setup, alert: [...setup, 'simNew'], alertAmber: [...setup, 'simNew', 'ff1', 'ff1'], alertRed: [...setup, 'simNew', 'ff5'],
    detailNew: toDetailNew, reject: [...toDetailNew, 'openReject'], rejectItems: [...toDetailNew, 'openReject', (x) => x.reasons[0].pick(), 'toItems'],
    prepList: [...toDetailNew, (x) => x.d.accept()], detailPrep: toDetailPrep, more: [...toDetailPrep, 'openMore'],
    ready: [...toDetailPrep, (x) => x.d.ready()], status: [...setup, 'openStatus'], busySheet: [...setup, 'openStatus', 'toBusy'],
    pauseSheet: [...setup, 'openStatus', 'toPause'], busyDetail: [...setup, 'openStatus', 'toBusy', 'confirmBusy', 'simNew', (x) => x.openAlert()],
    offline: [...setup, 'toggleNet'], agotados: [...setup, 'openStatus', 'goAgotados'], pinPrompt: [...setup, 'openStatus', 'goPinPrompt'],
    settings: [...setup, 'openStatus', 'goPinPrompt', press('1234')], logout: [...setup, 'openStatus', 'goPinPrompt', press('1234'), 'askLogout'],
  };
  for (const s of STEPS[state] || []) { const x = v(); if (typeof s === 'function') s(x); else x[s](); }
  clearTimeout(c._tt); clearTimeout(c._ft); c.state.entered = null;
  return compile(phone).render(v()).html;
}

async function buildRender() {
  const html = await (await fetch('../../xpizza-handheld/index.html')).text();
  const tpl = html.slice(html.indexOf('<template id="screen">') + 22, html.indexOf('</template>'));
  const { S, ctx } = fixture(state);
  return compile(tpl).render(buildVM(S, ctx)).html;
}

(side === 'proto' ? protoRender() : buildRender()).then((html) => {
  document.getElementById('app').innerHTML = html;
  document.fonts.ready.then(() => { window.__ready = true; });
}, (e) => { document.getElementById('app').textContent = `harness error: ${e && e.stack}`; window.__ready = true; });
