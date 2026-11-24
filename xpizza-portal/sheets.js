// Codex #196-3 — ONE registry of the catalog's open sheets and menus (app.js and extras-view.js). Each sheet registers its closer as it
// opens and leaves as it closes; the world's end (app.js resetEditFacts: another person, another restaurant, a reload) closes whatever is
// registered. A sheet that opens is a sheet that ends with the world — there is no hand-kept list to miss one.
const open = new Map();   // name → its closer (no refocus: the world it would return the caret to is over)

export function sheetOpened(name, close) { open.set(name, close); }
export function sheetClosed(name) { open.delete(name); }
export function closeAllSheets() {
  for (const [name, close] of [...open]) { open.delete(name); close(); }
}
