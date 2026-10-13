'use strict';
// WhatsApp cancellation shows the kitchen's display_number (owner 2026-10-12) — the test-only INVERSE of its ONE index.js change.
// The block's EXACT bytes are pinned (an edit inside it is detected); unapplyWaCancelIndex swaps it back for the ORIGINAL line,
// so unapplyWaCancelIndex(index.js) === 537bbbc:index.js byte-for-byte (wacancel-wiring.guard). Every index.js fold guard
// applies it FIRST (this is the newest index.js slice), before D12b's block.
const crypto = require('crypto');
const INDEX_BEGIN = '/* wacancel:begin */';
const INDEX_END = '/* wacancel:end */';
const INDEX_BLOCK = /[ \t]*\/\* wacancel:begin \*\/\n[\s\S]*?\/\* wacancel:end \*\/\n/g;
const INDEX_BLOCK_SHA256 = '42fb186e41e1cd699327f818b8b2b764fc9ff671684c90f8ea35105e12a0f511';
const INDEX_ORIGINAL = '            orderId,\n';
function unapplyWaCancelIndex(src) {
  const begins = src.split(INDEX_BEGIN).length - 1; const ends = src.split(INDEX_END).length - 1;
  const blocks = src.match(INDEX_BLOCK) || [];
  if (begins !== 1 || ends !== 1 || blocks.length !== 1) throw new Error(`wacancel-inverse: expected exactly one wacancel index.js block (begin ${begins}, end ${ends}, blocks ${blocks.length})`);
  if (crypto.createHash('sha256').update(blocks[0]).digest('hex') !== INDEX_BLOCK_SHA256) throw new Error('wacancel-inverse: the wacancel index.js block differs from its pinned bytes');
  return src.replace(INDEX_BLOCK, () => INDEX_ORIGINAL);
}
module.exports = { unapplyWaCancelIndex, INDEX_BEGIN, INDEX_END, INDEX_BLOCK_SHA256 };
