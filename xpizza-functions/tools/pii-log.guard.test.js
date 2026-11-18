'use strict';
// fix/privacy-gaps-5f (rule 20: no PII in logs) — no server console.* call may write a person's phone, email, name or message text into
// Cloud Logging. The scan reads EVERY console.log/warn/error/info call (multi-line, balanced parens) in every non-test server file and
// fails on an argument or ${…} interpolation that names a personal field:
//   - any identifier naming a phone / email / address (customer_phone, fromPhoneRaw, toPhone, email, …);
//   - a person's display name (customer_name, recipient_name, <driver|chosen|nextDriver|customer|profile|user>.name);
//   - an inbound message body (`body` other than body.length);
//   - in whatsapp.js (the phone I/O module) also its raw / cleaned / normalized phone and the provider's raw response (`data`).
// FALSE-POSITIVE story: the rule matches personal-field NAMES only, so ids, codes, counts and lengths pass (cell FP-ORDERID: an
// orderId / rid / status line passes; a handler's `name` or an error's e.name is not a person). A legit new log passes unchanged.
// Run: node tools/pii-log.guard.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
const FN = path.join(__dirname, '..');

const PERSONAL = /(phone|e164|msisdn|email|address|street|customer_name|recipient_name|\b(driver|chosen|nextDriver|customer|profile|user)\.name\b|(?<![\w$])(?<!Array\.)from(?![\w$(]|\s*:))/i;   // `from` as a value (data.from, msg.from), never Array.from() or an object key
// Codex #133 r1 (4): a message BODY / payload is personal in ANY form — JSON.stringify(body), body.toString(), String(payload), a spread —
// except the narrow safe reads that name no content: its .length, the request's fiscalAck flag (a boolean), a bare `body &&` guard, and
// a push payload's .tag / the deploy probe payload's .order_id (ids, never text a person wrote)
const CONTENT = /(?<![\w$])(body|payload|rawBody)(?![\w$])/g;   // a bare name or any .body / .payload property (req.body, data.body)
const CONTENT_SAFE = /^\s*(\.length\b|\.fiscalAck\b|\.tag\b|\.order_id\b|&&)/;
const namesContent = (x) => { let m; CONTENT.lastIndex = 0; while ((m = CONTENT.exec(x))) if (!CONTENT_SAFE.test(x.slice(m.index + m[0].length))) return true; return false; };
const PHONE_IO = /\b(raw|cleaned|normalized|data\b(?!\.id\b))/;   // whatsapp.js only
// the console.* calls of one source text → [{ line, hits }] where hits are the offending expressions
function scanSource(src, file = '') {
  const out = [];
  const re = /console\.(log|warn|error|info)\(/g; let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length; let dep = 1;
    while (i < src.length && dep) { const c = src[i]; if (c === '(') dep += 1; else if (c === ')') dep -= 1; i += 1; }
    const args = src.slice(m.index + m[0].length, i - 1);
    const exprs = [...args.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]);
    const bare = args.replace(/`[^`]*`|'[^']*'|"[^"]*"/g, ' ').split(',').map((s) => s.trim()).filter(Boolean);
    const unquote = (x) => x.replace(/`[^`]*`|'[^']*'|"[^"]*"/g, ' ');   // a string literal names no person
    const isPersonal = (x0) => { const x = unquote(x0); return PERSONAL.test(x) || namesContent(x) || (path.basename(file) === 'whatsapp.js' && PHONE_IO.test(x)); };
    const hits = [...exprs, ...bare].filter(isPersonal);
    if (hits.length) out.push({ line: src.slice(0, m.index).split('\n').length, hits });
  }
  return out;
}
function serverFiles(dir, acc = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (!['node_modules', 'test', 'tools', 'fixtures', 'scripts', '.git'].includes(f.name)) serverFiles(p, acc); }
    else if (/\.js$/.test(f.name) && !/\.test\.js$/.test(f.name) && !/\.proof\.js$/.test(f.name)) acc.push(p);
  }
  return acc;
}

// FP-ORDERID: a harmless line passes; the planted forms each fail (the scanner is live, not vacuous)
assert.deepStrictEqual(scanSource("console.log(`notifyPickupReady: ${orderId} → pickup-ready WhatsApp sent (rid=${rid}, status=${after})`);", 'index.js'), [], 'FP-ORDERID: an orderId / rid / status line passes');
assert.deepStrictEqual(scanSource("console.error('marketing: handler', name, e && e.name, e && e.code);", 'index.js'), [], 'FP-NAME: a handler name and an error name are not a person');
assert.deepStrictEqual(scanSource('console.log(`onIncomingWhatsApp: rid=${rid} intent=${intent} body_len=${body.length}`);', 'index.js'), [], 'FP-LEN: a body length passes');
assert.deepStrictEqual(scanSource("console.warn(`x: ${orderId} — ${acq.reason === 'payer_email_unconfigured' ? '503' : '409'}`, body && body.fiscalAck === true);", 'index.js'), [], 'FP-LITERAL: a quoted code and a request flag pass');
assert.deepStrictEqual(scanSource("console.log(`whatsapp: sent, msg id=${data.id || 'n/a'}`);", 'whatsapp.js'), [], 'FP-MSGID: the provider message id passes');
ok('false positives: orderId / rid / status, handler + error names, a body length, quoted codes, a request flag and a message id all pass');
for (const [src, file, label] of [
  ['console.log(`x: ${orderId} sent to ${order.customer_phone}`);', 'index.js', 'customer_phone'],
  ['console.log(\n  `x: from=${fromPhoneRaw}`\n);', 'index.js', 'a multi-line call'],
  ['console.warn(`x: rejected "${email}"`);', 'index.js', 'email'],
  ['console.log(`x: ${orderId} → ${chosen.name}`);', 'index.js', 'a driver name'],
  ['console.log(`x: body="${body.substring(0, 80)}"`);', 'index.js', 'a message body'],
  ["console.error('x: failed', resp.status, data);", 'whatsapp.js', 'the provider response in whatsapp.js'],
  ['console.log(`x: sent to ${normalized}`);', 'whatsapp.js', 'a normalized phone in whatsapp.js'],
  // Codex #133 r1 (2): the sender on the non-chat branch of onIncomingWhatsApp (image / voice) is the phone
  ['console.log(`onIncomingWhatsApp: ignored non-chat type=${data.type} from=${data.from}`);', 'index.js', 'the inbound sender (data.from)'],
  ['console.log(\'x: sender\', msg.from);', 'index.js', 'a bare sender argument'],
  // Codex #133 r1 (4): a body / payload in any serialized form
  ['console.log(JSON.stringify(body));', 'index.js', 'JSON.stringify(body)'],
  ['console.log(`x: ${body.toString()}`);', 'index.js', 'body.toString()'],
  ['console.warn(\'x: bad payload\', String(payload));', 'index.js', 'String(payload)'],
  ['console.log(`x: ${req.body}`);', 'index.js', 'req.body'],
  ['console.log(\'x\', { ...body });', 'index.js', 'a spread body'],
]) assert.strictEqual(scanSource(src, file).length, 1, `🔴 PII-PLANT: ${label} must be caught`);
ok('planted personal fields are caught (phone, multi-line, email, driver name, sender, message body in any form, whatsapp raw/provider data)');
assert.deepStrictEqual(scanSource("console.log('x: ids', Array.from(ids).length, `type=${data.type}`, JSON.stringify({ from: baseId }));", 'index.js'), [], 'FP-FROM: Array.from, a message type and an object key `from:` are not a sender');
assert.deepStrictEqual(scanSource('console.log(`push: ${uid} ok (${payload.tag})`, `order_id=${payload.order_id}`);', 'index.js'), [], 'FP-PAYLOAD-ID: a push tag / probe order id passes');
ok('false positives (Codex #133 r1): Array.from, a message type, an object key, a push tag and a probe order id pass');

const files = serverFiles(FN);
assert.ok(files.includes(path.join(FN, 'index.js')) && files.includes(path.join(FN, 'whatsapp.js')) && files.length > 100, `non-vacuity: the scan covers the server tree (${files.length} files)`);
const found = [];
for (const f of files) for (const h of scanSource(fs.readFileSync(f, 'utf8'), f)) found.push(`${path.relative(FN, f)}:${h.line} ${h.hits.join(' | ')}`);
assert.deepStrictEqual(found, [], `🔴 PII-LOG: a server log writes a personal field (rule 20) — log an id, a code or a length instead:\n  ${found.join('\n  ')}`);
ok(`no console.* call in the ${files.length} server files logs a phone, email, name or message body`);
console.log(`pii-log.guard: OK (${n})`);
