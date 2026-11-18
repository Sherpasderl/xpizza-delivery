'use strict';
/* S2b (PLAN-structure-S2b-r3 §2.5) — the extras' counterpart: { "<display id>": key } for EVERY served extra, ONLY when the version records
   an affected extra (frozen_extra_keys non-empty) — otherwise null, and the endpoint body is today's. The extra_id overlay reads it too, so
   a renamed / minted extra is decorated by its ACTUAL key. */
function servedExtraKeyMap(menu) {
  const fx = menu && menu.frozenExtraKeys;
  if (!fx || typeof fx !== 'object' || !Object.keys(fx).length) return null;
  const m = new Map();
  for (const e of ((menu && Array.isArray(menu.extras)) ? menu.extras : [])) {
    if (e && typeof e.key === 'string' && e.key && e.display && e.display.id != null) m.set(String(e.display.id), e.key);
  }
  return m;
}
function withServedExtraKeys(body, extraKeyById) {
  if (!extraKeyById || !body || typeof body !== 'object' || !Array.isArray(body.extras)) return body;
  const extra_keys = {};
  for (const rec of body.extras) if (rec && rec.id != null && extraKeyById.has(String(rec.id))) extra_keys[String(rec.id)] = extraKeyById.get(String(rec.id));
  return { ...body, extra_keys };
}

module.exports = { servedExtraKeyMap, withServedExtraKeys };
