// node --test review/capp-perf/face-match.test.mjs — the F4 face match (Codex #113 P2). The records have the shape of CDP's
// PlatformFontUsage; the positive ones are what the slot run of 11-16 printed for the self-hosted face («Figtree Light») and the
// fallbacks (Arial, .SF NS). The family is read from figtree-fonts.css exactly as capp-perf.cdp.mjs reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFace, fontsLabel } from './face-match.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = fs.readFileSync(path.join(ROOT, 'customer-app/figtree-fonts.css'), 'utf8');
const FAMILY = [...new Set([...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]).filter((b) => /src:\s*url\(/.test(b))
  .map((b) => ((b.match(/font-family:\s*['"]?([^;'"]+)['"]?/) || [])[1] || '').trim()))];
const rec = (familyName, isCustomFont) => ({ familyName, postScriptName: familyName.replace(/\s+/g, '-'), isCustomFont, glyphCount: 12 });

test('premise: figtree-fonts.css self-hosts exactly one family', () => assert.deepEqual(FAMILY, ['Figtree']));
const F = FAMILY[0];

test('the self-hosted face (a web font) matches — by its default instance «Figtree Light» and by the bare family', () => {
  assert.equal(isFace([rec('Figtree Light', true)], F), true);
  assert.equal(isFace([rec('Figtree', true)], F), true);
  assert.equal(isFace([rec('Arial', false), rec('Figtree Light', true)], F), true, 'a node with a fallback glyph run still renders the face');
});

test('NEGATIVE (Codex #113 P2): an INSTALLED font named «Figtree …» (isCustomFont false) is NOT the self-hosted face', () => {
  assert.equal(isFace([rec('Figtree X', false)], F), false, 'an installed «Figtree X» must not pass as the web font');
  assert.equal(isFace([rec('Figtree', false)], F), false, 'an installed «Figtree» must not pass as the web font');
});

test('the fallbacks never match: the local() aliases report the system font', () => {
  assert.equal(isFace([rec('Arial', false)], F), false);
  assert.equal(isFace([rec('.SF NS', false)], F), false);
  assert.equal(isFace([rec('FigtreeSans', true)], F), false, 'a different family that merely starts with the letters');
  assert.equal(isFace([], F), false);
  assert.equal(isFace(null, F), false);
});

test('the label marks local fonts, so a swap reads plainly in the cell messages', () => {
  assert.equal(fontsLabel([rec('Arial', false)]), 'Arial (local)');
  assert.equal(fontsLabel([rec('Figtree Light', true)]), 'Figtree Light');
});
