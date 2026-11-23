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
  const em = p.cs(p.d.getElementById('whoami'));
  assert.deepEqual([em.whiteSpace === 'nowrap', em.textOverflow === 'ellipsis', em.overflowWrap], [false, false, 'anywhere'], 'the email is never truncated: it breaks onto a second line (at the «@» — boot.js)');
  const lh = parseFloat(em.lineHeight), fs = parseFloat(em.fontSize);
  const reserved = parseFloat(p.cs(p.foot).minHeight);
  assert.ok(Number.isFinite(reserved) && reserved >= 2 * lh * (lh < 4 ? fs : 1), `the footer reserves two email lines (min-height ${p.cs(p.foot).minHeight}, email line ${em.lineHeight} @ ${em.fontSize})`);
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
