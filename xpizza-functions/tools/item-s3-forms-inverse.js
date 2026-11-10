'use strict';
// S3 (D4c-grill/item-s1/S3-DESIGN.md D3; the owner's rule-40 exception for the two order forms, 11-08) — THE FORMS' S3 HUNKS, as data.
// unapplyItemS3Forms(key, text) removes exactly these hunks — key 'xpizza-orders' | 'la-musa-orders' (a form's index.html) or
// 'form-serial-order' (the shared pin module, both byte-identical copies) or 'account' (account.js, both byte-identical copies)
// — and returns the bytes it had before S3, so a
// guard that pins a form byte-for-byte to an older base (avail-identity-forms-noop) keeps pinning EVERYTHING outside S3. Each hunk must
// occur EXACTLY once (an insertion with the newline before it) — a missing, duplicated or edited hunk throws, so a later edit to an
// S3 line is caught here, and a byte outside every hunk still fails the caller's pin. Generated from the slice's own diff; never hand-edit
// a hunk without its line in the form.
const HUNKS = {
 "xpizza-orders": [
  {
   "kind": "insert",
   "new": ".gate-line{font-family:var(--sans);font-size:13px;color:var(--charcoal);line-height:1.4;margin:-6px 0 11px}   /* S3: the line naming the dish and the option inside the item gate (the approved mockup's one form addition) */\n.gate-line b{font-weight:700}",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    <div class=\"pickup-gate\" id=\"item-gate\" role=\"alert\" style=\"display:none\"></div>",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "/* S3 (D4c-grill/item-s1/S3-DESIGN.md D1/D3): the served { \"<dish id>\": item_key } map — the LIVE menu's only (the baked body never\n   carries it), applied with MENU all-or-nothing; a body without one empties it. liveItemKey: a dish's key, or null (no map ⇒ today's\n   lines). itemKeyFor: a pinned order's key AS FIRST SENT (form-serial-order.js), else the live map's. */\nlet ITEM_KEYS = {};\nfunction liveItemKey(p){ const k = p && ITEM_KEYS[String(p.id)]; return typeof k === 'string' && k ? k : null; }\nfunction itemKeyFor(p, lineKey){ const pinned = SERIAL.itemKey(lineKey, serialPinLive()); return pinned !== undefined ? pinned : liveItemKey(p); }\nfunction itemNameFor(p, lineKey){ const n = SERIAL.sentName(lineKey, serialPinLive()); return n !== undefined ? n : p.name; }   // Codex S3 r1 P2-3: a pinned line keeps the name it was sent with",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  pricingKey:      (r) => liveItemKey(r) || r.name,     // x_pizza is priced server-side BY NAME — a rename is a different product; S3 (ruling 2026-11-10): with the served map the line's identity is the item key, so a rename keeps it",
   "old": "  pricingKey:      (r) => r.name,     // x_pizza is priced server-side BY NAME — a rename is a different product"
  },
  {
   "kind": "replace",
   "new": "  const rows = d.map(e => '<div>' + safeText(priceNoticeText(e)) + '</div>');\n  const s3 = itemNoteText(); if (s3) rows.push('<div>' + safeText(s3) + '</div>');   // S3 D2: what «Quitar extra y seguir» removed + the new total\n  return rows.length ? '<div class=\"price-change-notice\" role=\"status\">' + rows.join('') + '</div>' : '';",
   "old": "  return d.length ? '<div class=\"price-change-notice\" role=\"status\">' + d.map(e => '<div>' + safeText(priceNoticeText(e)) + '</div>').join('') + '</div>' : '';"
  },
  {
   "kind": "replace",
   "new": "const LIVE_MENU_GLOBALS = ['MENU', 'EXTRAS', 'PICKUP_ONLY_CATS', 'WEEKEND_ONLY_CATS', 'VARIANT_ITEMS', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM', 'ITEM_KEYS'];   // PLAN 4 §8.4: + the option maps",
   "old": "const LIVE_MENU_GLOBALS = ['MENU', 'EXTRAS', 'PICKUP_ONLY_CATS', 'WEEKEND_ONLY_CATS', 'VARIANT_ITEMS', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM'];   // PLAN 4 §8.4: + the option maps"
  },
  {
   "kind": "replace",
   "new": "    : n === 'EXTRAS_BY_CATEGORY' ? EXTRAS_BY_CATEGORY : n === 'EXTRAS_BY_ITEM' ? EXTRAS_BY_ITEM : n === 'ITEM_KEYS' ? ITEM_KEYS : WEEKEND_ONLY_CATS;",
   "old": "    : n === 'EXTRAS_BY_CATEGORY' ? EXTRAS_BY_CATEGORY : n === 'EXTRAS_BY_ITEM' ? EXTRAS_BY_ITEM : WEEKEND_ONLY_CATS;"
  },
  {
   "kind": "insert",
   "new": "  else if (n === 'ITEM_KEYS') ITEM_KEYS = v;",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    // S3: the served item-key map — ABSENT EMPTIES it (never «keep in force»: an older snapshot's keys must never label a newer MENU)\n    ITEM_KEYS: isMap(body.item_keys) ? body.item_keys : {},",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  if (window.__itemMenuReload === true) return false;                      // S3 C1: the customer asked for the fresh menu (at Paso 2)",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  const ik = liveItemKey(item); if (ik) { const k = window.availKey(ik); if (seen.indexOf(k) === -1) seen.push(k); }   // S3: the portal / KDS write the item_key",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    let httpStatus = 0;   // S3 P2-5",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "      .then(function(r){ httpStatus = r.status; return r.json(); })   // S3 P2-5: the HTTP status, kept for the item-refusal routing below",
   "old": "      .then(function(r){ return r.json(); })"
  },
  {
   "kind": "replace",
   "new": "        else { __serverQuote.key=null; __serverQuote.cents=null; __serverQuote.failedKey=key;   // ok:false → fail open to calcTotal(), and do not ask again for THIS cart\n          try { if(j && activeStageId()==='s2') itemRefused(httpStatus, j, true); } catch(_){} }   // Codex S3 r1 P2-5: an item refusal → the item gate",
   "old": "        else { __serverQuote.key=null; __serverQuote.cents=null; __serverQuote.failedKey=key; }   // ok:false → fail open to calcTotal(), and do not ask again for THIS cart"
  },
  {
   "kind": "replace",
   "new": "  return GroupPicker.rewardDishes(MENU, VARIANT_ITEMS, p=>p.cat==='individual').map(p=>({ key:liveItemKey(p)||p.name, name:p.name, price_cents:Math.round(p.price*100), icon:p.reward_icon||'star' }));   // PLAN 4 GATED: the published reward_icon (the name-keyed literal map is gone)",
   "old": "  return GroupPicker.rewardDishes(MENU, VARIANT_ITEMS, p=>p.cat==='individual').map(p=>({ key:p.name, name:p.name, price_cents:Math.round(p.price*100), icon:p.reward_icon||'star' }));   // PLAN 4 GATED: the published reward_icon (the name-keyed literal map is gone)"
  },
  {
   "kind": "insert",
   "new": "  if(itemQuoteMissing()){   // Codex S3 r1 P1-2 / r2: the repaired / reloaded cart is not quoted yet — nothing is sent\n    window.__paySubmitting = false; if(_payCta) _payCta.disabled = false;\n    try { requestServerQuote(true); } catch(_){}\n    const _e = document.getElementById('err3'); if(_e){ _e.style.display = 'block'; _e.textContent = 'No pudimos confirmar el precio en este momento. Volvé a intentar en unos segundos — tu pedido está intacto.'; }\n    return;\n  }",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "    const out = {name:itemNameFor(p, line.key),qty:line.qty,price:p.price,subtotal:p.price*line.qty,extras:extrasArr,extrasTotal};",
   "old": "    const out = {name:p.name,qty:line.qty,price:p.price,subtotal:p.price*line.qty,extras:extrasArr,extrasTotal};"
  },
  {
   "kind": "insert",
   "new": "    const ik = itemKeyFor(p, line.key); if(ik) out.item_key = ik;   // S3 D1: appended LAST; a pinned order resends its first key (or none)",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  const id = genOrderId(); SERIAL.mint(resolvedCartLines(), (l) => liveItemKey(l.record)); window.__pendingOrder = { id, sig }; return id;   // §3: pin this order's serialization",
   "old": "  const id = genOrderId(); SERIAL.mint(resolvedCartLines()); window.__pendingOrder = { id, sig }; return id;   // §3: pin this order's serialization"
  },
  {
   "kind": "replace",
   "new": "      return `${qty[p.id]}x ${itemNameFor(p, String(p.id))} (L${p.price})${extrasStr2}`;",
   "old": "      return `${qty[p.id]}x ${p.name} (L${p.price})${extrasStr2}`;"
  },
  {
   "kind": "insert",
   "new": "    if(itemSendRefused()) return;   // Codex S3 r2 P1: no server quote for the cart being sent → nothing is sent",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    if(itemRefused(res.status, cfg)) return;   // S3: menu_changed / extra_not_allowed → Paso 2's item gate (no checkout issued)",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "/* ── S3 (D4c-grill/item-s1/S3-DESIGN.md D3 + the advisor's rulings 2026-11-10; OWNER-APPROVED MOCKUP-item-s3-refusals.html C1/D1/C2/D2):\n   the ITEM REFUSALS of a send. Both land back on Paso 2 with the form's own cart gate (.pickup-gate, #item-gate) in its slot under\n   the Delivery/Pickup toggle. menu_changed: ONE «Recargar la página» — the live menu refreshed IN PLACE through the form's own feed\n   (ruling C1 (A)); only lines whose dish is GONE are dropped, with the existing toast; every other conflict keeps today's block.\n   extra_not_allowed: the server's detail, one naming line per denied option, «Quitar extra y seguir» (removes ONLY those options\n   through the form's own option writer, then the summary re-quotes and the Plan 5 notice says what left and the new total) and\n   «Revisar pedido» (the existing cart review). Nothing is ever re-sent: the customer confirms again. ── */\nconst ITEM_EXTRA_WORD = 'extra';\nlet __itemReloading = false;\n// Codex S3 r1 P1-2 (advisor, MONEY): after a repair or a reload the order is NEVER sent until a successful server quote for THAT\n// cart is in (the redemption's own quote while one is pending, else the order quote), and «Total nuevo» is that quote — never the\n// client arithmetic. processPayment refuses before anything else and says so with the form's existing sentence.\n// Codex S3 r2: a pending reward's quote counts only when it MATCHES the cart on screen (redeemQuoteMatches — the account module's\n// own fail-closed answer); otherwise the reward is re-quoted for it, ONCE per cart, and there is no quote yet\nfunction itemQuotedCents(){\n  try {\n    if(window.__ACCOUNT && window.__ACCOUNT.getRedeemPayload && window.__ACCOUNT.getRedeemPayload()){\n      const items = redeemCartItems();\n      const fresh = typeof window.__ACCOUNT.redeemQuoteMatches === 'function' && window.__ACCOUNT.redeemQuoteMatches(items);\n      const rc = fresh && window.__ACCOUNT.getRedeemQuoteTotalCents ? window.__ACCOUNT.getRedeemQuoteTotalCents() : null;\n      if(rc == null){ const k = JSON.stringify(items); if(window.__itemRedeemAsked !== k){ window.__itemRedeemAsked = k; try { Promise.resolve(window.__ACCOUNT.requoteRedeem(items)).then(function(){ if(window.__ACCOUNT.redeemQuoteMatches(items)){ try { renderStage2Summary(); } catch(_){} } else window.__itemRedeemAsked = null; }, function(){ window.__itemRedeemAsked = null; }); } catch(_){ window.__itemRedeemAsked = null; } } }   // r3: a failed re-quote never latches — and never re-renders (that would re-ask in a loop); the next confirmation asks again\n      return rc == null ? null : rc;\n    }\n    return getServerQuoteTotalCents();\n  } catch(_){ return null; }\n}\n// Codex S3 r2 P1: the requirement holds from the repair / reload until an order COMPLETES (never cleared at a confirmation), and is\n// judged against the cart being sent — at processPayment AND at both send boundaries (the cash send and the card send)\nfunction itemQuoteMissing(){ return window.__itemQuoteRequired === true && itemQuotedCents() == null; }\n// Codex S3 r3: the PAYLOAD being sent is what must be quoted — never the cart on screen (they can drift between build and send)\nfunction itemPayloadQuoted(){\n  try {\n    const items = currentOrder && currentOrder.items;\n    if(window.__ACCOUNT && window.__ACCOUNT.getRedeemPayload && window.__ACCOUNT.getRedeemPayload()) return typeof window.__ACCOUNT.redeemQuoteMatches === 'function' && window.__ACCOUNT.redeemQuoteMatches(items);\n    return __serverQuote.cents != null && __serverQuote.key === JSON.stringify(_legacyCartForSig(items));\n  } catch(_){ return false; }\n}\nfunction itemSendRefused(){\n  if(window.__itemQuoteRequired !== true || (!itemQuoteMissing() && itemPayloadQuoted())) return false;\n  orderSubmitting = false;\n  try { requestServerQuote(true); } catch(_){}\n  showStage('s2', 50);\n  const _e = document.getElementById('err3'); if(_e){ _e.style.display = 'block'; _e.textContent = 'No pudimos confirmar el precio en este momento. Volvé a intentar en unos segundos — tu pedido está intacto.'; }\n  return true;\n}\n// fromQuote (Codex S3 r1 P2-5): a quote's item refusal opens the same gate — menu_changed is the quote's fail-soft 200\nfunction itemRefused(status, err, fromQuote){\n  if(!err || !(status === 409 || (fromQuote && status === 200 && err.error === 'menu_changed'))) return false;\n  if(err.error === 'menu_changed'){ orderSubmitting = false; showStage('s2', 50); showItemGate('menu', null); return true; }\n  if(err.error === 'extra_not_allowed'){\n    const den = itemDenied(err.lines); if(!den.length) return false;   // nothing in this cart matches: today's generic answer\n    orderSubmitting = false; showStage('s2', 50); showItemGate('extra', den); return true;\n  }\n  return false;\n}\n// the cart's (line, option) pairs a refusal names: a dish by its item key (or a legacy key), an option by its legacy key (id or name)\nfunction itemDenied(lines){\n  const out = [];\n  (Array.isArray(lines) ? lines : []).forEach(function(x){\n    if(!x || typeof x.item !== 'string' || typeof x.extra !== 'string') return;\n    resolvedCartLines().forEach(function(l){\n      const p = l.record; if(!p || !(liveItemKey(p) === x.item || p.name === x.item || String(p.id) === x.item)) return;\n      const inst = pizzaExtras[l.key] || {};\n      Object.keys(inst).forEach(function(i){ Object.keys(inst[i] || {}).forEach(function(eid){\n        if(!(inst[i][eid] > 0)) return;\n        const e = lineExtra(l, eid) || findMenuExtra(eid);\n        if(e && (e.name === x.extra || String(e.id) === x.extra)) out.push({ key: l.key, inst: i, eid: eid, dish: p.name, extra: e.name });\n      }); });\n    });\n  });\n  return out;\n}\nfunction showItemGate(kind, den){\n  const g = document.getElementById('item-gate'); if(!g) return;\n  window.__itemDenied = den || null;\n  if(kind === 'menu'){\n    g.innerHTML = '<div class=\"pickup-gate-title\">El menú se actualizó, recargá la página</div><div class=\"pickup-gate-actions\"><button type=\"button\" class=\"pickup-gate-btn primary\" onclick=\"itemReloadMenu()\">Recargar la página</button></div>';\n  } else {\n    const named = []; den.forEach(function(d){ if(!named.some(function(n){ return n.dish === d.dish && n.extra === d.extra; })) named.push(d); });\n    g.innerHTML = '<div class=\"pickup-gate-title\">Uno de los extras ya no está disponible para ese producto. Revisá tu pedido.</div>'\n      + named.map(function(d){ return '<div class=\"gate-line\"><b>' + safeText(d.dish) + '</b> · ' + ITEM_EXTRA_WORD + ': ' + safeText(d.extra) + '</div>'; }).join('')\n      + '<div class=\"pickup-gate-actions\"><button type=\"button\" class=\"pickup-gate-btn primary\" onclick=\"itemRemoveDenied()\">Quitar extra y seguir</button><button type=\"button\" class=\"pickup-gate-btn ghost\" onclick=\"toggleCartReview()\">Revisar pedido</button></div>';\n  }\n  g.style.display = 'block';\n}\nfunction hideItemGate(){ const g = document.getElementById('item-gate'); if(g){ g.style.display = 'none'; g.innerHTML = ''; } window.__itemDenied = null; }\nasync function itemReloadMenu(){\n  if(__itemReloading) return;   // one fetch per tap: a second tap while the first is in flight does nothing\n  __itemReloading = true;\n  const btn = document.querySelector('#item-gate .pickup-gate-btn'); if(btn) btn.disabled = true;\n  let st = null;\n  window.__itemMenuReload = true;   // liveMenuBusy: the customer asked for the fresh menu — it applies now, at Paso 2\n  const A = window.__liveMenu && window.__liveMenu.applier, refused0 = A ? A.state().counts.refused : 0;\n  try { st = await window.__liveMenu.feed.refresh(); } catch(_){ st = null; }\n  // Codex S3 r1 P2-4: a newer menu DEFERRED while Paso 2 was open is applied now too (a 304 never reaches the applier); anything\n  // still pending, or refused, is a FAILED reload — never a false success\n  try { if(A) A.flush(); } catch(_){}\n  window.__itemMenuReload = false; __itemReloading = false;\n  if(!st || st.phase !== 'live' || st.lastError || (A && (A.hasPending() || A.state().counts.refused > refused0 || A.state().lastError))){ if(btn) btn.disabled = false; return; }   // the gate stays, its button live; r2: an unapplied menu (a failed apply, then a 304) is a failure\n  const gone = resolvedCartLines().filter(function(l){ return l.unresolved === 'removed'; }).map(function(l){ return l.key; });\n  gone.forEach(function(k){ const id = /^\\d+$/.test(String(k)) ? Number(k) : k; chg(id, -(CART.qtyOf(k) || 0)); });\n  hideItemGate(); window.__itemQuoteRequired = true;   // P1-2 / r2: from here every send needs the server quote of the cart it sends\n  try { renderStage2Summary(); } catch(_){}\n  try { requestServerQuote(true); } catch(_){}\n  if(gone.length){ try { window.__ACCOUNT.toast(gone.length === 1 ? '1 producto ya no está disponible' : gone.length + ' productos ya no están disponibles'); } catch(_){} }\n}\nfunction itemRemoveDenied(){\n  const den = window.__itemDenied || []; hideItemGate();\n  den.forEach(function(d){ const pid = /^\\d+$/.test(String(d.key)) ? Number(d.key) : d.key; if(((pizzaExtras[d.key] || {})[d.inst] || {})[d.eid] > 0) toggleDetailExtra(d.eid, pid, Number(d.inst)); });   // the form's own option writer\n  const byDish = []; den.forEach(function(d){ let e = byDish.find(function(x){ return x.dish === d.dish; }); if(!e){ e = { dish: d.dish, ex: [] }; byDish.push(e); } if(e.ex.indexOf(d.extra) === -1) e.ex.push(d.extra); });\n  window.__itemQuoteRequired = true;   // P1-2 / r2: from here every send needs the server quote of the cart it sends\n  window.__itemNote = { text: byDish.map(function(e){ return 'Quitamos ' + (e.ex.length > 1 ? e.ex.slice(0, -1).join(', ') + ' y ' + e.ex[e.ex.length - 1] : e.ex[0]) + ' de ' + e.dish + '.'; }).join(' '), sig: cartSig() };\n  try { renderStage2Summary(); } catch(_){}\n}\n// the D2 note — only while the repaired cart is the one on screen; its total is the one the summary shows\nfunction itemNoteText(){\n  const n = window.__itemNote; if(!n) return '';\n  if(n.sig !== cartSig()){ window.__itemNote = null; return ''; }\n  const c = itemQuotedCents(); if(c == null) return '';   // P1-2: shown only with the SERVER quote for this cart\n  return n.text + ' Total nuevo: L ' + (c / 100).toFixed(0) + '.';\n}\n",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "      if(itemSendRefused()) return;   // Codex S3 r2 P1: no server quote for the cart being sent → nothing is sent",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "        if(itemRefused(res.status, err)) return;   // S3: menu_changed / extra_not_allowed → Paso 2's item gate (nothing created)",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  window.__itemQuoteRequired = false;   // S3 r2: the order is over — the next one starts without the requirement",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  window.__itemQuoteRequired = false;   // S3 r2: the order succeeded (the success screen)",
   "old": ""
  }
 ],
 "la-musa-orders": [
  {
   "kind": "insert",
   "new": "/* S3 (OWNER-APPROVED MOCKUP-item-s3-refusals.html E1/F1): the item gate — the X. Pizza form's cart gate, in this form's own tokens */\n.pickup-gate{margin:12px 16px 0;border:1px solid #E7B4A8;background:#FBEAE6;border-radius:12px;padding:13px 14px}\n.pickup-gate-title{font-family:var(--sans);font-size:13.5px;font-weight:700;color:#8f2413;line-height:1.4;margin-bottom:11px}\n.pickup-gate-actions{display:flex;gap:8px}\n.pickup-gate-btn{flex:1;text-align:center;border:0;border-radius:9px;padding:10px 8px;font-family:var(--sans);font-size:12.5px;font-weight:700;cursor:pointer}\n.pickup-gate-btn.primary{background:var(--red);color:#fff}\n.pickup-gate-btn.ghost{background:#fff;color:var(--charcoal);border:1px solid var(--border)}\n.gate-line{font-family:var(--sans);font-size:13px;color:var(--charcoal);line-height:1.4;margin:-6px 0 11px}\n.gate-line b{font-weight:700}",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    <div class=\"pickup-gate\" id=\"item-gate\" role=\"alert\" style=\"display:none\"></div>",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "/* S3 (D4c-grill/item-s1/S3-DESIGN.md D1/D3): the served { \"<dish id>\": item_key } map — the LIVE menu's only (the baked body never\n   carries it), applied with MENU all-or-nothing; a body without one empties it. liveItemKey: a dish's key, or null (no map ⇒ today's\n   lines). itemKeyFor: a pinned order's key AS FIRST SENT (form-serial-order.js), else the live map's. */\nlet ITEM_KEYS = {};\nfunction liveItemKey(p){ const k = p && ITEM_KEYS[String(p.id)]; return typeof k === 'string' && k ? k : null; }\nfunction itemKeyFor(p, lineKey){ const pinned = SERIAL.itemKey(lineKey, serialPinLive()); return pinned !== undefined ? pinned : liveItemKey(p); }\nfunction itemNameFor(p, lineKey){ const n = SERIAL.sentName(lineKey, serialPinLive()); return n !== undefined ? n : p.name; }   // Codex S3 r1 P2-3: a pinned line keeps the name it was sent with",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  const rows = d.map(e => '<div>' + safeText(priceNoticeText(e)) + '</div>');\n  const s3 = itemNoteText(); if (s3) rows.push('<div>' + safeText(s3) + '</div>');   // S3 D2: what «Quitar extra y seguir» removed + the new total\n  return rows.length ? '<div class=\"price-change-notice\" role=\"status\">' + rows.join('') + '</div>' : '';",
   "old": "  return d.length ? '<div class=\"price-change-notice\" role=\"status\">' + d.map(e => '<div>' + safeText(priceNoticeText(e)) + '</div>').join('') + '</div>' : '';"
  },
  {
   "kind": "replace",
   "new": "const LIVE_MENU_GLOBALS = ['MENU', 'EXTRAS', 'CATEGORIES', 'VARIANT_ITEMS', 'HAS_PHOTO', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM', 'TAG_BADGES', 'BADGE_PRIORITY', 'ITEM_KEYS'];   // PLAN 4 §8.4: + the badges and their order",
   "old": "const LIVE_MENU_GLOBALS = ['MENU', 'EXTRAS', 'CATEGORIES', 'VARIANT_ITEMS', 'HAS_PHOTO', 'EXTRAS_BY_CATEGORY', 'EXTRAS_BY_ITEM', 'TAG_BADGES', 'BADGE_PRIORITY'];   // PLAN 4 §8.4: + the badges and their order"
  },
  {
   "kind": "insert",
   "new": "    case 'ITEM_KEYS': return ITEM_KEYS;",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    case 'ITEM_KEYS': ITEM_KEYS = v; break;",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    // S3: the served item-key map — ABSENT EMPTIES it (never «keep in force»: an older snapshot's keys must never label a newer MENU)\n    ITEM_KEYS: (body.item_keys && typeof body.item_keys === 'object' && !Array.isArray(body.item_keys)) ? body.item_keys : {},",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  if (window.__itemMenuReload === true) return false;                      // S3 C1: the customer asked for the fresh menu (at Paso 2)",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  const ik = liveItemKey(item); if (ik) { const k = window.availKey(ik); if (seen.indexOf(k) === -1) seen.push(k); }   // S3: the portal / KDS write the item_key",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    let httpStatus = 0;   // S3 P2-5",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "      .then(function(r){ httpStatus = r.status; return r.json(); })   // S3 P2-5: the HTTP status, kept for the item-refusal routing below",
   "old": "      .then(function(r){ return r.json(); })"
  },
  {
   "kind": "replace",
   "new": "        else { __serverQuote.key=null; __serverQuote.cents=null; __serverQuote.failedKey=key;   // ok:false → fail open to calcTotal(), and do not ask again for THIS cart\n          try { if(j && activeStageId()==='s2') itemRefused(httpStatus, j, true); } catch(_){} }   // Codex S3 r1 P2-5: an item refusal → the item gate",
   "old": "        else { __serverQuote.key=null; __serverQuote.cents=null; __serverQuote.failedKey=key; }   // ok:false → fail open to calcTotal(), and do not ask again for THIS cart"
  },
  {
   "kind": "replace",
   "new": "  GroupPicker.rewardDishes(MENU, VARIANT_ITEMS, p => String(p.id).indexOf('beer_')!==0 && !!CAT[p.cat]).forEach(p=>{ const c=CAT[p.cat]; out.push({ key:liveItemKey(p)||p.id, name:p.name, price_cents:Math.round(p.price*100), section:c, icon:p.reward_icon||'star' }); });   // PLAN 4 GATED: the published reward_icon (CAT keeps only the section)",
   "old": "  GroupPicker.rewardDishes(MENU, VARIANT_ITEMS, p => String(p.id).indexOf('beer_')!==0 && !!CAT[p.cat]).forEach(p=>{ const c=CAT[p.cat]; out.push({ key:p.id, name:p.name, price_cents:Math.round(p.price*100), section:c, icon:p.reward_icon||'star' }); });   // PLAN 4 GATED: the published reward_icon (CAT keeps only the section)"
  },
  {
   "kind": "insert",
   "new": "  if(itemQuoteMissing()){   // Codex S3 r1 P1-2 / r2: the repaired / reloaded cart is not quoted yet — nothing is sent\n    window.__paySubmitting = false; if(_payCta) _payCta.disabled = false;\n    try { requestServerQuote(true); } catch(_){}\n    const _e = document.getElementById('err3'); if(_e){ _e.style.display = 'block'; _e.textContent = 'No pudimos confirmar el precio en este momento. Volvé a intentar en unos segundos — tu pedido está intacto.'; }\n    return;\n  }",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "      id: p.id, name: itemNameFor(p, line.key), cat: p.cat, qty: line.qty,",
   "old": "      id: p.id, name: p.name, cat: p.cat, qty: line.qty,"
  },
  {
   "kind": "insert",
   "new": "    const ik = itemKeyFor(p, line.key);   // S3 D1: appended LAST; the id stays only when it IS the key (a minted dish sends item_key alone)\n    if (ik) { if (String(p.id) !== ik) delete out.id; out.item_key = ik; }",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  const id = genOrderId(); SERIAL.mint(resolvedCartLines(), (l) => liveItemKey(l.record)); window.__pendingOrder = { id, sig }; return id;   // §3: pin this order's serialization",
   "old": "  const id = genOrderId(); SERIAL.mint(resolvedCartLines()); window.__pendingOrder = { id, sig }; return id;   // §3: pin this order's serialization"
  },
  {
   "kind": "replace",
   "new": "      return `${qty[p.id]}x ${itemNameFor(p, String(p.id))} (L${p.price})${extrasStr}`;",
   "old": "      return `${qty[p.id]}x ${p.name} (L${p.price})${extrasStr}`;"
  },
  {
   "kind": "insert",
   "new": "/* ── S3 (D4c-grill/item-s1/S3-DESIGN.md D3 + the advisor's rulings 2026-11-10; OWNER-APPROVED MOCKUP-item-s3-refusals.html E1/F1/E2/F2):\n   the ITEM REFUSALS of a send. Both land back on Paso 2 with the form's own cart gate (.pickup-gate, #item-gate) in its slot under\n   the Delivery/Pickup toggle. menu_changed: ONE «Recargar la página» — the live menu refreshed IN PLACE through the form's own feed\n   (ruling C1 (A)); only lines whose dish is GONE are dropped, with the existing toast; every other conflict keeps today's block.\n   extra_not_allowed: the server's detail, one naming line per denied option, «Quitar extra y seguir» (removes ONLY those options\n   through the form's own option writer, then the summary re-quotes and the Plan 5 notice says what left and the new total) and\n   «Revisar pedido» (the existing cart review). Nothing is ever re-sent: the customer confirms again. ── */\nconst ITEM_EXTRA_WORD = 'acompañamiento';\nlet __itemReloading = false;\n// Codex S3 r1 P1-2 (advisor, MONEY): after a repair or a reload the order is NEVER sent until a successful server quote for THAT\n// cart is in (the redemption's own quote while one is pending, else the order quote), and «Total nuevo» is that quote — never the\n// client arithmetic. processPayment refuses before anything else and says so with the form's existing sentence.\n// Codex S3 r2: a pending reward's quote counts only when it MATCHES the cart on screen (redeemQuoteMatches — the account module's\n// own fail-closed answer); otherwise the reward is re-quoted for it, ONCE per cart, and there is no quote yet\nfunction itemQuotedCents(){\n  try {\n    if(window.__ACCOUNT && window.__ACCOUNT.getRedeemPayload && window.__ACCOUNT.getRedeemPayload()){\n      const items = redeemCartItems();\n      const fresh = typeof window.__ACCOUNT.redeemQuoteMatches === 'function' && window.__ACCOUNT.redeemQuoteMatches(items);\n      const rc = fresh && window.__ACCOUNT.getRedeemQuoteTotalCents ? window.__ACCOUNT.getRedeemQuoteTotalCents() : null;\n      if(rc == null){ const k = JSON.stringify(items); if(window.__itemRedeemAsked !== k){ window.__itemRedeemAsked = k; try { Promise.resolve(window.__ACCOUNT.requoteRedeem(items)).then(function(){ if(window.__ACCOUNT.redeemQuoteMatches(items)){ try { renderStage2Summary(); } catch(_){} } else window.__itemRedeemAsked = null; }, function(){ window.__itemRedeemAsked = null; }); } catch(_){ window.__itemRedeemAsked = null; } } }   // r3: a failed re-quote never latches — and never re-renders (that would re-ask in a loop); the next confirmation asks again\n      return rc == null ? null : rc;\n    }\n    return getServerQuoteTotalCents();\n  } catch(_){ return null; }\n}\n// Codex S3 r2 P1: the requirement holds from the repair / reload until an order COMPLETES (never cleared at a confirmation), and is\n// judged against the cart being sent — at processPayment AND at both send boundaries (the cash send and the card send)\nfunction itemQuoteMissing(){ return window.__itemQuoteRequired === true && itemQuotedCents() == null; }\n// Codex S3 r3: the PAYLOAD being sent is what must be quoted — never the cart on screen (they can drift between build and send)\nfunction itemPayloadQuoted(){\n  try {\n    const items = currentOrder && currentOrder.items;\n    if(window.__ACCOUNT && window.__ACCOUNT.getRedeemPayload && window.__ACCOUNT.getRedeemPayload()) return typeof window.__ACCOUNT.redeemQuoteMatches === 'function' && window.__ACCOUNT.redeemQuoteMatches(items);\n    return __serverQuote.cents != null && __serverQuote.key === JSON.stringify(_legacyCartForSig(items));\n  } catch(_){ return false; }\n}\nfunction itemSendRefused(){\n  if(window.__itemQuoteRequired !== true || (!itemQuoteMissing() && itemPayloadQuoted())) return false;\n  orderSubmitting = false;\n  try { requestServerQuote(true); } catch(_){}\n  showStage('s2', 50);\n  const _e = document.getElementById('err3'); if(_e){ _e.style.display = 'block'; _e.textContent = 'No pudimos confirmar el precio en este momento. Volvé a intentar en unos segundos — tu pedido está intacto.'; }\n  return true;\n}\n// fromQuote (Codex S3 r1 P2-5): a quote's item refusal opens the same gate — menu_changed is the quote's fail-soft 200\nfunction itemRefused(status, err, fromQuote){\n  if(!err || !(status === 409 || (fromQuote && status === 200 && err.error === 'menu_changed'))) return false;\n  if(err.error === 'menu_changed'){ orderSubmitting = false; showStage('s2', 50); showItemGate('menu', null); return true; }\n  if(err.error === 'extra_not_allowed'){\n    const den = itemDenied(err.lines); if(!den.length) return false;   // nothing in this cart matches: today's generic answer\n    orderSubmitting = false; showStage('s2', 50); showItemGate('extra', den); return true;\n  }\n  return false;\n}\n// the cart's (line, option) pairs a refusal names: a dish by its item key (or a legacy key), an option by its legacy key (id or name)\nfunction itemDenied(lines){\n  const out = [];\n  (Array.isArray(lines) ? lines : []).forEach(function(x){\n    if(!x || typeof x.item !== 'string' || typeof x.extra !== 'string') return;\n    resolvedCartLines().forEach(function(l){\n      const p = l.record; if(!p || !(liveItemKey(p) === x.item || p.name === x.item || String(p.id) === x.item)) return;\n      const ex = pizzaExtras[l.key] || {};\n      Object.keys(ex).forEach(function(eid){\n        if(!(ex[eid] > 0)) return;\n        const e = lineExtra(l, eid) || findMenuExtra(eid);\n        if(e && (e.name === x.extra || String(e.id) === x.extra)) out.push({ key: l.key, eid: eid, dish: p.name, extra: e.name });\n      });\n    });\n  });\n  return out;\n}\nfunction showItemGate(kind, den){\n  const g = document.getElementById('item-gate'); if(!g) return;\n  window.__itemDenied = den || null;\n  if(kind === 'menu'){\n    g.innerHTML = '<div class=\"pickup-gate-title\">El menú se actualizó, recargá la página</div><div class=\"pickup-gate-actions\"><button type=\"button\" class=\"pickup-gate-btn primary\" onclick=\"itemReloadMenu()\">Recargar la página</button></div>';\n  } else {\n    const named = []; den.forEach(function(d){ if(!named.some(function(n){ return n.dish === d.dish && n.extra === d.extra; })) named.push(d); });\n    g.innerHTML = '<div class=\"pickup-gate-title\">Uno de los extras ya no está disponible para ese producto. Revisá tu pedido.</div>'\n      + named.map(function(d){ return '<div class=\"gate-line\"><b>' + safeText(d.dish) + '</b> · ' + ITEM_EXTRA_WORD + ': ' + safeText(d.extra) + '</div>'; }).join('')\n      + '<div class=\"pickup-gate-actions\"><button type=\"button\" class=\"pickup-gate-btn primary\" onclick=\"itemRemoveDenied()\">Quitar extra y seguir</button><button type=\"button\" class=\"pickup-gate-btn ghost\" onclick=\"toggleCartReview()\">Revisar pedido</button></div>';\n  }\n  g.style.display = 'block';\n}\nfunction hideItemGate(){ const g = document.getElementById('item-gate'); if(g){ g.style.display = 'none'; g.innerHTML = ''; } window.__itemDenied = null; }\nasync function itemReloadMenu(){\n  if(__itemReloading) return;   // one fetch per tap: a second tap while the first is in flight does nothing\n  __itemReloading = true;\n  const btn = document.querySelector('#item-gate .pickup-gate-btn'); if(btn) btn.disabled = true;\n  let st = null;\n  window.__itemMenuReload = true;   // liveMenuBusy: the customer asked for the fresh menu — it applies now, at Paso 2\n  const A = window.__liveMenu && window.__liveMenu.applier, refused0 = A ? A.state().counts.refused : 0;\n  try { st = await window.__liveMenu.feed.refresh(); } catch(_){ st = null; }\n  // Codex S3 r1 P2-4: a newer menu DEFERRED while Paso 2 was open is applied now too (a 304 never reaches the applier); anything\n  // still pending, or refused, is a FAILED reload — never a false success\n  try { if(A) A.flush(); } catch(_){}\n  window.__itemMenuReload = false; __itemReloading = false;\n  if(!st || st.phase !== 'live' || st.lastError || (A && (A.hasPending() || A.state().counts.refused > refused0 || A.state().lastError))){ if(btn) btn.disabled = false; return; }   // the gate stays, its button live; r2: an unapplied menu (a failed apply, then a 304) is a failure\n  const gone = resolvedCartLines().filter(function(l){ return l.unresolved === 'removed'; }).map(function(l){ return l.key; });\n  gone.forEach(function(k){ const id = k; chg(id, -(CART.qtyOf(k) || 0)); });\n  hideItemGate(); window.__itemQuoteRequired = true;   // P1-2 / r2: from here every send needs the server quote of the cart it sends\n  try { renderStage2Summary(); } catch(_){}\n  try { requestServerQuote(true); } catch(_){}\n  if(gone.length){ try { window.__ACCOUNT.toast(gone.length === 1 ? '1 producto ya no está disponible' : gone.length + ' productos ya no están disponibles'); } catch(_){} }\n}\nfunction itemRemoveDenied(){\n  const den = window.__itemDenied || []; hideItemGate();\n  den.forEach(function(d){ const q = (pizzaExtras[d.key] || {})[d.eid] || 0; if(q > 0) chgDetailExtra(d.eid, d.key, -q); });   // the form's own option writer\n  const byDish = []; den.forEach(function(d){ let e = byDish.find(function(x){ return x.dish === d.dish; }); if(!e){ e = { dish: d.dish, ex: [] }; byDish.push(e); } if(e.ex.indexOf(d.extra) === -1) e.ex.push(d.extra); });\n  window.__itemQuoteRequired = true;   // P1-2 / r2: from here every send needs the server quote of the cart it sends\n  window.__itemNote = { text: byDish.map(function(e){ return 'Quitamos ' + (e.ex.length > 1 ? e.ex.slice(0, -1).join(', ') + ' y ' + e.ex[e.ex.length - 1] : e.ex[0]) + ' de ' + e.dish + '.'; }).join(' '), sig: cartSig() };\n  try { renderStage2Summary(); } catch(_){}\n}\n// the D2 note — only while the repaired cart is the one on screen; its total is the one the summary shows\nfunction itemNoteText(){\n  const n = window.__itemNote; if(!n) return '';\n  if(n.sig !== cartSig()){ window.__itemNote = null; return ''; }\n  const c = itemQuotedCents(); if(c == null) return '';   // P1-2: shown only with the SERVER quote for this cart\n  return n.text + ' Total nuevo: L ' + (c / 100).toFixed(0) + '.';\n}\n",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    if(itemSendRefused()) return;   // Codex S3 r2 P1: no server quote for the cart being sent → nothing is sent",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "    if(itemRefused(res.status, cfg)) return;   // S3: menu_changed / extra_not_allowed → Paso 2's item gate (no checkout issued)",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "      if(itemSendRefused()) return;   // Codex S3 r2 P1: no server quote for the cart being sent → nothing is sent",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "        if(itemRefused(res.status, err)) return;   // S3: menu_changed / extra_not_allowed → Paso 2's item gate (nothing created)",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  window.__itemQuoteRequired = false;   // S3 r2: the order is over — the next one starts without the requirement",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  window.__itemQuoteRequired = false;   // S3 r2: the order succeeded (the success screen)",
   "old": ""
  }
 ],
 "form-serial-order": [
  {
   "kind": "insert",
   "new": "//   • S3 (D4c-grill/item-s1/S3-DESIGN.md, advisor Q3 ruling): beside its order, the pin keeps each pinned line's `item_key` AS FIRST\n//     SENT — the map's value at the mint, or exactly what the stashed item carried on a resume (present, or absent → null) — so a\n//     retried or resumed order resends its first body byte-identically whatever the live map says now. The line's NAME is kept the\n//     same way (Codex S3 r1 P2-3): a dish renamed while the payment is pending would otherwise change `items` and `items_text`, and\n//     with them the order's bound fingerprint.",
   "old": ""
  },
  {
   "kind": "insert",
   "new": "  let iks = null;   // S3: line key → { k: the item_key that line was first sent with (null = none), n: its name }; null = nothing recorded",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  function mint(lines, itemKeyOf) {\n    const list = Array.isArray(lines) ? lines : [];\n    pin = list.map((l) => String(l.key));\n    iks = typeof itemKeyOf === \"function\" ? new Map(list.map((l) => [String(l.key), { k: itemKeyOf(l) || null, n: l.record && typeof l.record.name === \"string\" ? l.record.name : null }])) : null;\n  }",
   "old": "  function mint(lines) { pin = (Array.isArray(lines) ? lines : []).map((l) => String(l.key)); }"
  },
  {
   "kind": "insert",
   "new": "    const sent = new Map();",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "      if (hit) {\n        used.add(String(hit.key)); keys.push(String(hit.key));\n        sent.set(String(hit.key), { k: Object.prototype.hasOwnProperty.call(it, \"item_key\") && typeof it.item_key === \"string\" && it.item_key ? it.item_key : null, n: typeof it.name === \"string\" ? it.name : null });\n      }",
   "old": "      if (hit) { used.add(String(hit.key)); keys.push(String(hit.key)); }"
  },
  {
   "kind": "insert",
   "new": "    iks = sent;",
   "old": ""
  },
  {
   "kind": "replace",
   "new": "  function clear() { pin = null; iks = null; }",
   "old": "  function clear() { pin = null; }"
  },
  {
   "kind": "replace",
   "new": "  // S3: the item_key a pinned line was first sent with — a string, or null (sent without one); undefined when the pin does not\n  // hold that line or is not live (the caller then reads the live map)\n  function itemKey(key, live = true) { return pin && live && iks && iks.has(String(key)) ? iks.get(String(key)).k : undefined; }\n  // the NAME a pinned line was first sent with; undefined when the pin does not hold that line, is not live, or recorded none\n  function sentName(key, live = true) { const e = pin && live && iks && iks.get(String(key)); return e && typeof e.n === \"string\" ? e.n : undefined; }\n  return { order, mint, resume, clear, current, itemKey, sentName };",
   "old": "  return { order, mint, resume, clear, current };"
  }
 ],
 "account": [
  {
   "kind": "replace",
   "new": "        // S3 (Codex r1 P2-7): a stored recipe's key IS the resolved pricing key (reorder-normalize.js: itemPricingKey → the stamp), i.e. the\n        // item key — matched FIRST through the served map (a renamed / minted dish), then today's legacy match\n        const ikOf = (p) => (typeof liveItemKey === 'function' ? liveItemKey(p) : null);\n        const item = MENU.find((p) => ikOf(p) === rl.key) || (byId ? MENU.find((p) => p.id === rl.key) : MENU.find((p) => p.name === rl.key));   // la_musa by id / x_pizza by name (recipe key)",
   "old": "        const item = byId ? MENU.find((p) => p.id === rl.key) : MENU.find((p) => p.name === rl.key);   // la_musa by id / x_pizza by name (recipe key)"
  },
  {
   "kind": "replace",
   "new": "      const out = { ...rl, key: (typeof liveItemKey === 'function' && liveItemKey(dish)) || (byId ? dish.id : dish.name) };   // S3: the item key when served",
   "old": "      const out = { ...rl, key: byId ? dish.id : dish.name };"
  },
  {
   "kind": "insert",
   "new": "  window.__ACCOUNT.toast = toast;   // S3 C2: the form's item-refusal flow reuses this pill (textContent; no new copy)",
   "old": ""
  }
 ]
};

function unapplyItemS3Forms(dir, text) {
  const hunks = HUNKS[dir];
  if (!hunks) throw new Error(`item-s3-forms-inverse: no S3 hunks for ${dir}`);
  let out = String(text);
  for (const h of hunks) {
    const find = h.kind === 'insert' ? '\n' + h.new : h.new;
    const at = out.indexOf(find);
    if (at === -1) throw new Error(`item-s3-forms-inverse: an S3 hunk is missing from ${dir} (${h.new.slice(0, 60)})`);
    if (out.indexOf(find, at + 1) !== -1) throw new Error(`item-s3-forms-inverse: an S3 hunk occurs more than once in ${dir} (${h.new.slice(0, 60)})`);
    out = out.slice(0, at) + (h.kind === 'insert' ? '' : h.old) + out.slice(at + find.length);
  }
  return out;
}

module.exports = { unapplyItemS3Forms, HUNKS };
