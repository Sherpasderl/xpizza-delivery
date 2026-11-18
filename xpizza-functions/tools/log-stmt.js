'use strict';
// fix/privacy-gaps-5f (Codex #133 r1 items 5–6) — ONE answer to «is this source ONLY a log statement?», by AST (acorn, already in the tree),
// never by counting parentheses (a ')' inside a string or template would hide a statement). Used by privacy-wiring.guard (every changed
// line of a privacy hunk is a pure log line or an enumerated non-log line) and by the reviewer proof D4c-grill/privacy-5f/proof-log-only.js.
//   pureLogCall(node)       — a console.log/warn/error/info CallExpression whose arguments cannot change state (no assignment, update,
//                             delete, await, yield, new, tagged template, or call other than the PURE ones below)
//   isPureLogStatement(src) — src parses as exactly ONE statement, an ExpressionStatement of a pureLogCall (comments allowed)
const acorn = require('acorn');

const CONSOLE = new Set(['log', 'warn', 'error', 'info']);
const PURE_METHODS = new Set(['toFixed', 'slice', 'substring', 'join', 'toString', 'toISOString', 'trim']);
const PURE_FUNCS = new Set(['String', 'Number', 'Boolean']);
const isConsole = (c) => c && c.type === 'MemberExpression' && !c.computed && c.object.type === 'Identifier' && c.object.name === 'console' && CONSOLE.has(c.property.name);
const pureCallee = (c) => (c.type === 'Identifier' && PURE_FUNCS.has(c.name))
  || (c.type === 'MemberExpression' && !c.computed && (PURE_METHODS.has(c.property.name) || (c.object.type === 'Identifier' && c.object.name === 'JSON' && c.property.name === 'stringify')));

function pureExpr(n) {
  if (!n || typeof n !== 'object') return true;
  switch (n.type) {
    case 'AssignmentExpression': case 'UpdateExpression': case 'AwaitExpression': case 'YieldExpression': case 'NewExpression':
    case 'TaggedTemplateExpression': case 'FunctionExpression': case 'ArrowFunctionExpression': case 'ClassExpression': case 'ImportExpression':
      return false;
    case 'UnaryExpression': if (n.operator === 'delete') return false; break;
    case 'CallExpression': if (!pureCallee(n.callee)) return false; break;
    default:
  }
  for (const [k, v] of Object.entries(n)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue;
    if (Array.isArray(v)) { if (!v.every((x) => pureExpr(x))) return false; } else if (v && typeof v === 'object' && typeof v.type === 'string' && !pureExpr(v)) return false;
  }
  return true;
}
const pureLogCall = (n) => !!n && n.type === 'CallExpression' && isConsole(n.callee) && n.arguments.every(pureExpr);

function parse(src) {
  try { return acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }); } catch (_) { return null; }
}
function isPureLogStatement(src) {
  const p = parse(src);
  return !!p && p.body.length === 1 && p.body[0].type === 'ExpressionStatement' && pureLogCall(p.body[0].expression);
}
module.exports = { parse, pureExpr, pureLogCall, isPureLogStatement, CONSOLE };
