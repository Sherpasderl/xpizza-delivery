'use strict';
// TEST-OWNED preload: records every attempt to open / stat / read a dotenv-named path (basename .env or .env.*), and writes the list to
// $TB_SPY_OUT at exit. Used by photos/photos-config-wiring.test.js to prove the CLIs never read a dotenv.
const fs = require('fs');
const path = require('path');
const seen = [];
const isDotenv = (p) => { try { return /^\.env(\..*)?$/.test(path.basename(String(p))); } catch (_) { return false; } };
for (const name of ['openSync', 'readFileSync', 'existsSync', 'statSync', 'createReadStream', 'open', 'readFile']) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function spied(p, ...rest) { if (isDotenv(p)) seen.push(`${name}:${p}`); return orig.call(this, p, ...rest); };
}
const origP = fs.promises.readFile;
fs.promises.readFile = function spiedP(p, ...rest) { if (isDotenv(p)) seen.push(`promises.readFile:${p}`); return origP.call(this, p, ...rest); };
process.on('exit', () => { if (process.env.TB_SPY_OUT) fs.writeFileSync(process.env.TB_SPY_OUT, JSON.stringify(seen)); });
