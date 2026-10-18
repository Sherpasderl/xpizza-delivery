// H1b T7 — tmpl.js: renders the approved prototype's own markup (sc-if / sc-for / {{path}}) so the build stays EXACT to it.
// Every binding is HTML-escaped (order data — names, notes, items — is untrusted); onClick="{{fn}}" becomes data-act="N" bound
// through a registry (no inline handlers, no eval).
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile } from './tmpl.js';

test('text and attribute bindings; nested paths; missing → empty', () => {
  const r = compile('<b class="tag {{o.cls}}">{{o.title}}</b><i>{{nope.x}}</i>').render({ o: { cls: 'late', title: '#47 · Entrega' } });
  assert.equal(r.html, '<b class="tag late">#47 · Entrega</b><i></i>');
});

test('EVERY binding is escaped (an order note cannot inject markup or break an attribute)', () => {
  const evil = '<img src=x onerror=alert(1)>"\'&';
  const r = compile('<div title="{{v}}">{{v}}</div>').render({ v: evil });
  assert.equal(r.html, '<div title="&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;">&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;</div>');
});

test('sc-if (nested, with the prototype\'s hint attributes) and sc-for (scoped, nested)', () => {
  const t = compile('<sc-if value="{{a}}" hint-placeholder-val="{{ true }}">A<sc-if value="{{b}}" hint-placeholder-val="{{ false }}">B</sc-if></sc-if>'
    + '<sc-for list="{{rows}}" as="r" hint-placeholder-count="3"><p>{{r.n}}<sc-for list="{{r.kids}}" as="k">[{{k}}{{top}}]</sc-for></p></sc-for>');
  assert.equal(t.render({ a: true, b: false, rows: [{ n: 1, kids: ['x', 'y'] }, { n: 2, kids: [] }], top: '!' }).html, 'A<p>1[x!][y!]</p><p>2</p>');
  assert.equal(t.render({ a: false, b: true, rows: null }).html, '');
});

test('onClick="{{fn}}" → data-act ids resolved through the returned registry; no inline handler survives', () => {
  let hit = '';
  const t = compile('<button class="btn" onClick="{{go}}">x</button><sc-for list="{{items}}" as="i"><button onClick="{{i.pick}}">{{i.l}}</button></sc-for>');
  const r = t.render({ go: () => { hit += 'go'; }, items: [{ l: 'a', pick: () => { hit += 'a'; } }, { l: 'b', pick: () => { hit += 'b'; } }] });
  assert.ok(!/onclick/i.test(r.html));
  const ids = [...r.html.matchAll(/data-act="(\d+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 3);
  for (const id of ids) r.acts[id]();
  assert.equal(hit, 'goab');
  assert.equal(compile('<button onClick="{{missing}}">x</button>').render({}).html, '<button>x</button>', 'no function → no handler');
});

test('a malformed template fails loudly at compile time', () => {
  assert.throws(() => compile('<sc-if value="{{a}}">x'), /unclosed sc-if/);
  assert.throws(() => compile('</sc-for>'), /unexpected/);
  assert.throws(() => compile('<sc-for list="{{x}}">y</sc-for>'), /as=/);
});
