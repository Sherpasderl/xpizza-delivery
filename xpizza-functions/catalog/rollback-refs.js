'use strict';
// «Quitar del menú» × rollback (Codex #176 P2-1). A removal takes a dish's OWN references with it (P-R4: exposure.item_overrides[key],
// extras_by_item[key], its redeem_eligible_items entry — the same three add-product's compareToActive lets a declared removal clear and
// catalog-edit's pendingRemovalRows carries as `refs`). When a rollback re-adds the dish to the editable source (catalog-publish's
// re-add: row, stamp, item_order), it brings those three back from the TARGET version's structure, so the source matches the version it
// rolled back to. Only re-added keys are touched, only an entry the source lacks is set, and only into a map the source carries — an
// absent map stays absent (the forms keep an ABSENT map in force). The reward entry is placed before its first surviving follower in the
// target's list, else last — the item_order rule.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function restoreOwnRefs(structure, targetStructure, keys) {
  if (!isObj(structure) || !isObj(targetStructure) || !keys || !keys.length) return structure;
  const st = JSON.parse(JSON.stringify(structure));
  const tov = isObj(targetStructure.exposure) && isObj(targetStructure.exposure.item_overrides) ? targetStructure.exposure.item_overrides : {};
  const tebi = isObj(targetStructure.extras_by_item) ? targetStructure.extras_by_item : {};
  const trei = Array.isArray(targetStructure.redeem_eligible_items) ? targetStructure.redeem_eligible_items : [];
  for (const key of keys) {
    if (isObj(st.exposure) && isObj(st.exposure.item_overrides) && Object.prototype.hasOwnProperty.call(tov, key) && !Object.prototype.hasOwnProperty.call(st.exposure.item_overrides, key)) {
      st.exposure.item_overrides[key] = JSON.parse(JSON.stringify(tov[key]));
    }
    if (isObj(st.extras_by_item) && Object.prototype.hasOwnProperty.call(tebi, key) && !Object.prototype.hasOwnProperty.call(st.extras_by_item, key)) {
      st.extras_by_item[key] = JSON.parse(JSON.stringify(tebi[key]));
    }
    if (Array.isArray(st.redeem_eligible_items) && trei.includes(key) && !st.redeem_eligible_items.includes(key)) {
      const at = trei.indexOf(key); let placed = false;
      for (const follower of trei.slice(at + 1)) {
        const idx = st.redeem_eligible_items.indexOf(follower);
        if (idx !== -1) { st.redeem_eligible_items.splice(idx, 0, key); placed = true; break; }
      }
      if (!placed) st.redeem_eligible_items.push(key);
    }
  }
  return st;
}

module.exports = { restoreOwnRefs };
