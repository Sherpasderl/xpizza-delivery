// Kitchen "all-day make-count" rail — pure, dependency-free browser ESM (imported by index.html,
// golden-tested by rail-count.test.mjs). It reuses the SAME bracket-aware ' | ' splitter + qty/name
// regex as renderItems() in index.html, and deliberately NOT order-filter's parseItems(): parseItems
// does a naive itemsText.split(' | ') which miscounts pizzas whose extras bracket contains ' | '
// (e.g. "[Pizza 1: extra | Pizza 2: extra]"). renderItems() stays byte-for-byte in index.html — this
// is a rail-only copy so the count logic is independently testable.
//
// The rail counts PIZZAS by name × qty. Extras (the `[...]` payload, per-instance "Pizza N:" prefixes,
// and the "(todas)" collapse) are display concerns for the ticket body and never affect the make-count.

// Bracket-aware split of one items_text on ' | ' at bracket-depth 0.
export function railSplit(itemsText) {
  if (!itemsText || itemsText === '—') return [];
  const out = [];
  let depth = 0, cur = '';
  for (let i = 0; i < itemsText.length; i++) {
    const c = itemsText[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    if (depth === 0 && itemsText.slice(i, i + 3) === ' | ') { out.push(cur.trim()); cur = ''; i += 2; }
    else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// Roll up an array of items_text strings into an ordered make-count [{name, qty}], most-made first
// (qty desc, then name asc for a stable, deterministic order). Mirrors renderItems' qty/name regex:
//   ^(\d+)x  Name  (optional " (Lprice)")  (optional " [extras]")
export function railCount(itemsTexts) {
  const counts = new Map();
  for (const t of itemsTexts || []) {
    for (const entry of railSplit(t)) {
      const m = entry.match(/^(\d+)x\s+(.+?)(?:\s+\(L[\d.]+\))?(?:\s+\[(.+)\])?$/);
      if (!m) continue;
      const qty = parseInt(m[1], 10);
      const name = m[2].trim();
      counts.set(name, (counts.get(name) || 0) + qty);
    }
  }
  return [...counts.entries()]
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty || a.name.localeCompare(b.name));
}
