/**
 * Behavioral suite for the User Profiles P0 RTDB rules.
 *
 * Run against the Firebase RTDB emulator:
 *   npm run test:user-profiles-rules
 *     = firebase emulators:exec --only database --project demo-xpizza \
 *         "node test/user-profiles-rules.emulator.test.js"
 *
 * Covers:
 *   A — owner-only PII: owner reads/writes only its own /user_profiles/$uid; others + anon denied.
 *   B — R2 fix: a client CANNOT strip a server-truth field (phone/phone_hash/created_at/last_login) via
 *       child-delete, nor set() an incomplete profile (.validate skips nulls; the parent .write hasChildren
 *       guard cascades to child writes on the merged post-write node). update({name}) still works.
 *   C — immutability: last_login/created_at/phone cannot be advanced/changed by the client.
 *   D — tombstone (H10): a tombstoned uid cannot (re)create its profile; deleted_uids is deny-all.
 *   E — deny-all server nodes: otp/otp_ip/phone_index/user_orders unreadable/unwritable by clients.
 *   F — H1: a customer:true token cannot read staff operational nodes (/orders).
 *
 * Plain-node style (no jest) to match the repo's existing `node *.test.js` tests.
 */
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'xpizza-reference', 'database.rules.json'), 'utf8');

const OWNER = 'u_owner0000000000000000';
const OTHER = 'u_other0000000000000000';
const TOMB = 'u_tomb00000000000000000';
// A complete, valid server-written profile (the 4 server-truth fields verifyOtp writes on creation).
const PROFILE = { phone: '50499998888', phone_hash: 'ph_owner_abc', created_at: 1700000000000, last_login: 1700000000000 };

(async () => {
  const env = await initializeTestEnvironment({
    projectId: 'demo-xpizza',
    database: { rules: RULES }, // emulator host/port auto-detected from emulators:exec env
  });

  // Admin-seed (rules disabled) — mirrors verifyOtp's admin creation + a tombstone for the TOMB uid.
  await env.withSecurityRulesDisabled(async (ctx) => {
    await ctx.database().ref('user_profiles/' + OWNER).set(PROFILE);
    await ctx.database().ref('deleted_uids/' + TOMB).set(1700000000000);
  });

  const ownerDb = env.authenticatedContext(OWNER).database();
  const otherDb = env.authenticatedContext(OTHER).database();
  const anonDb = env.unauthenticatedContext().database();
  const tombDb = env.authenticatedContext(TOMB).database();
  const custDb = env.authenticatedContext('u_cust0000000000000000', { customer: true }).database();

  let n = 0;
  const ok = async (label, pr) => { await assertSucceeds(pr); console.log(`  ok ${++n} ${label}`); };
  const no = async (label, pr) => { await assertFails(pr); console.log(`  ok ${++n} ${label}`); };
  const get = (db, p) => db.ref(p).get();
  const set = (db, p, v) => db.ref(p).set(v);
  const upd = (db, p, v) => db.ref(p).update(v);

  // ── A: owner-only PII ──
  await ok('A owner reads its own profile', get(ownerDb, 'user_profiles/' + OWNER));
  await no('A a different authed user cannot read the profile', get(otherDb, 'user_profiles/' + OWNER));
  await no('A anon cannot read the profile', get(anonDb, 'user_profiles/' + OWNER));
  await no('A a different authed user cannot write the profile', upd(otherDb, 'user_profiles/' + OWNER, { name: 'X' }));

  // ── B: R2 — client cannot strip a server-truth field, nor set() an incomplete profile ──
  await no('B owner CANNOT delete phone_hash (child-delete)', set(ownerDb, `user_profiles/${OWNER}/phone_hash`, null));
  await no('B owner CANNOT delete last_login', set(ownerDb, `user_profiles/${OWNER}/last_login`, null));
  await no('B owner CANNOT delete created_at', set(ownerDb, `user_profiles/${OWNER}/created_at`, null));
  await no('B owner CANNOT delete phone', set(ownerDb, `user_profiles/${OWNER}/phone`, null));
  await no('B owner CANNOT set() a profile missing last_login', set(ownerDb, `user_profiles/${OWNER}`,
    { phone: PROFILE.phone, phone_hash: PROFILE.phone_hash, created_at: PROFILE.created_at }));
  await no('B owner CANNOT set() a profile missing phone_hash', set(ownerDb, `user_profiles/${OWNER}`,
    { phone: PROFILE.phone, created_at: PROFILE.created_at, last_login: PROFILE.last_login }));
  await ok('B owner CAN update({name}) on the complete profile (legitimate edit still works)',
    upd(ownerDb, `user_profiles/${OWNER}`, { name: 'Ana' }));

  // ── C: server-truth immutability (client cannot change values that remain present) ──
  await no('C owner cannot advance last_login (dodge sweep)', upd(ownerDb, `user_profiles/${OWNER}`, { last_login: 9999999999999 }));
  await no('C owner cannot change created_at', upd(ownerDb, `user_profiles/${OWNER}`, { created_at: 1 }));
  await no('C owner cannot change phone', upd(ownerDb, `user_profiles/${OWNER}`, { phone: '50400000000' }));
  await no('C owner cannot write a malformed addresses node (invalid $addrId key)', set(ownerDb, `user_profiles/${OWNER}/addresses`, { home: 'x' }));
  await no('C owner cannot write a stray key ($other denied)', set(ownerDb, `user_profiles/${OWNER}/nickname`, 'z'));

  // ── D: tombstone (H10) — a tombstoned uid cannot (re)create/write its profile; deleted_uids deny-all ──
  await no('D tombstoned uid cannot set() a fresh profile', set(tombDb, `user_profiles/${TOMB}`, PROFILE));
  await no('D tombstoned uid cannot update its profile', upd(tombDb, `user_profiles/${TOMB}`, { name: 'Z' }));
  await no('D client cannot read deleted_uids', get(ownerDb, `deleted_uids/${TOMB}`));
  await no('D client cannot write deleted_uids', set(ownerDb, `deleted_uids/${OWNER}`, 1));

  // ── E: deny-all server nodes ──
  await no('E client cannot read otp', get(ownerDb, 'otp/ph_owner_abc'));
  await no('E client cannot read phone_index', get(ownerDb, 'phone_index/ph_owner_abc'));
  // P3: user_orders opened to read-own (was deny-all "until P3")
  await ok('E owner CAN read its own user_orders (P3 read-own)', get(ownerDb, `user_orders/${OWNER}`));
  await no('E a different authed user CANNOT read user_orders', get(otherDb, `user_orders/${OWNER}`));
  await no('E anon CANNOT read user_orders', get(anonDb, `user_orders/${OWNER}`));
  await no('E client CANNOT write user_orders (Admin-SDK only)', set(ownerDb, `user_orders/${OWNER}/PZX-1`, { ts: 1 }));
  await no('E client cannot write otp_ip', set(ownerDb, 'otp_ip/x', { count: 1 }));

  // ── F: H1 — a customer:true token cannot read staff operational nodes ──
  await no('F customer token cannot read /orders', get(custDb, 'orders'));
  await no('F customer token cannot read /tasks', get(custDb, 'tasks'));
  await no('F customer token cannot read /config', get(custDb, 'config'));

  // ── G: saved addresses (P1) — owner-only structured store, bounds, referential default, tombstone ──
  const VALID = { label: 'Casa', detected: 'Col. Trejo, SPS', details: 'porton negro', lat: 15.5, lng: -88.0, created_at: 1700000000000, last_used_at: 1700000000000 };
  const AID = 'a_' + 'a'.repeat(12), AID2 = 'a_' + 'b'.repeat(12);
  const AP = `user_profiles/${OWNER}/addresses`;

  // codex-on-diff FIX: a DIRECT scalar write to the addresses CONTAINER would bypass the $addrId validators
  // (no child to match) — the container .validate must reject scalars (objects only).
  await no('G direct scalar write to addresses (string) denied', set(ownerDb, AP, 'x'.repeat(5000)));
  await no('G direct scalar write to addresses (number) denied', set(ownerDb, AP, 12345));
  await no('G direct scalar write to addresses (boolean) denied', set(ownerDb, AP, true));
  await ok('G empty addresses object allowed (clears the map, deletes last address)', set(ownerDb, AP, {}));
  await ok('G owner writes a valid full address', set(ownerDb, `${AP}/${AID}`, VALID));
  await no('G a different authed uid cannot read this uid addresses', get(otherDb, AP));
  await no('G a different authed uid cannot write this uid addresses', set(otherDb, `${AP}/${AID}`, VALID));
  await no('G a tombstoned uid cannot write an address', set(tombDb, `user_profiles/${TOMB}/addresses/${AID}`, VALID));
  // per-field bounds + shape
  await no('G lat out of range (91) denied', set(ownerDb, `${AP}/${AID2}`, { ...VALID, lat: 91 }));
  await no('G lng out of range (-181) denied', set(ownerDb, `${AP}/${AID2}`, { ...VALID, lng: -181 }));
  await no('G label over length (41) denied', set(ownerDb, `${AP}/${AID2}`, { ...VALID, label: 'x'.repeat(41) }));
  await no('G detected over length (201) denied', set(ownerDb, `${AP}/${AID2}`, { ...VALID, detected: 'y'.repeat(201) }));
  await no('G stray $other key in an address denied', set(ownerDb, `${AP}/${AID2}`, { ...VALID, extra: 'z' }));
  await no('G partial address (missing lat/lng/detected) denied', set(ownerDb, `${AP}/${AID2}`, { label: 'Casa' }));
  await no('G bad $addrId key (x_1) denied', set(ownerDb, `${AP}/x_1`, VALID));
  // default_address referential integrity (POST-write, via newData.parent + the .write clause)
  await no('G default_address → nonexistent addrId denied', upd(ownerDb, `user_profiles/${OWNER}`, { default_address: 'a_' + 'f'.repeat(12) }));
  await ok('G default_address = null OK', upd(ownerDb, `user_profiles/${OWNER}`, { default_address: null }));
  await ok('G atomic create-address + set-default in one update OK', upd(ownerDb, `user_profiles/${OWNER}`, { [`addresses/${AID2}`]: VALID, default_address: AID2 }));
  await no('G delete the referenced address leaving a dangling default denied', upd(ownerDb, `user_profiles/${OWNER}`, { [`addresses/${AID2}`]: null }));
  await ok('G delete the referenced address + clear default atomically OK', upd(ownerDb, `user_profiles/${OWNER}`, { [`addresses/${AID2}`]: null, default_address: null }));
  await no('G drop a server-truth field while adding an address denied', upd(ownerDb, `user_profiles/${OWNER}`, { phone: null, [`addresses/${AID2}`]: VALID }));
  // NOTE: the ≤10-address cap is enforced CLIENT-SIDE (saveAddress, Phase B / Task B3), NOT in rules —
  // RTDB rules have no child-count function (`numChildren()` is client-SDK only). The addresses node is
  // owner-only + per-field validated, so an owner over-saving their OWN addresses is a benign nuisance,
  // not a security exposure. Covered by a Phase B saveAddress JS test.

  await env.cleanup();
  console.log(`user-profiles-rules.emulator: OK (${n} assertions)`);
})().catch((e) => {
  console.error('user-profiles-rules.emulator: FAIL\n', e);
  process.exit(1);
});
