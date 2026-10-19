// PLAN-S5 §4 / §6 / §9 BC2 — the arrival window and the status copy, as pure functions. Run: node s5-live-status.test.mjs
//   1  the ladder: placement / ready / picked-up / terminal / overdue, delivery and pickup;
//   2  rounding on NON-5-minute timestamps (the plan's exact cells), the width clamp, across the hour, across noon;
//   3  every fallback combination: prep (measured / configured / neutral, incl. stale and n < 8) × drive (Directions / 12);
//   4  after pickup: delivery_eta_min present / absent × the form's drive (ready-time / placement / 12), the min-1 floor,
//      stacked → the tracker's copy with no number;
//   5  the anchor and the daypart: the window is anchored at created_at; the bucket is frozen at the anchor across a band
//      boundary (never `now`);
//   6  BC2 copy parity: under EQUAL presentation inputs the form's status line is byte-identical to what the REAL tracker
//      rendered (tracker-status.golden.json, captured before the extraction); the form's deliberately different ETA (its own
//      drive estimate vs the tracker's 12) is asserted in its own cells;
//   7  the shared modules: form-live-status.js and status-view.js are byte-identical in every form folder (+ the tracker);
//      no brand literal; the owner-approved copy is exact.
process.env.TZ = 'America/Tegucigalpa';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const FL = require('./xpizza-orders/form-live-status.js');
const SV = require('./xpizza-track/status-view.js');
const { windowFor, prepFor, arrivalFor, stageOf, statusLineOf, fmtRange, bucketAt, r5, LIVE_COPY, LIVE_STATUS } = FL;

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const MIN = 60000, HOUR = 60 * MIN;
const hn = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo, d, h + 6, mi, s);   // a Tegucigalpa wall-clock time → ms
const TUE = (h, mi, s) => hn(2026, 9, 13, h, mi, s);                       // Tue 2026-10-13
const v = (rec, drive = 12, now = TUE(20, 30)) => SV.presentStatus({ ...rec, fallback_drive_min: drive, now });
const arr = (o) => arrivalFor({ stage: stageOf(o.rec, o.pickup), v: v(o.rec, o.driveMin, o.now), overdue: false, ...o });
const CONF = (p) => prepFor({ prep_eta_min: p }, 0, 0);

// ── 1. the ladder ──
{
  const A = TUE(19, 0);
  const prep = { median: 20, p80: 30 };
  assert.strictEqual(arr({ rec: { status: 'new' }, pickup: false, prep, driveMin: 12, anchorMs: A }).text, 'Llega 7:30 – 7:40 p. m.');
  assert.strictEqual(arr({ rec: { status: 'preparing' }, pickup: false, prep, driveMin: 12, anchorMs: A }).text, 'Llega 7:30 – 7:40 p. m.', 'preparing keeps the placement window');
  assert.strictEqual(arr({ rec: { status: 'ready' }, pickup: false, prep, driveMin: 12, anchorMs: A }).text, 'Llega 7:30 – 7:40 p. m.', 'ready WITHOUT ready_at (an older writer) keeps the placement window');
  assert.strictEqual(arr({ rec: { status: 'ready', ready_at: TUE(19, 20) }, pickup: false, prep, driveMin: 12, anchorMs: A }).text, 'Llega 7:30 – 7:40 p. m.', 'ready: [ready_at + drive, +10]');
  assert.strictEqual(arr({ rec: { status: 'ready', ready_at: TUE(19, 28) }, pickup: false, prep, driveMin: 12, anchorMs: A }).text, 'Llega 7:40 – 7:50 p. m.');
  assert.strictEqual(arr({ rec: { status: 'new' }, pickup: true, prep, driveMin: 99, anchorMs: A }).text, 'Listo para recoger 7:20 – 7:30 p. m.', 'pickup: prep only (no drive)');
  assert.strictEqual(arr({ rec: { status: 'ready' }, pickup: true, prep, driveMin: 12, anchorMs: A }).text, 'Listo para recoger', 'pickup ready: no window');
  for (const [s, p, t] of [['cancelled', false, 'Tu pedido fue cancelado'], ['cancelled', true, 'Tu pedido fue cancelado'], ['delivered', false, 'Entregado'], ['completed', false, 'Entregado'], ['delivered', true, 'Recogido'], ['completed', true, 'Recogido']]) {
    const a = arr({ rec: { status: s }, pickup: p, prep, driveMin: 12, anchorMs: A }); assert.strictEqual(a.text, t); assert.strictEqual(a.deadline, null);
  }
  const od = arrivalFor({ rec: { status: 'preparing' }, pickup: false, stage: 'placement', prep, driveMin: 12, anchorMs: A, overdue: true, v: v({ status: 'preparing' }) });
  assert.deepStrictEqual(od, { text: LIVE_COPY.OVERDUE, deadline: null }, 'overdue → honest status copy, no time');
  assert.strictEqual(arr({ rec: { status: 'new' }, pickup: false, prep, driveMin: 12, anchorMs: A }).deadline, TUE(19, 40), 'the deadline is the DISPLAYED window end');
  assert.strictEqual(stageOf({ status: 'out_for_delivery' }, true), 'terminal', 'a pickup never has an out_for_delivery stage');
  assert.strictEqual(stageOf({ status: 'weird' }, false), 'placement', 'an unknown status = just received (as the tracker)');
  ok('the ladder: placement (new / preparing / ready without ready_at), ready [ready_at + drive, +10], pickup (prep only; ready → "Listo para recoger"), terminal copy, overdue copy; the deadline is the displayed end');
}

// ── 2. rounding on non-5-minute timestamps (the plan's exact cells) ──
{
  const w = windowFor({ stage: 'placement', anchorMs: TUE(20, 2), prep: { median: 18, p80: 25 }, driveMin: 9 });
  assert.strictEqual(fmtRange(w.low, w.high), '8:30 – 8:40 p. m.', 'A 20:02 + 18 + 9 = 20:29 → 20:30 – 20:40');
  const R = (s) => windowFor({ stage: 'ready', readyAt: TUE(20, 3, s), driveMin: 9, prep: null });
  assert.strictEqual(fmtRange(R(0).low, R(0).high), '8:10 – 8:20 p. m.', 'ready_at + drive = 20:12:00 → 20:10 – 20:20');
  assert.strictEqual(fmtRange(R(30).low, R(30).high), '8:15 – 8:25 p. m.', '20:12:30 → a tie rounds UP → 20:15 – 20:25');
  for (const [d, width] of [[13, 15], [2, 10], [31, 20], [7, 10], [12, 10], [12.5, 15], [17, 15], [17.5, 20], [0, 10]]) {
    const x = windowFor({ stage: 'placement', anchorMs: TUE(19, 0), prep: { median: 20, p80: 20 + d }, driveMin: 10 });
    assert.strictEqual((x.high - x.low) / MIN, width, `p80 − median = ${d} → width ${width}`);
  }
  const h = windowFor({ stage: 'placement', anchorMs: TUE(20, 58), prep: { median: 5, p80: 5 }, driveMin: 5 });
  assert.strictEqual(fmtRange(h.low, h.high), '9:10 – 9:20 p. m.', 'across the hour: 20:58 + 10 → 21:10 – 21:20');
  const noon = windowFor({ stage: 'placement', anchorMs: TUE(11, 20), prep: { median: 20, p80: 40 }, driveMin: 10 });
  assert.strictEqual(fmtRange(noon.low, noon.high), '11:50 a. m. – 12:10 p. m.', 'across noon: each end keeps its period');
  assert.strictEqual(fmtRange(TUE(23, 50), TUE(23, 50) + 20 * MIN), '11:50 p. m. – 12:10 a. m.', 'across midnight');
  assert.strictEqual(fmtRange(TUE(0, 5), TUE(0, 15)), '12:05 – 12:15 a. m.', '00:05 is 12:05 a. m.');
  for (let s = 0; s < 3600; s += 7) { const x = r5(TUE(19, 0) + s * 1000); assert.strictEqual(x % (5 * MIN), 0); assert.ok(Math.abs(x - (TUE(19, 0) + s * 1000)) <= 150000); }
  ok('rounding: 20:02 + 18 + 9 → 8:30 – 8:40 p. m.; ready 20:12:00 → 8:10 – 8:20, 20:12:30 (a tie) → 8:15 – 8:25; widths 13→15, 2→10, 31→20 (and every half-tie); across the hour, noon and midnight; r5 always lands on a 5-minute mark within 2.5 min');
}

// ── 3. every fallback combination ──
{
  const NOW = TUE(19, 0), A = TUE(19, 0), fresh = NOW - 71 * HOUR, stale = NOW - 73 * HOUR;
  const bucket = bucketAt(A); assert.strictEqual(bucket, 'weekday_dinner');
  const stats = (o) => ({ prep_stats: { [bucket]: { median_min: 16, p80_min: 31, n: 9 }, updated_at: fresh, ...o } });
  const tiers = {
    measured: [stats({}), 'measured', 16, 31],
    'n < 8 → configured': [{ ...stats({ [bucket]: { median_min: 16, p80_min: 31, n: 7 } }), prep_eta_min: 25 }, 'configured', 25, 35],
    'stale → configured': [{ ...stats({ updated_at: stale }), prep_eta_min: 25 }, 'configured', 25, 35],
    'other bucket only → configured': [{ prep_stats: { weekend_late: { median_min: 9, p80_min: 9, n: 50 }, updated_at: fresh }, prep_eta_min: 25 }, 'configured', 25, 35],
    'nothing → neutral': [{}, 'neutral', 30, 40],
    'no leaf at all → neutral': [null, 'neutral', 30, 40],
    'stale + no prep_eta_min → neutral': [stats({ updated_at: stale }), 'neutral', 30, 40],
  };
  const rows = [];
  for (const [name, [pub, tier, med, p80]] of Object.entries(tiers)) {
    const p = prepFor(pub, A, NOW);
    assert.deepStrictEqual(p, { median: med, p80, tier }, name);
    for (const drive of [17, LIVE_STATUS.DRIVE_FALLBACK_MIN]) {
      const a = arr({ rec: { status: 'new' }, pickup: false, prep: p, driveMin: drive, anchorMs: A, now: NOW });
      const w = windowFor({ stage: 'placement', anchorMs: A, prep: p, driveMin: drive });
      assert.strictEqual(a.text, `Llega ${fmtRange(w.low, w.high)}`);
      assert.strictEqual(w.low, r5(A + (med + drive) * MIN), `${name} × drive ${drive}: the low end = A + median + drive`);
      rows.push(`${tier}/${drive}`);
    }
    const pk = arr({ rec: { status: 'new' }, pickup: true, prep: p, driveMin: 17, anchorMs: A, now: NOW });
    assert.ok(pk.text.startsWith('Listo para recoger '), `${name}: pickup`);
  }
  assert.deepStrictEqual(LIVE_STATUS.NEUTRAL_PREP, { median: 30, p80: 40 }); assert.strictEqual(LIVE_STATUS.DRIVE_FALLBACK_MIN, 12);
  assert.strictEqual(prepFor({ prep_eta_min: 0 }, A, NOW).tier, 'neutral', 'a zero configured prep is not usable');
  ok(`every fallback combination: prep measured / configured (n < 8, stale > 72 h, another bucket) / neutral 30–40 × drive (a Directions result / 12) — ${rows.length} delivery cells + pickup; prep and drive degrade independently`);
}

// ── 4. after pickup ──
{
  const NOW = TUE(20, 30);
  const ofd = (o) => ({ status: 'out_for_delivery', driver_name: 'Carlos', ...o });
  const eta = (rec, drive) => arr({ rec, pickup: false, prep: CONF(20), driveMin: drive, anchorMs: 0, now: NOW }).text;
  assert.strictEqual(eta(ofd({ delivery_eta_min: 7, picked_up_at: NOW - 3 * MIN }), 20), 'Llega en ~7 min', 'delivery_eta_min first');
  for (const [drive, ago, want] of [[20, 3, 17], [9, 3, 6], [12, 3, 9], [12, 15, 1], [20, 30, 1]]) assert.strictEqual(eta(ofd({ picked_up_at: NOW - ago * MIN }), drive), `Llega en ~${want} min`, `drive ${drive}, picked up ${ago} min ago`);
  assert.strictEqual(eta(ofd({}), 20), 'En ruta a tu dirección', 'no timestamps → the tracker\'s neutral copy');
  assert.strictEqual(eta(ofd({ is_active_drop: false, picked_up_at: NOW - 3 * MIN }), 20), SV.STATUS_STACKED_COPY, 'stacked → the tracker\'s copy, no number');
  assert.strictEqual(eta({ status: 'out_for_delivery', picked_up_at: NOW - 3 * MIN }, 20), 'Llega en ~17 min', 'no driver yet: the timestamp ETA');
  assert.strictEqual(arr({ rec: ofd({ picked_up_at: NOW - 3 * MIN }), pickup: false, prep: CONF(20), driveMin: 20, anchorMs: 0, now: NOW }).deadline, null, 'no deadline after pickup');
  ok('after pickup: delivery_eta_min first; else max(1, round(form drive − minutes since pickup)) — 20/3 → 17, 9/3 → 6, 12/3 → 9, the min-1 floor; no timestamps → "En ruta a tu dirección"; stacked → the tracker\'s copy with no number; no deadline');
}

// ── 5. the anchor and the daypart ──
{
  const A = TUE(15, 58), NOW = TUE(16, 5);   // placed at lunch, now dinner
  assert.deepStrictEqual([bucketAt(A), bucketAt(NOW)], ['weekday_lunch', 'weekday_dinner']);
  const pub = { prep_stats: { weekday_lunch: { median_min: 10, p80_min: 20, n: 20 }, weekday_dinner: { median_min: 40, p80_min: 50, n: 20 }, updated_at: NOW - HOUR } };
  assert.strictEqual(prepFor(pub, A, NOW).median, 10, 'the bucket is frozen at the ANCHOR (lunch), not now (dinner)');
  const mut = (anchor) => windowFor({ stage: 'placement', anchorMs: anchor, prep: prepFor(pub, anchor, NOW), driveMin: 12 }).low;
  assert.notStrictEqual(mut(A), mut(NOW), 'non-vacuity: an anchor at `now` would move the window');
  for (const [ms, b] of [[hn(2026, 9, 11, 12, 0), 'weekend_lunch'], [hn(2026, 9, 10, 23, 30), 'weekend_late'], [hn(2026, 9, 12, 4, 59), 'weekday_late'], [hn(2026, 9, 12, 5, 0), 'weekday_morning'], [hn(2026, 9, 12, 21, 59), 'weekday_dinner'], [hn(2026, 9, 12, 22, 0), 'weekday_late']]) assert.strictEqual(bucketAt(ms), b);
  // the form's buckets are the job's buckets (prep-stats.js), for the whole week at 30-minute steps
  const PS = require('./xpizza-functions/prep-stats.js');
  for (let t = hn(2026, 9, 12, 0, 0); t < hn(2026, 9, 19, 0, 0); t += 30 * MIN) assert.strictEqual(bucketAt(t), PS.prepBucketOf(t), new Date(t).toISOString());
  ok('the bucket is frozen at the anchor across a band boundary (placed 15:58 lunch, now 16:05 dinner → the lunch stats); band edges; the form\'s buckets equal prep-stats.js prepBucketOf over a whole week');
}

// ── 6. BC2 copy parity with the REAL tracker ──
{
  const G = JSON.parse(readFileSync(new URL('./xpizza-track/tracker-status.golden.json', import.meta.url), 'utf8'));
  const NOW = Date.UTC(2026, 9, 14, 1, 30, 0);                        // the golden's pinned clock
  const base = { order_id: 'PZX-1', customer_name: 'Ana', items_text: '1x Pepperoni', total: 340, address_short: 'Col. Palmira', created_at: NOW - 20 * MIN };
  const LOC = { lat: 15.5, lng: -88.02 };
  let cells = 0;
  const same = (cell, rec, field) => {
    const form = statusLineOf(SV.presentStatus({ ...rec, fallback_drive_min: 12, gen2: true, now: NOW }), rec);   // F4: the form passes gen2, as the tracker does
    assert.strictEqual(form, G[cell][field].text, `🔴 ${cell}: the form says "${form}", the tracker said "${G[cell][field].text}"`); cells += 1;
  };
  for (const type of ['delivery', 'pickup']) for (const status of ['new', 'preparing', 'ready', 'delivered', 'completed', 'cancelled', 'weird_status', undefined]) {
    if (type === 'pickup' && status === undefined) continue;
    same(`${type}/${status}`, { ...base, order_type: type, status }, 'driver-eta');
  }
  for (const k of ['delivered+at', 'completed+at', 'ready+brand', 'ready+blank-brand']) for (const type of ['delivery', 'pickup']) {
    const st = k.split('+')[0]; const rec = { ...base, order_type: type, status: st, ...(k === 'delivered+at' ? { delivered_at: NOW - 5 * MIN } : k === 'completed+at' ? { delivered_at: NOW - 61 * MIN } : k === 'ready+brand' ? { restaurant_display_name: '  La Musa  ' } : { restaurant_display_name: '   ' }) };
    same(`${type}/${k}`, rec, 'driver-eta');
  }
  const ofd = { ...base, order_type: 'delivery', status: 'out_for_delivery' };
  for (const [cell, rec] of [['ofd/driver/active', { driver_name: 'carlos', is_active_drop: true, driver_location: LOC }], ['ofd/driver/stacked', { driver_name: 'Carlos', is_active_drop: false, driver_location: LOC }],
    ['ofd/driver/unknown', { driver_name: 'Carlos' }], ['ofd/no-driver', {}], ['ofd/driver/active-bad-loc', { driver_name: 'Carlos', is_active_drop: true, driver_location: { lat: 'x', lng: 1 } }]]) same(cell, { ...ofd, ...rec }, 'driver-name');
  // the segbar: the same segments the tracker painted (classes + fills)
  for (const cell of ['delivery/new', 'delivery/preparing', 'pickup/ready', 'delivery/cancelled', 'ofd/driver/stacked']) {
    const [type, status] = cell.startsWith('ofd') ? ['delivery', 'out_for_delivery'] : cell.split('/');
    const rec = { ...base, order_type: type, status, ...(cell === 'ofd/driver/stacked' ? { driver_name: 'Carlos', is_active_drop: false, driver_location: LOC } : {}) };
    const segs = SV.presentStatus({ ...rec, now: NOW }).segs.map((s) => (s === 'done' ? 'seg done' : s === 'pending' ? 'seg' : `seg active:${s.a}`));
    assert.deepStrictEqual(segs, G[cell].segbar.kids.map((k) => k.cls + (k.kids ? ':' + k.kids[0].style['--p'] : '')), cell);
  }
  // the form's OWN ETA, in its own cells (BC2): same record, its own measured drive estimate; the tracker shows NO countdown
  // from pickup since F4 (its calm copy) — the form still passes gen2, and keeps its minutes because it supplies its drive
  const r3 = { ...ofd, driver_name: 'Carlos', picked_up_at: NOW - 3 * MIN };
  assert.strictEqual(G['eta/unknown/eta=undefined/ago=3']['driver-eta'].text, 'Con Carlos · pronto llegará a tu dirección', 'the tracker (F4): no countdown from pickup — the calm copy');
  assert.strictEqual(arrivalFor({ rec: r3, pickup: false, stage: 'ofd', prep: CONF(20), driveMin: 20, anchorMs: 0, overdue: false, v: SV.presentStatus({ ...r3, fallback_drive_min: 20, gen2: true, now: NOW }) }).text, 'Llega en ~17 min', 'the form: its own drive 20 − 3');
  assert.strictEqual(arrivalFor({ rec: { ...r3, delivery_eta_min: 7 }, pickup: false, stage: 'ofd', prep: CONF(20), driveMin: 20, anchorMs: 0, overdue: false, v: SV.presentStatus({ ...r3, delivery_eta_min: 7, fallback_drive_min: 20, gen2: true, now: NOW }) }).text, 'Llega en ~7 min', 'the form keeps its own arrival line (delivery_eta_min first) — unchanged by F4');
  assert.strictEqual(G['eta/unknown/eta=7/ago=3']['driver-eta'].text, 'Con Carlos · pronto llegará a tu dirección', 'the tracker (F4) ignores delivery_eta_min: the calm copy');
  ok(`BC2 copy parity: under equal inputs the form's status line is byte-identical to the REAL tracker's rendered text for ${cells} cells (status × type, timestamps, brand / blank brand, every out_for_delivery sub-state) and the segbar matches; the form's own arrival line keeps its measured minutes (17; 7 with delivery_eta_min) while the tracker shows no countdown from pickup (F4)`);
}

// ── 7. the shared modules ──
{
  const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  assert.strictEqual(read('./la-musa-orders/form-live-status.js'), read('./xpizza-orders/form-live-status.js'), 'form-live-status.js: the same bytes in both forms');
  for (const f of ['./xpizza-orders/status-view.js', './la-musa-orders/status-view.js']) assert.strictEqual(read(f), read('./xpizza-track/status-view.js'), `${f}: the tracker's bytes`);
  const strip = (s) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/typeof\s+[\w.]+\s*[!=]==?\s*'[a-z]+'/g, '');   // a typeof check is not a rid literal
  for (const f of ['./xpizza-orders/form-live-status.js', './xpizza-track/status-view.js']) {
    assert.ok(!/x_pizza|la_musa|xpizza|lamusa|X\. ?Pizza|La Musa/i.test(strip(read(f))), `🔴 ${f} names a brand`);
    assert.ok(!/(restaurantId|rid|restaurant_id)\s*[!=]==?\s*['"`]/.test(strip(read(f))), `🔴 ${f} branches on a restaurant id literal`);
  }
  assert.strictEqual(LIVE_COPY.OVERDUE, 'Está tardando un poco más de lo normal. Te dejaremos saber por WhatsApp en cuanto salga.');
  assert.strictEqual(LIVE_COPY.FALLBACK, 'Te avisaremos por WhatsApp en cuanto tu pedido salga.');
  for (const d of ['xpizza-orders', 'la-musa-orders']) {
    const html = read(`./${d}/index.html`);
    assert.ok(html.includes('>Te avisaremos por WhatsApp en cuanto tu pedido salga.</p>') && html.includes(": 'Te avisaremos por WhatsApp en cuanto tu pedido salga.';"), `${d}: the static fallback in the markup and in showSuccess is the approved copy`);
    assert.ok(html.includes('<span class="ord-wa"><span class="ord-sep"> · </span>Te avisamos por WhatsApp</span>'), `${d}: the WhatsApp note`);
  }
  ok('the shared modules are byte-identical (form-live-status.js in both forms; status-view.js in both forms and the tracker); no brand literal or rid branch; the owner-approved overdue + fallback copy is exact (module, markup, showSuccess)');
}
console.log(`\ns5-live-status: OK (${n})`);
