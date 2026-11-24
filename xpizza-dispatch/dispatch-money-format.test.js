// xpizza-dispatch/dispatch-money-format.test.js
//
// SBS catch (Codex #246 round): the «Cancelar pedido» confirm sub printed the total raw as `L${o.total}`
// («L420»), while the approved mockup draws «L 1,250.00». The canonical fmtL formatter (es-HN thousands + 2
// decimals) must produce the mockup format, and the confirm sub must USE it (not the raw interpolation).
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);

const fnSrc = (name) => { const s = html.indexOf(`function ${name}(`); return html.slice(s, html.indexOf('\n}', s) + 2); };

// ── the REAL fmtL formatter produces the approved «L 1,250.00» shape ──
{
  const fmtL = new Function(`${fnSrc('fmtL')}\n; return fmtL;`)();
  assert.strictEqual(fmtL(1250), 'L 1,250.00', 'L 1,250.00 (thousands + 2 decimals, as the mockup draws)');
  assert.strictEqual(fmtL(420), 'L 420.00', 'a small integer still gets 2 decimals');
  assert.strictEqual(fmtL(1250.5), 'L 1,250.50', 'a fractional amount keeps its centavos');
  assert.strictEqual(fmtL(0), 'L 0.00', 'zero is L 0.00');
  assert.strictEqual(fmtL(null), '—', 'a null total renders «—», never «LNaN» or «Lnull»');
  assert.strictEqual(fmtL(undefined), '—', 'undefined renders «—»');
  assert.strictEqual(fmtL('nope'), '—', 'a non-numeric total renders «—»');
  ok('fmtL formats money as «L 1,250.00» (es-HN thousands + 2 decimals); null/non-finite → «—»');
}

// ── the «Cancelar pedido» confirm sub USES fmtL, not the raw L${o.total} ──
{
  const src = fnSrc('confirmCancelOrder');
  assert.ok(src.includes('fmtL(o.total)'), 'the cancel-confirm sub formats the total through fmtL');
  assert.ok(!/`\s*·\s*L\$\{o\.total\}/.test(src) && !src.includes('L${o.total}'), 'the raw `L${o.total}` interpolation is gone from the cancel confirm');
  ok('the «Cancelar pedido» confirm sub formats its total through fmtL (no raw L${o.total})');
}

console.log(`dispatch-money-format: OK (${n})`);
