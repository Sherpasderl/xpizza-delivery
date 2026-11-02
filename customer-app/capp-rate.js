// Customer app — the post-delivery RATING sheet (PLAN-capp-website-and-leader-features §C-2; MOCKUP-capp-desktop-D3 r3 §9.2, approved;
// the advisor's C-2 rulings 2026-11-02). Pure HTML + the send diff from a view model — no DOM, no I/O, no clock: the shell
// (capp-shell-ui) owns state, the reads (getMyRating) and the write (rateOrder).
//   · members only (the server has no guest path) — the shell draws no entry for a guest;
//   · the restaurant 1–5 (+ its word), one thumbs row per DISTINCT purchased dish the store's menu can NAME (never an unlabeled or
//     unpurchased row), the delivery thumbs on a delivery only («Tu repartidor de Sherpa» — one rule, no name), an optional comment;
//   · «Enviar» sends ONLY what the customer set (a first rating) or changed (an edit); `dishes` goes WHOLE when any vote changed (the
//     writer replaces that map), keeping earlier votes the sheet could not show;
//   · past the 7-day window a rating is shown read-only.
// Brand-agnostic: every store difference is data.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CappRate = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // MOCKUP D-3 r3 §9.2's own glyphs
  const STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4 6.1 20.5l1.2-6.5L2.5 9.4l6.6-.9z"/></svg>';
  const THUMB = (down) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"${down ? ' style="transform:scaleY(-1)"' : ''}><path d="M7 11v9H4v-9z"/><path d="M7 11l4-7a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2.3l-1 6A2 2 0 0 1 17 20H7"/></svg>`;
  // «Muy bueno» is the mockup's; the other four are OWNER-PENDING (advisor 11-02: standard words, reviewed at the side-by-side)
  const WORDS = ['Malo', 'Regular', 'Bueno', 'Muy bueno', 'Excelente'];
  const COMMENT_MAX = 500, DISHES_MAX = 30;
  const DISH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  const thumb = (v) => (v === 1 || v === -1 ? v : null);

  // the dishes the sheet offers: the order's DISTINCT canonical dish ids, in order, that the store's menu NAMES (`nameOf(id)` → string|null)
  function dishesOf(ids, nameOf) {
    const out = [], seen = new Set();
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id !== 'string' || !DISH_ID_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      const name = typeof nameOf === 'function' ? nameOf(id) : null;
      if (typeof name === 'string' && name.trim()) out.push({ id, name: name.trim() });
      if (out.length >= DISHES_MAX) break;
    }
    return out;
  }
  const blank = () => ({ store: null, dishes: {}, delivery: null, comment: '' });
  // the sheet's starting value from a getMyRating rating (null ⇒ blank)
  const fromRating = (r) => (r ? { store: Number.isInteger(r.store) ? r.store : null, dishes: { ...(r.dishes || {}) }, delivery: thumb(r.delivery), comment: typeof r.comment === 'string' ? r.comment : '' } : blank());
  const norm = (c) => { const t = String(c || '').trim(); return t ? t.slice(0, COMMENT_MAX) : null; };
  const sameMap = (a, b) => { const ka = Object.keys(a).sort(), kb = Object.keys(b).sort(); return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]); };

  // what «Enviar» sends. initial = the stored rating (null for a first rating); value = the sheet's; offered = the dish ids shown
  function fieldsToSend(initial, value, offered) {
    const v = value || blank(), shown = new Set(offered || []), f = {};
    const votes = Object.fromEntries(Object.entries(v.dishes || {}).filter(([k, x]) => shown.has(k) && thumb(x) !== null));
    if (!initial) {
      if (Number.isInteger(v.store)) f.store = v.store;
      if (Object.keys(votes).length) f.dishes = votes;
      if (thumb(v.delivery) !== null) f.delivery = v.delivery;
      if (norm(v.comment)) f.comment = norm(v.comment);
      return f;
    }
    const i = fromRating(initial);
    if (v.store !== i.store) f.store = Number.isInteger(v.store) ? v.store : null;
    // the WHOLE map (the writer replaces it): the earlier votes the sheet could not show stay as they were
    const kept = Object.fromEntries(Object.entries(i.dishes).filter(([k]) => !shown.has(k)));
    const next = { ...kept, ...votes };
    if (!sameMap(next, i.dishes)) f.dishes = next;
    if (thumb(v.delivery) !== i.delivery) f.delivery = thumb(v.delivery);
    if (norm(v.comment) !== norm(i.comment)) f.comment = norm(v.comment);
    return f;
  }

  // vm: { storeName, num, dishes:[{id,name}], delivery:bool, value, initial, editable, sending, error }
  function sheetHtml(vm) {
    const v = vm.value || blank(), ed = vm.editable === true, off = ed ? '' : ' disabled';
    const s = Number.isInteger(v.store) ? v.store : 0;
    const stars = [1, 2, 3, 4, 5].map((i) => `<button class="${i <= s ? 'on' : ''}" data-act="rate-star" data-val="${i}" aria-label="${i} de 5" aria-pressed="${i === s}"${off}>${STAR}</button>`).join('');
    const thumbs = (act, id, val, up, down) => `<span class="thumbs"><button class="${val === 1 ? 'on' : ''}" data-act="${act}"${id ? ` data-id="${esc(id)}"` : ''} data-val="1" aria-label="${up}" aria-pressed="${val === 1}"${off}>${THUMB(false)}</button><button class="${val === -1 ? 'on' : ''}" data-act="${act}"${id ? ` data-id="${esc(id)}"` : ''} data-val="-1" aria-label="${down}" aria-pressed="${val === -1}"${off}>${THUMB(true)}</button></span>`;
    const dishes = (vm.dishes || []).length ? `<div><div class="lbl">Los platos</div><div class="rrows">${vm.dishes.map((d) => `<div class="rrow2"><span class="t">${esc(d.name)}</span>${thumbs('rate-dish', d.id, thumb((v.dishes || {})[d.id]), 'Me gustó', 'No me gustó')}</div>`).join('')}</div></div>` : '';
    const delivery = vm.delivery ? `<div><div class="lbl">La entrega</div><div class="rrows"><div class="rrow2"><span class="t">Tu repartidor de Sherpa</span>${thumbs('rate-del', null, thumb(v.delivery), 'Bien', 'Mal')}</div></div></div>` : '';
    const sendable = ed && !vm.sending && Object.keys(fieldsToSend(vm.initial || null, v, (vm.dishes || []).map((d) => d.id))).length > 0;
    const sub = [vm.storeName, vm.num ? `Orden #${vm.num}` : null].filter(Boolean).map(esc).join(' · ');
    return `<div class="scrim"></div><div class="sheet rate-modal" role="dialog" aria-modal="true" aria-labelledby="rate-h"><div class="grab"></div>
    <div class="rate"><h2 id="rate-h" tabindex="-1">¿Cómo estuvo tu pedido?</h2>${sub ? `<p class="sub">${sub}</p>` : ''}
    <div><div class="lbl">El restaurante</div><div class="stars" role="radiogroup" aria-label="Calificación del restaurante">${stars}<span class="word">${s ? WORDS[s - 1] : ''}</span></div></div>
    ${dishes}${delivery}
    <div><label class="lbl" for="rate-comment">Comentario <span class="opt">· opcional, lo lee el restaurante</span></label><textarea id="rate-comment" data-field="rate-comment" maxlength="${COMMENT_MAX}" placeholder="¿Algo que el restaurante deba saber?"${off}>${esc(v.comment || '')}</textarea></div>
    ${vm.error ? `<p class="rate-err" role="alert">${esc(vm.error)}</p>` : ''}
    <div class="acts">${ed ? `<button class="primary" data-act="rate-send"${sendable ? '' : ' disabled'}${vm.sending ? ' aria-busy="true"' : ''}>Enviar</button>` : ''}<button class="btn2 wide" data-act="rate-later">${ed ? 'Ahora no' : 'Cerrar'}</button></div>
    <p class="fine">Tu calificación es anónima para el restaurante.${ed ? ' Podés cambiarla durante 7 días desde Pedidos.' : ''}</p></div></div>`;
  }

  // the delivered order screen's entry (frame 9.2 left): 'pending' reserves the button's box while the read is in flight (no reflow)
  function ctaHtml(state) {
    if (state === 'rate' || state === 'pending') return `<button class="primary rate-cta" data-act="order-rate"${state === 'pending' ? ' disabled tabindex="-1" aria-hidden="true" style="visibility:hidden"' : ''}>${STAR}Valorar tu pedido</button>`;
    if (state === 'rated') return '<button class="btn2 wide rate-cta" data-act="order-rate">Ver tu calificación</button>';
    return '';
  }
  // a Pedidos past row's line (frame 9.3): «Valorar» · «★ n tu calificación» · «Sin calificar»; 'pending' keeps the line's box empty
  function lineHtml(state, oid, stars) {
    const id = esc(oid);
    if (state === 'pending') return '<div class="rate-line" aria-hidden="true"></div>';
    if (state === 'rate') return `<div class="rate-line"><button class="rate-go" data-act="rate-open" data-oid="${id}">Valorar</button></div>`;
    if (state === 'rated') return `<div class="rate-line"><button class="rate-go mine" data-act="rate-open" data-oid="${id}">${Number.isInteger(stars) ? `<span class="rating">${STAR}${stars}</span>` : ''}<span>tu calificación</span></button></div>`;
    if (state === 'late') return '<div class="rate-line"><span class="mute">Sin calificar</span></div>';
    return '';
  }

  return { WORDS, COMMENT_MAX, DISHES_MAX, dishesOf, blank, fromRating, fieldsToSend, sheetHtml, ctaHtml, lineHtml };
});
