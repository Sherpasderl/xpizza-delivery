// PORTAL-UI 1a — the small DOM helpers the branch screens share (no innerHTML: every value is a text node).
export const $ = (id) => document.getElementById(id);

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

const NS = 'http://www.w3.org/2000/svg';
// a stroke icon from one or more path `d` strings (or {rect}/{circle} specs)
export function svg(...parts) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  for (const p of parts) {
    if (typeof p === 'string') { const e = document.createElementNS(NS, 'path'); e.setAttribute('d', p); s.append(e); continue; }
    const e = document.createElementNS(NS, p.tag);
    for (const [k, v] of Object.entries(p)) if (k !== 'tag') e.setAttribute(k, String(v));
    s.append(e);
  }
  return s;
}
export const ICON = Object.freeze({
  lock: [{ tag: 'rect', x: 5, y: 11, width: 14, height: 10, rx: 2 }, 'M8 11V7a4 4 0 0 1 8 0v4'],
  grid: ['M3 10h18M3 14h18M10 3v18M14 3v18'],
  warn: ['M12 9v4M12 17h.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  err: [{ tag: 'circle', cx: 12, cy: 12, r: 9 }, 'M12 8v5M12 16h.01'],
  back: ['M15 6l-6 6 6 6'],
  chev: ['M9 6l6 6-6 6'],
  pause: [{ tag: 'rect', x: 6, y: 5, width: 4, height: 14, rx: 1 }, { tag: 'rect', x: 14, y: 5, width: 4, height: 14, rx: 1 }],
  play: ['M7 5l12 7-12 7z'],
  close: ['M6 6l12 12M18 6L6 18'],
  check: ['M5 12l5 5 9-10'],
  photo: [{ tag: 'rect', x: 3, y: 5, width: 18, height: 14, rx: 2 }, { tag: 'circle', cx: 9, cy: 10, r: 1.5 }, 'M21 15l-5-4-8 7'],
  info: [{ tag: 'circle', cx: 12, cy: 12, r: 9 }, 'M12 11v5M12 8h.01'],   // slice 2: «Cómo vincular un equipo»
});
export const icon = (name) => svg(...ICON[name]);

export function button(cls, label, onClick, { aria, iconName } = {}) {
  const b = el('button', cls);
  b.type = 'button';
  if (iconName) b.append(icon(iconName));
  if (label !== undefined && label !== null && label !== '') b.append(document.createTextNode(String(label)));
  if (aria) b.setAttribute('aria-label', aria);
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// a toggle switch (aria-pressed = available)
export function toggle(on, aria, onClick) {
  const b = el('button', `tog${on ? '' : ' off'}`);
  b.type = 'button';
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.setAttribute('aria-label', aria);
  b.append(el('i'));
  b.addEventListener('click', onClick);
  return b;
}

export function pill(cls, label) {
  const p = el('span', `pill ${cls}`);
  p.append(el('i'), document.createTextNode(label));
  return p;
}

export function topBlock(title, lede, actions) {
  const top = el('div', 'top');
  const left = el('div');
  const h = el('h1', null, title);
  left.append(h);
  if (lede) left.append(el('p', 'lede', lede));
  top.append(left);
  if (actions && actions.length) { const a = el('div', 'topact'); a.append(...actions); top.append(a); }
  return { top, h };
}

export function errBox(title, detail, onRetry) {
  const box = el('div', 'errbox');
  box.append(icon('err'));
  const t = el('div');
  t.append(el('b', null, title), el('p', null, detail));
  box.append(t);
  if (onRetry) box.append(button('btn', 'Reintentar', onRetry));
  return box;
}

export function skeleton() {
  const s = el('div', 'skel');
  s.setAttribute('aria-busy', 'true');
  s.append(el('i', 'h'), el('i'), el('i'), el('i'), el('i'));
  return s;
}

export function emptyState(title, detail) {
  const d = el('div', 'detail opsempty');
  const e = el('div', 'empty');
  e.append(el('b', null, title), el('span', null, detail));
  d.append(e);
  return d;
}

export const OFFLINE = Object.freeze(['Sin conexión con Sherpa', 'Tus datos están a salvo. Revisá tu internet y volvé a intentar; si sigue igual, escribinos por WhatsApp.']);
