// RULE 20 (advisor ruling 2026-11-13): no request URL built by the customer app may carry a credential — no `auth=` query
// parameter (the Firebase RTDB REST credential), so an ID token never lands in a URL (server logs, proxies, browser history).
// Tokens ride a header (the getMyOrders transport, capp-signup-api.js). Scans EVERY shipped capp source (*.js) and page (*.html).
//
// KNOWN RED until 3a's header-token callable for the member's last tip lands and capp-api's last-tip read moves to it: the read
// builds `…/last_tip.json?auth=<ID token>` (capp-api.js, PLAN-capp-tip-step r6). Excused per file in xpizza-functions/tools/
// app-suites.js KNOWN_RED — an excuse that outlives the defect fails the run (the excused file passing), so it expires itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED = (f) => /\.(js|html)$/.test(f) && !/\.test\./.test(f);
// a query parameter named auth (?auth= / &auth=), as written in source: a literal, or a template that interpolates it
const AUTH_PARAM = /[?&]auth=/;

function offenders(files, read) {
  const out = [];
  for (const f of files) read(f).split('\n').forEach((line, i) => { if (AUTH_PARAM.test(line)) out.push(`${f}:${i + 1}`); });
  return out;
}

test('URL-TOKEN probe: the scanner finds a credential query parameter in a template and in a literal, and passes a header transport', () => {
  const src = { 'a.js': 'fetch(`${base}/x.json?auth=${tok}`)', 'b.js': "const u = base + '/y.json?a=1&auth=' + t;", 'c.js': "fetch(u, { headers: { 'x-firebase-id-token': tok } })" };
  assert.deepEqual(offenders(Object.keys(src), (f) => src[f]), ['a.js:1', 'b.js:1'], 'the scanner itself (non-vacuity)');
});

test('URL-TOKEN (rule 20): no shipped customer-app source builds a URL with an `auth=` credential parameter', () => {
  const files = readdirSync(HERE).filter(SHIPPED).sort();
  assert.ok(files.includes('capp-api.js') && files.includes('capp-shell-ui.js') && files.length > 20, 'premise: the shipped sources are scanned');
  assert.deepEqual(offenders(files, (f) => readFileSync(join(HERE, f), 'utf8')), [], '🔴 URL-TOKEN: an ID token in a request URL (rule 20)');
});
