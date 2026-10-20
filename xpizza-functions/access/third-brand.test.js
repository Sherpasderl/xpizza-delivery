'use strict';
// OWNER RULE (brand-agnostic): a SYNTHETIC third brand end to end through the REAL endpoint core, writer, resolver, authorizer
// and the publish handler's fiscal gate — the owner invites a manager by email, the manager accepts and acts, the owner toggles
// «Puede editar el menú y los precios», and the fiscal publish path is decided by usesPlatformFactura (data), not a name.
const test = require('node:test');
const assert = require('node:assert');
const { createFakeDb } = require('../merchant/_fake-db');
const H = require('./team-http-core');
const { resolveAccess } = require('./membership');
const { authorizeCatalogEdit } = require('../catalog/catalog-edit-auth');
const { fiscalPublishGate } = require('../catalog/publish-edited-handler');
const { usesPlatformFactura } = require('../factura/eligibility');

test('third brand «sabor»: owner invites → manager accepts → acts per capabilities → menu toggle → publish by flag', async () => {
  const db = createFakeDb({
    brands: { sabor: { name: 'Sabor', active: true, locations: { sb_centro: 'member', sb_norte: 'member' }, activation: { state: 'on', since: 1 } } },
    restaurants: { sb_centro: { identity: { brand_id: 'sabor' } }, sb_norte: { identity: { brand_id: 'sabor' } } },
    brand_members: { sabor: { owners: { ownerS1: { granted_at: 1, granted_by: 'cli:op' } } } },
    platform_config: { membership_writes_enabled: true },
  });
  const TOK = { owner: { uid: 'ownerS1' }, mgr: { uid: 'mgrSab01', email: 'gerente@sabor.test', email_verified: true } };
  let n = 0;
  const deps = { db, verifyIdToken: async (t) => TOK[t], now: () => 5, randomToken: () => `sabTok${String(++n).padStart(4, '0')}DDDDDDDDDDDDDDD` };
  const req = (who, body) => ({ method: 'POST', body, get: (h) => (h.toLowerCase() === 'authorization' ? `Bearer ${who}` : undefined) });
  assert.ok(!usesPlatformFactura('sb_centro'), 'premise: the third brand issues no platform factura');

  const inv = await H.handle('memberInvite', deps, req('owner', { brandId: 'sabor', rids: ['sb_centro'], email: 'Gerente@Sabor.test' }));
  assert.strictEqual(inv.status, 200, JSON.stringify(inv));
  assert.deepStrictEqual((await H.handle('memberAcceptInvite', deps, req('mgr', { inviteId: inv.body.inviteId }))).body, { ok: true, outcome: 'granted' });

  const a = await resolveAccess({ db }, { uid: 'mgrSab01', token: TOK.mgr }, 'sb_centro');
  for (const c of ['availability.set', 'location.hours', 'location.pause', 'stats.read', 'device.list']) assert.ok(a.caps.includes(c), c);
  assert.ok(!a.caps.includes('catalog.edit') && !(await resolveAccess({ db }, { uid: 'mgrSab01', token: TOK.mgr }, 'sb_norte')).caps.length, 'only the granted branch; no menu yet');

  assert.strictEqual((await H.handle('memberSetMenuPermission', deps, req('owner', { brandId: 'sabor', uid: 'mgrSab01', can_edit_menu: true }))).status, 200);
  const r = { get: (h) => (h.toLowerCase() === 'authorization' ? 'Bearer mgr' : undefined) };
  const auth = await authorizeCatalogEdit({ db, verifyIdToken: async () => TOK.mgr }, r, 'sb_centro');
  assert.ok(auth.ok && auth.caps.includes('catalog.publish') && !auth.caps.includes('catalog.fiscal_ack'));
  assert.strictEqual(fiscalPublishGate('sb_centro', auth, {}), null, 'no platform factura (flag) → the permitted manager publishes directly');
  // the SAME manager capabilities at a platform-factura location would need the owner's ack — keyed on the flag, not a name
  const facturaRid = ['x_pizza'].find((rid) => usesPlatformFactura(rid));
  assert.strictEqual(fiscalPublishGate(facturaRid, auth, { fiscalAck: true }).body.error, 'not_owner', 'flag on → the owner must confirm');

  assert.deepStrictEqual((await H.handle('memberList', deps, req('owner', { brandId: 'sabor' }))).body,
    { ok: true, owner: 'ownerS1', managers: { mgrSab01: { rids: ['sb_centro'], can_edit_menu: true } } });
});
