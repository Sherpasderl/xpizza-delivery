import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECTIONS, sectionForOrder, assignedDriverId, isUnassignedDelivery,
  canReassign, typeChip, matchesChip, chipCounts, orderCompare
} from './board-model.js';

const del = (status, extra={}) => ({ status, order_type:'delivery', created_at:1000, restaurant_id:'x_pizza', ...extra });
const pick = (status, extra={}) => ({ status, order_type:'pickup', created_at:1000, restaurant_id:'la_musa', ...extra });

test('sectionForOrder maps the lifecycle', () => {
  assert.equal(sectionForOrder(del('new')), 'nuevos');
  assert.equal(sectionForOrder(del('preparing')), 'preparacion');
  assert.equal(sectionForOrder(del('ready')), 'listos');
  assert.equal(sectionForOrder(del('out_for_delivery')), 'camino');
  assert.equal(sectionForOrder(del('delivered')), 'completados');
  assert.equal(sectionForOrder(del('completed')), 'completados');
});

test('pickup never lands in camino', () => {
  assert.equal(sectionForOrder(pick('ready')), 'listos');
  // defensive: even a malformed pickup at out_for_delivery stays out of camino
  assert.equal(sectionForOrder(pick('out_for_delivery')), 'listos');
  assert.equal(sectionForOrder(pick('completed')), 'completados');
});

test('assignedDriverId reads the delivery task', () => {
  const tasks = { 'o1_delivery': { assigned_driver_id: 'drvA', status:'accepted' } };
  assert.equal(assignedDriverId('o1', tasks), 'drvA');
  assert.equal(assignedDriverId('o2', tasks), null);
});

test('isUnassignedDelivery = live delivery with no driver', () => {
  const tasks = { 'o1_delivery': { assigned_driver_id: null, status:'pending' } };
  assert.equal(isUnassignedDelivery(del('ready'), 'o1', tasks), true);
  assert.equal(isUnassignedDelivery(del('ready'), 'o1', { 'o1_delivery':{assigned_driver_id:'drvA'} }), false);
  assert.equal(isUnassignedDelivery(pick('ready'), 'o1', tasks), false); // pickup is never "sin asignar"
  assert.equal(isUnassignedDelivery(del('new'), 'o1', tasks), false);    // not yet live-for-driver
});

test('canReassign: delivery + live only', () => {
  assert.equal(canReassign(del('ready')), true);
  assert.equal(canReassign(del('out_for_delivery')), true);
  assert.equal(canReassign(pick('ready')), false);
  assert.equal(canReassign(del('completed')), false);
});

test('chip partition holds: delivery + pickup + programados = todos', () => {
  const orders = { o1:del('new'), o2:del('ready'), o3:pick('preparing'), o4:pick('ready') };
  const tasks = {};
  const c = chipCounts(orders, tasks, 2); // 2 scheduled
  assert.equal(c.delivery + c.pickup + c.programados, c.todos);
  assert.equal(c.delivery, 2);
  assert.equal(c.pickup, 2);
  assert.equal(c.programados, 2);
  assert.equal(c.todos, 6);
});

test('unassigned count is a cross-cutting subset (not part of the partition)', () => {
  const orders = { o1:del('ready'), o2:del('ready') };
  const tasks = { 'o1_delivery':{assigned_driver_id:null,status:'pending'} }; // o1 unassigned, o2 has no task row → also unassigned
  const c = chipCounts(orders, tasks, 0);
  assert.equal(c.unassigned, 2);
  assert.ok(c.unassigned <= c.delivery); // subset of delivery
});

test('orderCompare sorts delivery before pickup', () => {
  assert.ok(orderCompare(del('ready'), pick('ready')) < 0);
  assert.ok(orderCompare(pick('ready'), del('ready')) > 0);
});
