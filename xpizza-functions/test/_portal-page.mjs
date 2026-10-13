// The PORTAL page, as app-loads.test.mjs runs it, for emulator suites that must drive the portal's OWN handlers (codex
// portal-A r1). installDom is copied verbatim from xpizza-portal/app-loads.test.mjs (that file runs its tests on import, so
// it cannot be imported); loadPortalApp rewrites ONLY app.js's CDN-bound auth import to a stub whose token() returns the
// caller's token — everything else is the real portal code.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORTAL = join(dirname(fileURLToPath(import.meta.url)), '../../xpizza-portal');

// Only the ids app.js touches while evaluating, plus the ones its handlers reach for.
const IDS = ['switcher', 'switchmenu', 'discard', 'review', 'pubback', 'pubbtn', 'scrim', 'mbody',
  'revSub', 'revFoot', 'revTitle', 'drawer', 'rail', 'detail', 'rbar', 'rbtxt', 'shopname', 'shopsub',
  'whoami', 'avatar', 'logout', 'detailempty'];

export function installDom() {
  const mk = (tag, id) => {
    const n = {
      tag, id, children: [], attrs: {}, listeners: {}, _class: '', dataset: {}, style: {},
      disabled: false, title: '', value: '', checked: false, textContent: '',
      get className() { return n._class; },
      set className(v) { n._class = v; },
      classList: {
        add: (c) => { n._class = `${n._class} ${c}`.trim(); },
        remove: (c) => { n._class = n._class.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        toggle: (c, on) => { if (on) n.classList.add(c); else n.classList.remove(c); },
        contains: (c) => n._class.split(/\s+/).includes(c),
      },
      append: (...cs) => n.children.push(...cs),
      prepend: (...cs) => n.children.unshift(...cs),
      replaceChildren: (...cs) => { n.children = [...cs]; },
      setAttribute: (k, v) => { n.attrs[k] = v; },
      removeAttribute: (k) => { delete n.attrs[k]; },
      addEventListener: (ev, fn) => { (n.listeners[ev] = n.listeners[ev] || []).push(fn); },
      // REAL descendant queries and focus. The previous shim returned no descendants and modelled no
      // focus, so it could not see whether the drawer's inputs were disabled or blurred — which is
      // precisely what the inert-ownership fixes are about. A shim that cannot observe the thing under
      // test makes every assertion about it vacuous.
      querySelectorAll: (sel) => {
        const want = String(sel).split(',').map((x) => x.trim());
        const out = [];
        (function walkDown(node) {
          for (const c of node.children || []) {
            if (want.includes(c.tag) || want.some((w) => w.startsWith('.') && String(c._class).split(/\s+/).includes(w.slice(1)))) out.push(c);
            walkDown(c);
          }
        })(n);
        return out;
      },
      querySelector: (sel) => n.querySelectorAll(sel)[0] || null,
      contains: (el) => { let found = false; (function walkDown(node) { for (const c of node.children || []) { if (c === el) found = true; walkDown(c); } })(n); return found; },
      closest: () => null,
      focus: () => { globalThis.document.activeElement = n; },
      blur: () => { if (globalThis.document.activeElement === n) globalThis.document.activeElement = null; },
    };
    return n;
  };
  const byId = new Map(IDS.map((id) => [id, mk('div', id)]));
  globalThis.document = {
    _byId: byId,
    getElementById: (id) => byId.get(id) || null,
    createElement: (t) => mk(t, null),
    createElementNS: (_ns, t) => mk(t, null),
    createTextNode: (t) => ({ tag: '#text', children: [], textContent: String(t), _class: '' }),
    querySelector: () => null,
    querySelectorAll: () => [],
    // A REAL listener registry, not a no-op. app.js's document-level wiring — portal:auth,
    // portal:signed-in, portal:restaurant — is exactly the surface these interleaving tests drive, and
    // a shim that swallowed listeners would make every one of them pass without running anything.
    _listeners: {},
    addEventListener: (ev, fn) => { (globalThis.document._listeners[ev] = globalThis.document._listeners[ev] || []).push(fn); },
    dispatchEvent: (evt) => { for (const fn of (globalThis.document._listeners[evt.type] || [])) fn(evt); return true; },
    documentElement: mk('html', null),
    activeElement: null,
  };
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  globalThis.CustomEvent = class { constructor(t, o) { this.type = t; Object.assign(this, o); } };
  globalThis.CSS = { escape: (s) => String(s) };
  return byId;
}

export async function loadPortalApp(token) {
  const stub = join(PORTAL, '__auth-stub.emu.mjs');
  const tmp = join(PORTAL, `__app-under-emu.${Date.now()}.mjs`);
  writeFileSync(stub, `export const token = async () => ${JSON.stringify(token)};\nexport const login = async () => {};\nexport const logout = async () => {};\nexport const authErrorMessage = () => "";\n`);
  const src = readFileSync(join(PORTAL, 'app.js'), 'utf8').replace(/from '\.\/auth\.js'/g, "from './__auth-stub.emu.mjs'");
  writeFileSync(tmp, src);
  try { return await import(`${pathToFileURL(tmp).href}?t=${Date.now()}`); }
  finally { try { unlinkSync(tmp); } catch (_) {} try { unlinkSync(stub); } catch (_) {} }
}
export const fire = async (n, ev = 'click') => { for (const f of (n.listeners[ev] || [])) await f({ preventDefault() {}, target: n }); };
export async function setVal(n, v, ev = 'input') { n.value = v; await fire(n, ev); }
