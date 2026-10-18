// H1b T7 — the template engine for the approved prototype's OWN markup (spec/P-prototipo.dc.html), so index.html carries the
// prototype's screens near-verbatim: <sc-if value="{{x}}">…</sc-if>, <sc-for list="{{xs}}" as="x">…</sc-for>, {{path}}.
//   - every {{binding}} is HTML-escaped (order data is untrusted);
//   - onClick="{{fn}}" becomes data-act="N"; render() returns {html, acts} and app.js dispatches clicks via the registry
//     (no inline handlers, no eval). A binding that is not a function drops the attribute.
// PURE: string in, string out — unit-tested in Node.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => (v === null || v === undefined ? '' : String(v)).replace(/[&<>"']/g, (c) => ESC[c]);
const BIND = /^\s*([A-Za-z_$][\w$]*(?:\.[\w$]+)*)\s*$/;

function lookup(scopes, path) {
  const [head, ...rest] = path.split('.');
  let v;
  for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i] && Object.prototype.hasOwnProperty.call(scopes[i], head)) { v = scopes[i][head]; break; }
  for (const k of rest) v = v === null || v === undefined ? undefined : v[k];
  return v;
}
const pathOf = (attrs, name) => {
  const m = attrs.match(new RegExp(`${name}="\\{\\{([^}]*)\\}\\}"`));
  return m && BIND.test(m[1]) ? m[1].trim() : null;
};

// tokens: text | {if: path, body} | {for: path, as, body}
function parse(src) {
  const re = /<sc-(if|for)\b([^>]*)>|<\/sc-(if|for)>/g;
  const root = { body: [] }; const stack = [root]; let last = 0; let m;
  while ((m = re.exec(src))) {
    if (m.index > last) stack.at(-1).body.push(src.slice(last, m.index));
    last = re.lastIndex;
    if (m[1]) {
      const node = m[1] === 'if' ? { kind: 'if', path: pathOf(m[2], 'value'), body: [] } : { kind: 'for', path: pathOf(m[2], 'list'), as: (m[2].match(/\bas="([\w$]+)"/) || [])[1], body: [] };
      if (!node.path) throw new Error(`sc-${m[1]} needs a {{binding}}`);
      if (node.kind === 'for' && !node.as) throw new Error('sc-for needs as="name"');
      stack.at(-1).body.push(node); stack.push(node);
    } else {
      const top = stack.pop();
      if (!top || top === root || top.kind !== m[3]) throw new Error(`unexpected </sc-${m[3]}>`);
    }
  }
  if (stack.length > 1) throw new Error(`unclosed sc-${stack.at(-1).kind}`);
  if (last < src.length) root.body.push(src.slice(last));
  return root.body;
}

export function compile(src) {
  const tree = parse(src);
  return {
    render(vals) {
      const acts = {}; let n = 0;
      const text = (s, scopes) => s
        .replace(/\s+onClick="\{\{([^}]*)\}\}"/gi, (_m, p) => {
          const fn = BIND.test(p) ? lookup(scopes, p.trim()) : undefined;
          if (typeof fn !== 'function') return '';
          const id = String(++n); acts[id] = fn; return ` data-act="${id}"`;
        })
        .replace(/\{\{([^}]*)\}\}/g, (_m, p) => (BIND.test(p) ? esc(lookup(scopes, p.trim())) : ''));
      const walk = (nodes, scopes) => nodes.map((x) => {
        if (typeof x === 'string') return text(x, scopes);
        const v = lookup(scopes, x.path);
        if (x.kind === 'if') return v ? walk(x.body, scopes) : '';
        return (Array.isArray(v) ? v : []).map((item) => walk(x.body, [...scopes, { [x.as]: item }])).join('');
      }).join('');
      return { html: walk(tree, [vals || {}]), acts };
    },
  };
}
