// Portal 1D · D4-b — the forms' REORDER READER (account.js reorderFromEntry + applyReorderToCart [+ the D4-b
// canonicalRecipeToLegacy]), lifted out of an account.js TEXT — today's or the base commit's — and run in a sandbox
// with the cart globals it touches (MENU, EXTRAS, qty, pizzaExtras, toast, soldOutById, reorderCartPrompt…).
// runReorder() returns the resulting cart + every toast, so a scenario's outcome is one comparable value.
import vm from 'node:vm';

export function liftReader(accountJs) {
  const start = accountJs.indexOf('  function reorderFromEntry(entry) {');
  const end = accountJs.indexOf('  // Smart-cart prompt');
  if (start < 0 || end < start) throw new Error('account.js: reorder reader block not found');
  return accountJs.slice(start, end);
}

// menu: { dishes:[{id,name,dish_id?}], extras:[{id,name,extra_id?}] }; cart: {qty, pizzaExtras} pre-state;
// soldOut: ids; prompt: 'add' | 'replace' (the smart-cart choice when the cart is non-empty).
export function runReorder(accountJs, { rid, menu, entry, cart = {}, soldOut = [], prompt = 'add' }) {
  const toasts = [], warns = [];
  const ctx = {
    CONFIG: { restaurant_id: rid },
    MENU: menu.dishes, EXTRAS: menu.extras,
    qty: JSON.parse(JSON.stringify(cart.qty || {})), pizzaExtras: JSON.parse(JSON.stringify(cart.pizzaExtras || {})),
    toast: (m) => toasts.push(m), closeSheet: () => {},
    soldOutById: (id) => soldOut.includes(id),
    reorderCartPrompt: (onAdd, onReplace) => (prompt === 'replace' ? onReplace() : onAdd()),
    renderMenu: () => {}, updateCart: () => {}, updateTotal: () => {},
    document: { getElementById: () => null, querySelector: () => null },
    setTimeout: () => 0,
    console: { warn: (...a) => warns.push(a.join(' ')), log: () => {} },
  };
  vm.createContext(ctx);
  vm.runInContext(`${liftReader(accountJs)}\nthis.__run = (e) => reorderFromEntry(e);`, ctx);
  ctx.__run(entry);
  // JSON-normalised: objects built inside the sandbox carry ITS Object prototype, which deepStrictEqual would compare.
  return JSON.parse(JSON.stringify({ qty: ctx.qty, pizzaExtras: ctx.pizzaExtras, toasts, warns }));
}

// The scenario set — LEGACY recipes (no tag), for both brands: plain, options (counts capped to qty), merge offsets
// onto an existing cart (add) and replace, drops (off-menu, sold out, bad qty), all-dropped, and unknown fields.
export function legacyScenarios() {
  const xMenu = { dishes: [{ id: 2, name: 'Carnivora' }, { id: 3, name: 'Crispy Bacon' }, { id: 9, name: 'Nutella' }],
    extras: [{ id: 'e1', name: 'Salsa Roja' }, { id: 'e2', name: 'Salsa Blanca' }] };
  const lMenu = { dishes: [{ id: 'dimsum_01', name: 'Wonton' }, { id: 'dimsum_02', name: 'Siu Mai' }],
    extras: [{ id: 'rice_white', name: 'Arroz' }, { id: 'rice_chinese', name: 'Arroz chino' }] };
  return [
    ['x_pizza.plain', { rid: 'x_pizza', menu: xMenu, entry: { items: [{ key: 'Carnivora', qty: 2 }, { key: 'Crispy Bacon', qty: 1 }] } }],
    ['x_pizza.options_capped', { rid: 'x_pizza', menu: xMenu, entry: { items: [{ key: 'Carnivora', qty: 2, options: [{ name: 'Salsa Roja', count: 5 }, { name: 'Salsa Blanca' }] }] } }],
    ['x_pizza.merge_add_offsets', { rid: 'x_pizza', menu: xMenu, cart: { qty: { 2: 1 }, pizzaExtras: { 2: { 0: { e2: 1 } } } }, prompt: 'add',
      entry: { items: [{ key: 'Carnivora', qty: 2, options: [{ name: 'Salsa Roja', count: 2 }] }] } }],
    ['x_pizza.merge_replace', { rid: 'x_pizza', menu: xMenu, cart: { qty: { 2: 1, 3: 4 }, pizzaExtras: { 2: { 0: { e2: 1 } } } }, prompt: 'replace',
      entry: { items: [{ key: 'Carnivora', qty: 1, options: [{ name: 'Salsa Roja', count: 1 }] }] } }],
    ['x_pizza.drops', { rid: 'x_pizza', menu: xMenu, soldOut: [9], entry: { items: [{ key: 'Gone Dish', qty: 1 }, { key: 'Nutella', qty: 1 }, { key: 'Carnivora', qty: 0 }, { key: 'Crispy Bacon', qty: 1, options: [{ name: 'No Such Extra' }] }, null, { qty: 1 }] } }],
    ['x_pizza.all_dropped', { rid: 'x_pizza', menu: xMenu, entry: { items: [{ key: 'Gone', qty: 1 }] } }],
    ['x_pizza.unknown_fields', { rid: 'x_pizza', menu: xMenu, entry: { future: 1, items: [{ key: 'Carnivora', qty: 1, note: 'x', options: [{ name: 'Salsa Roja', count: 1, z: 2 }] }] } }],
    ['la_musa.plain', { rid: 'la_musa', menu: lMenu, entry: { items: [{ key: 'dimsum_01', qty: 2, options: [{ id: 'rice_white', qty: 2 }, { id: 'rice_chinese' }] }] } }],
    ['la_musa.merge_add', { rid: 'la_musa', menu: lMenu, cart: { qty: { dimsum_01: 1 }, pizzaExtras: { dimsum_01: { rice_white: 1 } } }, prompt: 'add',
      entry: { items: [{ key: 'dimsum_01', qty: 1, options: [{ id: 'rice_white', qty: 3 }] }] } }],
    ['la_musa.drops', { rid: 'la_musa', menu: lMenu, soldOut: ['dimsum_02'], entry: { items: [{ key: 'dimsum_02', qty: 1 }, { key: 'nope', qty: 1 }, { key: 'dimsum_01', qty: 1.5 }] } }],
    ['la_musa.all_dropped', { rid: 'la_musa', menu: lMenu, entry: { items: [{ key: 'nope', qty: 1 }] } }],
  ];
}
