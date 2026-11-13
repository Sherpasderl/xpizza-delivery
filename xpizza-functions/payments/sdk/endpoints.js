'use strict';
// D4 S7 (a) (NOTE-sdk-d4-S7-plan.md) — the SDK payment HTTP / trigger wrappers. THIN by design: a wrapper checks the method, hands
// its core exactly its inputs and answers the core's { status, body }; every decision is in the core. A core that throws answers
// 500 { error: 'internal' } (logged by name, never the message). makeHandlers(depsOf) is the testable seam; functions.js binds it
// per handler (PSP deps ONLY for status and switch; plain deps + the SDK_OTP_SENDER sender elsewhere). placeSdkOrder is index.js's (the hosted
// card handler's SDK branch), not here.

// the SDK_OTP_SENDER secret: { instance_id, token } as JSON; anything else ⇒ null (the recovery core answers 503)
function parseSender(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  let v; try { v = JSON.parse(raw); } catch (_) { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  return typeof v.instance_id === 'string' && v.instance_id && typeof v.token === 'string' && v.token ? { instance_id: v.instance_id, token: v.token } : null;
}

function makeHandlers(depsOf) {
  const http = (name, method, run) => async (req, res) => {
    if (req.method !== method) { res.set('Allow', method); return res.status(405).json({ error: 'method_not_allowed' }); }
    let out;
    try { out = await run(depsOf(), req); } catch (e) { console.error(`${name}: failed`, e && e.name); return res.status(500).json({ error: 'internal' }); }
    return res.status(out.status).json(out.body);
  };
  const headersOf = (req) => ({ authorization: req.get('authorization'), 'x-sherpa-order-ticket': req.get('x-sherpa-order-ticket') });
  return {
    placeSdkStatus: http('placeSdkStatus', 'GET', (d, req) => require('./status-endpoint').placeSdkStatusCore(d, { headers: headersOf(req), query: { order_id: req.query && req.query.order_id } })),
    cancelSdkPending: http('cancelSdkPending', 'POST', (d, req) => require('./switch-endpoint').cancelSdkPendingCore(d, { headers: headersOf(req), body: req.body || {} })),
    listCards: http('listCards', 'GET', (d, req) => require('./cards').listCardsCore(d, { headers: headersOf(req) })),
    removeCard: http('removeCard', 'POST', (d, req) => require('./cards').removeCardCore(d, { headers: headersOf(req), body: req.body || {} })),
    sdkPayStatus: http('sdkPayStatus', 'GET', async (d, req) => ({ status: 200, body: await require('./sdk-pay-flag').sdkPayStatusCore(d.db, req.query ? req.query.restaurant_id : undefined) })),   // ?restaurant_id (Q2): absent ⇒ global
    recoverOrderAccess: http('recoverOrderAccess', 'POST', (d, req) => require('./recovery').recoverOrderAccessCore(d, { ip: req.ip, body: req.body || {} })),
    processSdkRecovery: async (event) => { try { await require('./recovery').processRecoveryEntry(depsOf(), event.params.id); } catch (e) { console.error('processSdkRecovery: failed', e && e.name); } },
    sweepSdkRecovery: async () => { try { await require('./recovery').processRecoveryQueue(depsOf()); } catch (e) { console.error('sweepSdkRecovery: failed', e && e.name); } },
  };
}

module.exports = { makeHandlers, parseSender };
