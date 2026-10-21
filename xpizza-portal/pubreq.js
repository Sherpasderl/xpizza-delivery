// PLAN-portal-team-invites T-d — the publish request's two visible ends, to the owner-approved mockup v8:
//   • D1, the OWNER: a calm banner over the editor while a manager's request is pending — «{name} envió N cambios para publicar
//     · {hace …}» (fresh) or «El borrador cambió desde que {name} lo envió» (draft_changed) — with «Ver cambios» and «Revisar y
//     publicar», both opening today's review panel (the editor's own entry, so its locks and admission apply); and the
//     Productos nav badge «1» while the request is fresh.
//   • D2, the MANAGER: «Enviado al dueño para publicar» once app.js's send settled.
// app.js owns the facts and dispatches them (portal:publish-request after every load / post-publish reload; nothing for a
// non-owner, whose response never carries the field); this module only paints. A sign-out clears both at once.
import { toast, setNavBadge } from './shell.js';
import { el, svg, button } from './ops-dom.js';
import { relTime } from './team-logic.js';

const host = () => document.getElementById('pubreq');
const openReview = () => { const r = document.getElementById('review'); if (r && !r.disabled) r.click(); };

export function bannerCopy(req, now) {
  if (!req || (req.state !== 'fresh' && req.state !== 'draft_changed')) return null;
  const who = typeof req.by_name === 'string' && req.by_name.trim() ? req.by_name : 'Un gerente';
  if (req.state === 'draft_changed') return { stale: true, text: `El borrador cambió desde que ${who} lo envió`, when: '' };
  const c = req.counts || {};
  const n = (c.changed | 0) + (c.added | 0) + (c.removed | 0);
  return { stale: false, text: `${who} envió ${n} ${n === 1 ? 'cambio' : 'cambios'} para publicar`, when: ` · ${relTime(req.at, now)}` };
}

function paint(req) {
  const h = host();
  const copy = bannerCopy(req, Date.now());
  setNavBadge('menu', req && req.state === 'fresh' ? '1' : null);
  if (!h) return;
  if (!copy) { h.replaceChildren(); h.classList.add('hidden'); return; }
  const b = el('div', 'pbanner');
  b.setAttribute('role', 'status');
  const ic = el('div', copy.stale ? 'pbi pbis' : 'pbi');
  ic.setAttribute('aria-hidden', 'true');
  ic.append(copy.stale ? svg({ tag: 'circle', cx: 12, cy: 12, r: 9 }, 'M12 7v5l3 2') : svg('M4 4h16v12H8l-4 4z', 'M8 9h8M8 12h5'));
  const t = el('div', 'pbt', copy.text);
  if (copy.when) t.append(el('span', 'pwhen', copy.when));
  const a = el('div', 'pba');
  a.append(button('btn ptext', 'Ver cambios', openReview), button('btn accent', 'Revisar y publicar', openReview));
  b.append(ic, t, a);
  h.replaceChildren(b);
  h.classList.remove('hidden');
}

document.addEventListener('portal:publish-request', (e) => paint(e && e.detail ? e.detail.request : null));
document.addEventListener('portal:publish-request-sent', () => toast('Enviado al dueño para publicar'));
document.addEventListener('portal:auth', () => paint(null));
