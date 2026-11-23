// The account footer's email, built EXACT to the approved mockups (rule 16b; advisor 11-16): every portal mockup that draws the footer
// (MOCKUP-portal-calificaciones*, -crecer, -envio-*, -dish-photo, -category-rename …) sets `.sfoot .sinfo b{font-size:12px;letter-spacing:-.01em}`;
// the build had 12.5px and no tracking — «dueno@ejemplo.test» overflowed its 117 px box by 4 px on every 1280 frame. The type stays; the
// truncation does NOT: D3 = A (OWNER 11-14 «Final», advisor 11-23) shows the email in FULL, breaking at the «@» (account-footer.test.mjs,
// shell-wait.test.mjs D3). COMPUTED: jsdom over the SHIPPED index.html with the shipped styles.css inlined. Run: node --test whoami-fit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const { JSDOM } = createRequire(join(DIR, '..', 'xpizza-functions', 'package.json'))('jsdom');
const CSS = readFileSync(join(DIR, 'styles.css'), 'utf8');
const HTML = readFileSync(join(DIR, 'index.html'), 'utf8');
const LINK = '<link rel="stylesheet" href="./styles.css">';
assert.ok(HTML.includes(LINK), 'premise: the page links the stylesheet');

test('the footer email is set as the mockups draw it: 12px, letter-spacing −.01em — in FULL, never ellipsized (D3 = A, owner 11-14)', () => {
  const dom = new JSDOM(HTML.replace(LINK, `<style>${CSS}</style>`).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), { pretendToBeVisual: true });
  const e = dom.window.document.getElementById('whoami');
  assert.ok(e && e.closest('.sfoot .sinfo'), 'premise: b#whoami in the account footer');
  const s = dom.window.getComputedStyle(e);
  assert.deepEqual([s.fontSize, s.letterSpacing], ['12px', '-0.12px'], 'the mockup\'s type for the email: 12px, −.01em (computed: −0.12px) — was 12.5px, no tracking');
  assert.deepEqual([s.whiteSpace === 'nowrap', s.textOverflow === 'ellipsis', s.overflowWrap], [false, false, 'anywhere'], '🔴 the owner\'s D3 = A: the full email, never «…» (overflow-wrap only as the fallback past the «@» break)');
});
