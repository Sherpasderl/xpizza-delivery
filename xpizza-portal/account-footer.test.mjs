// The sidebar's account footer (OWNER 11-12, live: «sherpasderl@gm…», «Dueño», then «Sherpa ·» / «administrador» wrapping over two
// lines beside the logout button — crammed). Standing rule 16b: text never looks crammed. The footer shows ONE role line that never
// wraps: «Dueño» / «Gerente…» on every brand view, «Admin Sherpa» INSTEAD of it on a Sherpa-admin view (shell.js toggles
// `.app.admview`), never both; the email and the role each truncate on one line (the full email in the tooltip — boot.js).
// COMPUTED styles: jsdom over the SHIPPED index.html with the shipped styles.css inlined (the cascade is what failed: `.sfoot .sinfo
// .cv{display:block}` outranked `.admonly{display:none}`). Run: node --test account-footer.test.mjs
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

function page(admin) {
  // the page's markup as shipped, scripts left out (only the cascade is under test)
  const dom = new JSDOM(HTML.replace(LINK, `<style>${CSS}</style>`).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), { pretendToBeVisual: true });
  const d = dom.window.document;
  d.getElementById('app').classList.toggle('admview', admin);
  const foot = d.querySelector('.sfoot .sinfo');
  const lines = [...foot.children];
  const cs = (e) => dom.window.getComputedStyle(e);
  return { d, foot, lines, cs, shown: lines.filter((e) => cs(e).display !== 'none') };
}
const oneLine = (p, e, what) => {
  const s = p.cs(e);
  assert.equal(s.whiteSpace, 'nowrap', `${what} never wraps`);
  assert.equal(s.textOverflow, 'ellipsis', `${what} truncates with an ellipsis`);
  assert.equal(s.overflow, 'hidden', `${what} clips`);
};

test('a brand view: the email + ONE role line («Dueño»); the admin label is not shown', () => {
  const p = page(false);
  assert.deepEqual(p.shown.map((e) => e.id || e.className), ['whoami', 'whorole'], 'one role line, never two');
  oneLine(p, p.d.getElementById('whoami'), 'the email');
  oneLine(p, p.d.getElementById('whorole'), 'the role');
});
test('a Sherpa-admin view: the email + ONE role line «Admin Sherpa» instead of the brand role', () => {
  const p = page(true);
  const shown = p.shown;
  assert.equal(shown.length, 2, 'one role line, never two');
  assert.equal(shown[1].textContent, 'Admin Sherpa', 'the admin label');
  oneLine(p, shown[1], 'the admin label');
});
test('the role line has room: a comfortable line height and space before the logout button', () => {
  const p = page(false);
  const lh = parseFloat(p.cs(p.d.getElementById('whorole')).lineHeight);
  assert.ok(lh >= 1.3, `the role line breathes (line-height ${p.cs(p.d.getElementById('whorole')).lineHeight})`);
  assert.ok(parseFloat(p.cs(p.d.querySelector('.sfoot')).gap || p.cs(p.d.querySelector('.sfoot')).columnGap) >= 11, 'a gap before the logout button');
  assert.equal(p.cs(p.d.getElementById('logout')).flexShrink, '0', 'the logout button never squeezes the text');
});
