// The account footer's email, built EXACT to the approved mockups (rule 16b; advisor 11-16): every portal mockup that draws the footer
// (MOCKUP-portal-calificaciones*, -crecer, -envio-*, -dish-photo, -category-rename …) sets `.sfoot .sinfo b{font-size:12px;letter-spacing:-.01em}`;
// the build had 12.5px and no tracking — «dueno@ejemplo.test» overflowed its 117 px box by 4 px on every 1280 frame. The OWNER's 11-12 one-line
// rule is unchanged (account-footer.test.mjs: nowrap + ellipsis + the full email in the tooltip). COMPUTED: jsdom over the SHIPPED index.html
// with the shipped styles.css inlined. Run: node --test whoami-fit.test.mjs
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

test('the footer email is set as the mockups draw it: 12px, letter-spacing −.01em — and still ONE line with the ellipsis (owner 11-12)', () => {
  const dom = new JSDOM(HTML.replace(LINK, `<style>${CSS}</style>`).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), { pretendToBeVisual: true });
  const e = dom.window.document.getElementById('whoami');
  assert.ok(e && e.closest('.sfoot .sinfo'), 'premise: b#whoami in the account footer');
  const s = dom.window.getComputedStyle(e);
  assert.deepEqual([s.fontSize, s.letterSpacing], ['12px', '-0.12px'], 'the mockup\'s type for the email: 12px, −.01em (computed: −0.12px) — was 12.5px, no tracking');
  assert.deepEqual([s.whiteSpace, s.textOverflow, s.overflow], ['nowrap', 'ellipsis', 'hidden'], 'the owner\'s one-line rule, unchanged');
});
