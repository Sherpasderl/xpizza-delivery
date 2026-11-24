import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// CTA audit #4 — tapping a driver row focuses the map, but a driver with NO GPS fix fell through
// __focusDriverOnMap's `if (has coords)` with no else: the tab switched to the map, nothing panned, no
// bubble — the tap read as broken with no feedback. Fix: an else branch that shows honest feedback on the
// existing #map-msg surface (showMapMsg), and clears it when a located driver is focused.
// Copy-independent: asserts a NON-EMPTY message is shown (the owner-approved wording can change freely).

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');

function arrowAssignment(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('marker not found: ' + marker);
  let d = 0, started = false;
  for (let j = src.indexOf('{', at); j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(at, j + 1); }
  }
  throw new Error('unbalanced braces for ' + marker);
}
const focusSrc = arrowAssignment(html, 'window.__focusDriverOnMap = async (uid) =>');
assert.ok(focusSrc.includes('STORE.drivers[uid]'), 'extracted the real __focusDriverOnMap');

function build(drivers) {
  const pans = [], msgs = [], infos = [];
  const win = { __onMapaShown: async () => {} };
  const map = { panTo: (p) => pans.push(p), setZoom() {} };
  const STORE = { drivers };
  const make = new Function('window', 'mapReady', 'clearFocus', 'STORE', 'map', 'openDriverInfo', 'showMapMsg',
    focusSrc + '\n; return window.__focusDriverOnMap;');
  const focus = make(win, true, () => {}, STORE, map, (uid) => infos.push(uid), (t) => msgs.push(t));
  return { focus, pans, msgs, infos };
}

test('#4 a driver with NO GPS fix shows honest feedback (not a silent no-op)', async () => {
  const { focus, pans, msgs } = build({ d1: { name: 'Marcos', lat: null, lng: null } });
  await focus('d1');
  assert.equal(pans.length, 0, 'no pan for a driver without coordinates');
  assert.equal(msgs.length, 1, 'a map message is shown');
  assert.ok(typeof msgs[0] === 'string' && msgs[0].trim().length > 0, 'the message is non-empty (honest feedback)');
});

test('#4 an unknown/absent driver also gets feedback (no silent tap)', async () => {
  const { focus, pans, msgs } = build({});
  await focus('ghost');
  assert.equal(pans.length, 0);
  assert.ok(msgs.length === 1 && msgs[0].trim().length > 0, 'feedback shown even if the driver record is gone');
});

test('#4 a located driver still pans + opens the bubble, and clears any prior message', async () => {
  const { focus, pans, msgs, infos } = build({ d2: { name: 'Lucía', lat: 15.5, lng: -88.0 } });
  await focus('d2');
  assert.deepEqual(pans[0], { lat: 15.5, lng: -88.0 }, 'pans to the driver');
  assert.deepEqual(infos, ['d2'], 'opens the driver info bubble');
  assert.ok(msgs.includes(''), 'clears any prior "no location" message on success');
});
