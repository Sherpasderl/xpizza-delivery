// Portal 2b-2a — the decisions worth testing, in a module free of SDK imports.
//
// app.js reaches the Firebase SDK through auth.js, which imports from a CDN URL that node cannot load.
// Anything that decides something therefore lives here, where a test can reach it; app.js keeps only
// the DOM plumbing. Same reason auth-errors.js exists.
import { ApiError } from './api.js';

// Which restaurant to open. The remembered one only if it is STILL owned — ownership can be revoked,
// and a stale localStorage entry must never decide what gets loaded. The server would refuse it
// anyway; honouring it here would just show the merchant an error instead of their other restaurant.
export function pickRid(restaurants, remembered) {
  if (!Array.isArray(restaurants) || restaurants.length === 0) return null;
  const owned = restaurants.some((r) => r && r.rid === remembered);
  return owned ? remembered : restaurants[0].rid;
}

function showEmpty(title, detail) {
  $('rail').innerHTML = '';
  $('detail').innerHTML = `<div class="empty"><b></b><span></span></div>`;
  $('detail').querySelector('b').textContent = title;      // textContent, never innerHTML: nothing
  $('detail').querySelector('span').textContent = detail;  // from a server response is markup
}

// A typed failure becomes a sentence a merchant can act on. Unavailable says "try again"; NotAuthorized
// says "this account cannot see this" — conflating them sends someone to re-authenticate over an outage.
export function messageFor(err) {
  const kind = err instanceof ApiError ? err.kind : 'Failed';
  return {
    NotSignedIn: ['Tu sesión expiró', 'Ingresá de nuevo para continuar.'],
    NotAuthorized: ['No tenés acceso a este local', 'Tu cuenta no administra este local.'],
    NotFound: ['Este local todavía no tiene menú', 'Escribinos y lo configuramos.'],
    Unavailable: ['No pudimos cargar tu menú', 'Es un problema nuestro, no tuyo. Probá de nuevo en un momento.'],
  }[kind] || ['Algo salió mal', 'Probá de nuevo en un momento.'];
}

