// «Rendimiento» · Ventas — the NON-DRAWING half (PLAN-portal-rendimiento-r0 §3, advisor ACCEPTED 11-14): cached-first loading of the
// stats answer (rule 7: no awaited network on the tab's first paint, no pop-in). DOM-free: the drawing half (MOCKUP-portal-rendimiento-
// ventas-delta, owed) wires `paint` / `stamp` / `fail` to the screen. The shipped page's request path (ventas.js) is untouched.
//
//   · ONE call per load: a single branch → getSalesStats { restaurantId }; «Todas las sucursales» → getSalesStatsMulti { restaurantIds }
//     (5f S2, stats-api.js:285/338 @ d601ce505: merged ON THE SERVER, any branch 503 ⇒ the whole 503). Never N calls added up here.
//   · a session cache keyed uid · scope · range · granularity · compare holds the last good BODY and when it was fetched. A load paints
//     the cached body at once WITH ITS OWN freshness (never «now»), then revalidates silently: an unchanged answer moves only the stamp
//     (no body swap ⇒ no reflow); a changed one swaps the body once. A failed revalidate keeps the cached body and reports the failure.
//   · freshness: a body with a live day (computed_at 'live', the server's 30 s live scan) is as fresh as its FETCH; otherwise it is as
//     fresh as the newest nightly computed_at the server stamped. The screen words it («Actualizado hace N min»); nothing here guesses.
import { granularityFor } from './ventas-logic.js';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PREFIX = 'sherpa.portal.rend.';
const MAX_ENTRIES = 12;   // the session holds at most a dozen bodies (a few KB each); the oldest leaves first

// rids (the page's scope) → { kind: 'one', rid } | { kind: 'many', rids (sorted, distinct) }
export function scopeOf(rids) {
  const list = [...new Set((rids || []).filter((r) => typeof r === 'string' && r))].sort();
  if (!list.length) return null;
  return list.length === 1 ? { kind: 'one', rid: list[0] } : { kind: 'many', rids: list };
}
export const scopeKey = (s) => (s.kind === 'one' ? s.rid : s.rids.join(','));
export function cacheKey(uid, scope, range, compare) {
  return `${PREFIX}${uid}|${scopeKey(scope)}|${range.from}|${range.to}|${granularityFor(range)}|${compare}`;
}

// sessionStorage, every access guarded (a private window / blocked storage = no cache, never a crash)
export function makeCache(storage) {
  const st = () => { try { return storage || (typeof sessionStorage !== 'undefined' ? sessionStorage : null); } catch (_) { return null; } };
  const keys = () => { const s = st(); const out = []; try { for (let i = 0; s && i < s.length; i++) { const k = s.key(i); if (k && k.startsWith(PREFIX)) out.push(k); } } catch (_) { /* none */ } return out; };
  return {
    get(key) {
      try { const v = JSON.parse(st().getItem(key)); return isObj(v) && isObj(v.body) && Number.isFinite(v.fetched_at) ? v : null; } catch (_) { return null; }
    },
    put(key, body, fetchedAt) {
      const s = st();
      try {
        s.setItem(key, JSON.stringify({ body, fetched_at: fetchedAt }));
        const all = keys().map((k) => { try { return [k, JSON.parse(s.getItem(k)).fetched_at]; } catch (_) { return [k, 0]; } }).sort((a, b) => b[1] - a[1]);
        for (const [k] of all.slice(MAX_ENTRIES)) s.removeItem(k);
      } catch (_) { /* full / blocked: the screen still has its body */ }
    },
    clear(uid) { const s = st(); for (const k of keys()) if (uid == null || k.startsWith(`${PREFIX}${uid}|`)) { try { s.removeItem(k); } catch (_) { /* gone */ } } },
  };
}

// a body's freshness (ms): a live day ⇒ when it was fetched; else the newest computed_at the server stamped; none ⇒ null
export function freshness(body, fetchedAt) {
  const days = isObj(body) && Array.isArray(body.days) ? body.days : [];
  if (days.some((d) => d && d.computed_at === 'live')) return fetchedAt;
  const t = days.map((d) => d && Date.parse(d.computed_at)).filter(Number.isFinite);
  return t.length ? Math.max(...t) : null;
}
// key-order-free equality of two answers (the revalidate's «did anything change»)
const canon = (v) => (Array.isArray(v) ? v.map(canon) : isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v);
export const sameBody = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

// ONE load of the tab's stats. api: { getSalesStats, getSalesStatsMulti } (api.js); ui: { paint({ body, freshAt, source }),
// stamp({ freshAt }), fail({ error, hasBody }) }. → the final { source: 'cache+same' | 'cache+swap' | 'network' | 'error', … }
export async function loadStats({ uid, rids, range, compare, token, assertLive, api, cache, now = () => Date.now(), ui }) {
  const scope = scopeOf(rids);
  if (!scope || !uid) throw new Error('loadStats: a uid and at least one branch');
  const key = cacheKey(uid, scope, range, compare);
  const q = { from: range.from, to: range.to, granularity: granularityFor(range), compare, token, assertLive };
  const cached = cache ? cache.get(key) : null;
  if (cached) ui.paint({ body: cached.body, freshAt: freshness(cached.body, cached.fetched_at), source: 'cache' });
  let body;
  try {
    body = scope.kind === 'one' ? await api.getSalesStats({ rid: scope.rid, ...q }) : await api.getSalesStatsMulti({ rids: scope.rids, ...q });
  } catch (error) {
    ui.fail({ error, hasBody: !!cached });
    return { source: 'error', error, cached: !!cached };
  }
  const fetchedAt = now();
  if (cache) cache.put(key, body, fetchedAt);
  const freshAt = freshness(body, fetchedAt);
  if (cached && sameBody(cached.body, body)) { ui.stamp({ freshAt }); return { source: 'cache+same' }; }   // no body swap: no reflow
  ui.paint({ body, freshAt, source: 'network' });
  return { source: cached ? 'cache+swap' : 'network' };
}
