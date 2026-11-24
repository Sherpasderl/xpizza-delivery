// The sidebar's account footer (OWNER 11-12, live: «sherpasderl@gm…», «Dueño», then «Sherpa ·» / «administrador» wrapping over two
// lines beside the logout button — crammed). Standing rule 16b: text never looks crammed. The footer shows ONE role line that never
// wraps: «Dueño» / «Gerente…» on every brand view, «Admin Sherpa» INSTEAD of it on a Sherpa-admin view (shell.js toggles
// `.app.admview`), never both; the role truncates on one line. The EMAIL is shown in FULL (advisor 11-14, slot-1114 D3: «dueno@ejemplo.t…»
// hid meaning, rule 16b): a long one breaks onto a second line AT THE «@» (boot.js's <wbr>, shell-wait.test.mjs D3; overflow-wrap only as
// the fallback for one part wider than the line), and the footer reserves two email lines so nothing jumps.
// OWNER-APPROVED 2026-11-14 (via the advisor): KEEP the full email — this SUPERSEDES the owner's 11-12 «each line truncates, the full
// email in the tooltip» note above (the role line still truncates; the email no longer does).
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

// OWNER 11-23 picked D3 = A (MOCKUP-portal-footer-email-D3, artifact QY4YwiuGUh7qhxoZThoE8W): ROW 1 = avatar · ONE role line · logout;
// ROW 2 = the email at the footer's full width, in FULL, its two parts (local part, «@domain») each an inline-block around boot.js's <wbr>,
// so a long email breaks ONLY at the «@» (overflow-wrap:anywhere stays only for a part wider than the whole footer). The role still
// truncates on one line (the 11-12 rule stands for the role). No reserved empty line: the email is written before the portal shows.
function page(admin) {
  // the page's markup as shipped, scripts left out (only the cascade is under test)
  const dom = new JSDOM(HTML.replace(LINK, `<style>${CSS}</style>`).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''), { pretendToBeVisual: true });
  const d = dom.window.document;
  d.getElementById('app').classList.toggle('admview', admin);
  const sfoot = d.querySelector('.sfoot');
  const row = sfoot.querySelector(':scope > .frow');
  const cs = (e) => dom.window.getComputedStyle(e);
  const roles = row ? [...row.querySelectorAll('.cv')].filter((e) => cs(e).display !== 'none') : [];
  return { d, sfoot, row, cs, roles };
}
const oneLine = (p, e, what) => {
  const s = p.cs(e);
  assert.equal(s.whiteSpace, 'nowrap', `${what} never wraps`);
  assert.equal(s.textOverflow, 'ellipsis', `${what} truncates with an ellipsis`);
  assert.equal(s.overflow, 'hidden', `${what} clips`);
};

test('D3 = A (owner 11-23): row 1 is avatar · ONE role line («Dueño») · logout; row 2 is the email alone, at the full footer width', () => {
  const p = page(false);
  assert.equal(p.cs(p.sfoot).flexDirection, 'column', '🔴 the footer stacks its two rows');
  assert.ok(p.row, '🔴 a first row');
  assert.deepEqual([...p.row.children].filter((e) => p.cs(e).display !== 'none').map((e) => e.id || e.className.split(' ')[0]), ['avatar', 'whorole', 'logout'], '🔴 row 1: avatar · the role · logout');
  const info = p.sfoot.querySelector(':scope > .sinfo');
  assert.ok(info && [...info.children].length === 1 && info.firstElementChild.id === 'whoami', '🔴 row 2: the email alone, a direct row of the footer (its full width)');
  oneLine(p, p.d.getElementById('whorole'), 'the role');
  assert.equal(p.cs(p.d.getElementById('logout')).flexShrink, '0', 'the logout button never squeezes the role');
});
test('D3 = A: the email is never truncated; its two parts are inline-blocks, so it breaks ONLY at the «@» (anywhere only inside a part wider than the footer)', () => {
  const p = page(false);
  const em = p.cs(p.d.getElementById('whoami'));
  assert.deepEqual([em.whiteSpace === 'nowrap', em.textOverflow === 'ellipsis', em.overflow === 'hidden'], [false, false, false], '🔴 never «…»');
  const part = p.d.createElement('span'); part.className = 'p'; p.d.getElementById('whoami').append(part);
  const ps = p.cs(part);
  assert.deepEqual([ps.display, ps.overflowWrap, ps.maxWidth], ['inline-block', 'anywhere', '100%'], '🔴 a part is one unbreakable block (unless wider than the footer)');
  assert.ok(['auto', '0px', ''].includes(p.cs(p.sfoot.querySelector(':scope > .sinfo')).minHeight), 'no reserved empty line: the email is written before the portal shows');
});
test('a Sherpa-admin view: row 1 shows ONE role line «Admin Sherpa» instead of the brand role', () => {
  const p = page(true);
  assert.equal(p.roles.length, 1, 'one role line, never two');
  assert.equal(p.roles[0].textContent, 'Admin Sherpa', 'the admin label');
  oneLine(p, p.roles[0], 'the admin label');
});
test('the rows breathe: the mockup\'s 1.5 line height, an 11 px gap before the logout button, 8 px between the rows', () => {
  const p = page(false);
  assert.equal(p.cs(p.d.getElementById('whorole')).lineHeight, '1.5', 'the role line breathes');
  assert.equal(p.cs(p.d.getElementById('whoami')).lineHeight, '1.5', 'the email lines breathe');
  assert.ok(parseFloat(p.cs(p.row).gap || p.cs(p.row).columnGap) >= 11, 'a gap before the logout button');
  assert.equal(parseFloat(p.cs(p.sfoot).gap || p.cs(p.sfoot).rowGap), 8, 'the mockup\'s 8 px between the rows');
});
