'use strict';
// Portal 1D · D4-b — the FIXED INPUTS for the frozen legacy-hash goldens. Shared by the capture script
// (run once, on unmodified code at main 717f97e) and the verifying test, so both feed the REAL writers
// exactly the same inputs. Built from the in-repo catalog snapshot, both Restaurants.
const { catalogSnapshot } = require('../catalog/generate-form-bundle');

const RIDS = ['x_pizza', 'la_musa'];

// Guarded, restaurant-TAGGED tables in the shape the pricing resolver returns.
function tablesFor(rid) {
  const s = catalogSnapshot(rid);
  return { restaurantId: rid, menu: Object.fromEntries(s.items.map((i) => [i.key, i.price])), extras: Object.fromEntries(s.extras.map((e) => [e.key, e.price])) };
}

// Carts as each FORM emits them: x_pizza by NAME with per-instance extras; la_musa by id with qty-aware extras.
function cartsFor(rid) {
  const s = catalogSnapshot(rid);
  const [a, b] = s.items, [e1, e2] = s.extras;
  if (rid === 'x_pizza') {
    const line = (it, qty, ex) => ({ name: it.display.name, qty, price: it.price, extras: ex });
    return {
      plain: [line(a, 2, [{ instance: 0, name: e1.display.name, price: e1.price }, { instance: 1, name: e2.display.name, price: e2.price }]), line(b, 1, [])],
      // the B.1 collision fixture: two lines {A,1,[E]} vs one line {A,2,[E]} — legacy fps must stay DIFFERENT
      collisionTwo: [line(a, 1, [{ instance: 0, name: e1.display.name, price: e1.price }]), line(a, 1, [{ instance: 0, name: e1.display.name, price: e1.price }])],
      collisionOne: [line(a, 2, [{ instance: 0, name: e1.display.name, price: e1.price }])],
    };
  }
  const line = (it, qty, ex) => ({ id: it.key, name: it.display.name, cat: it.display.cat, qty, price: it.price, extras: ex });
  return {
    plain: [line(a, 2, [{ id: e1.key, name: e1.display.name, price: e1.price, qty: 1 }]), line(b, 1, [])],
    collisionTwo: [line(a, 1, [{ id: e1.key, name: e1.display.name, price: e1.price, qty: 1 }]), line(a, 1, [{ id: e1.key, name: e1.display.name, price: e1.price, qty: 1 }])],
    collisionOne: [line(a, 2, [{ id: e1.key, name: e1.display.name, price: e1.price, qty: 1 }])],
  };
}

// A redeem request each brand's real reward computation accepts.
function redeemFor(rid) {
  if (rid === 'x_pizza') return { type: 'free_pizza_choice', item_id: 'Margherita', name: 'Margherita' };
  return { type: 'points_ala_carte', items: [{ id: 'rice_white', qty: 2, name: 'Arroz blanco' }, { id: 'dimsum_02', qty: 1, name: 'Dim sum 2' }] };
}

const ORDER_ID = 'ord_d4b_golden_0001';
const UID = 'uid_d4b_golden';
const SCHEDULED_FOR = 1767225600000;   // a fixed slot for the scheduled-extra variant
const NOW = 1767200000000;

module.exports = { RIDS, tablesFor, cartsFor, redeemFor, ORDER_ID, UID, SCHEDULED_FOR, NOW };
