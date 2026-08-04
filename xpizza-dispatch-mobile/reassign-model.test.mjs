import { test } from 'node:test';
import assert from 'node:assert/strict';
import { driverLoad, driverPickList } from './reassign-model.js';

const isStale = (p) => (Date.now() - (p||0)) > 90000; // mirror XPD.isStalePing threshold for the test

test('driverLoad counts active tasks for a driver', () => {
  const tasks = {
    o1_delivery:{ assigned_driver_id:'A', status:'accepted' },
    o2_delivery:{ assigned_driver_id:'A', status:'in_progress' },
    o3_delivery:{ assigned_driver_id:'A', status:'completed' }, // not active
    o4_delivery:{ assigned_driver_id:'B', status:'accepted' },
  };
  assert.equal(driverLoad('A', tasks), 2);
  assert.equal(driverLoad('B', tasks), 1);
  assert.equal(driverLoad('C', tasks), 0);
});

test('driverPickList marks current driver + sorts nearest first', () => {
  const now = Date.now();
  const drivers = {
    A:{ name:'Kevin', status:'available', lat:15.51, lng:-88.04, last_ping: now-200000 }, // stale
    B:{ name:'Génesis', status:'available', lat:15.507, lng:-88.0399, last_ping: now },   // fresh, closer
  };
  const tasks = { o9_delivery:{ assigned_driver_id:'A', status:'accepted', destination_lat:15.5, destination_lng:-88.03 } };
  const order = { order_type:'delivery' };
  const hub = { lat:15.5075, lng:-88.0398 };
  const list = driverPickList({ order, orderId:'o9', drivers, tasks, hub, now, isStale });
  assert.equal(list[0].id, 'B');           // Génesis nearest to hub
  assert.equal(list.find(d=>d.id==='A').isCurrent, true);
  assert.equal(list.find(d=>d.id==='A').live, false); // stale
  assert.equal(list.find(d=>d.id==='B').live, true);
});
