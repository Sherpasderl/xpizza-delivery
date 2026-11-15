// «Calificaciones» — its OWN nav entry (Nav B, owner 11-14: «Ventas» → «Calificaciones» → «Tu nivel», no Rendimiento tabs; advisor
// ruling). The page header is MOCKUP-portal-calificaciones-color.html's («Calificaciones» + its lede); the body is the approved
// Calificaciones view (calificaciones.js, unchanged). Same owner proof as Ventas: shown to a brand owner who reads stats, and painted
// only for the restaurant the shell announces with `portal:restaurant` (sales !== false — the page's restaurant, never «Todas»).
import { registerView } from './shell.js';
import { token } from './auth.js';
import { el, topBlock } from './ops-dom.js';
import { calificacionesTab } from './calificaciones.js';

const STAR = 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z';
const TITLE = 'Calificaciones';
const LEDE = 'Lo que dicen tus clientes sobre sus pedidos.';
const S = { rid: null, name: null, host: null, pane: null, mounted: false };

function paint() {
  if (!S.host) return;
  if (S.mounted) { calificacionesTab.unmount(); S.mounted = false; }
  const { top } = topBlock(TITLE, LEDE, []);
  S.pane = el('div');
  S.host.replaceChildren(top, S.pane);
  if (!S.rid) return;   // no owner proof yet: the header only (the restaurant arrives with portal:restaurant)
  calificacionesTab.mount(S.pane, { rid: S.rid, token, scopeLabel: S.name || '' });
  S.mounted = true;
}
document.addEventListener('portal:auth', () => {
  if (S.mounted) { calificacionesTab.unmount(); S.mounted = false; }
  S.rid = null; S.name = null;
  if (S.host) S.host.replaceChildren();
});
document.addEventListener('portal:restaurant', (e) => {
  const d = e && e.detail ? e.detail : null;
  if (!d || !d.rid || d.sales === false) return;
  S.rid = d.rid; S.name = typeof d.name === 'string' && d.name ? d.name : null;
  paint();
});

registerView({
  id: 'calificaciones',
  group: 'Negocio',
  label: TITLE,
  icon: STAR,
  visible: (sel) => !!sel && sel.role === 'owner' && sel.caps.includes('stats.read'),
  mount(host) { S.host = host; paint(); },
  unmount() { if (S.mounted) calificacionesTab.unmount(); S.mounted = false; S.host = null; S.pane = null; },
  canLeave: () => true,
});

export const _califViewState = S;   // test-only
