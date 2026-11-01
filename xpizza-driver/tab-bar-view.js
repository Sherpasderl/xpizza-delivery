// tab-bar-view.js — the bottom navigation bar (ledger O6 / prototype `tabs()`): Inicio · Pedidos · Ganancias · Cuenta.
// PURE builder. DATA-GATED: a tab renders only when its screen has a real destination AND real data. Inicio and Cuenta
// are always present; Pedidos renders only when an order-history screen exists; Ganancias only after Pagos (R2). The
// HOST owns which SCREENS draw the bar (offshift + the on-shift idle/standby states + Cuenta — never during an offer,
// a pickup, a delivery, or a money-close screen, matching the prototype) and wires the data-tab clicks.
//
// Icons are the prototype's (home/list/wallet/user); fill/stroke come from the .tabs CSS (stroke:currentColor), so the
// active colour follows .tab-btn.on.
const TAB_ICONS = {
  inicio: '<svg viewBox="0 0 24 24"><path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/></svg>',
  pedidos: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
  ganancias: '<svg viewBox="0 0 24 24"><rect x="3" y="6.5" width="18" height="11" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6.5 9.5v5M17.5 9.5v5"/></svg>',
  cuenta: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.5" r="3.6"/><path d="M5 19.5c1.3-3.2 4-4.8 7-4.8s5.7 1.6 7 4.8"/></svg>',
};
// Fixed order (prototype). `always`: Inicio + Cuenta anchor the bar. `gate`: the opts flag that must be true for the
// tab to appear — a dormant destination (Pedidos → an order-history screen; Ganancias → Pagos, R2) stays hidden until
// the host passes it true, so the bar never shows a dead end.
const TAB_DEFS = [
  { key: 'inicio', label: 'Inicio', always: true },
  { key: 'pedidos', label: 'Pedidos', gate: 'showPedidos' },
  { key: 'ganancias', label: 'Ganancias', gate: 'showGanancias' },
  { key: 'cuenta', label: 'Cuenta', always: true },
];

// The tabs that render, given the gating. Pure — the single source of the data-gating decision (tested directly).
export function visibleTabs(opts = {}) {
  return TAB_DEFS.filter((t) => t.always || opts[t.gate] === true);
}

// The bar markup. `active` is the key of the current tab ('inicio' | 'cuenta' | …). grid columns = the visible count,
// so the bar stays centred whether 2 or 4 tabs show. Buttons carry data-tab for the host's click wiring.
export function tabBarHtml(active, opts = {}) {
  const vis = visibleTabs(opts);
  const btns = vis.map((t) =>
    `<button class="tab-btn${active === t.key ? ' on' : ''}" type="button" data-tab="${t.key}" aria-label="${t.label}"${active === t.key ? ' aria-current="page"' : ''}>${TAB_ICONS[t.key]}<span>${t.label}</span></button>`,
  ).join('');
  return `<nav class="tabs" style="grid-template-columns:repeat(${vis.length},1fr)">${btns}</nav>`;
}
