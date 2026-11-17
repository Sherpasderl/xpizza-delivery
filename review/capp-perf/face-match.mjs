// The F4 face match, alone so it can be proven without a browser (Codex #113 P2). Input: the records CDP's
// CSS.getPlatformFontsForNode returns for a node — PlatformFontUsage { familyName, postScriptName, isCustomFont, glyphCount }.
// A variable font reports the family of its default named instance (the self-hosted woff2's name table: nameID 1 «Figtree Light»,
// fvar wght default 300) at EVERY weight, so the platform name is the family itself or the family + a space + the instance.
// The name alone is not provenance: an INSTALLED «Figtree …» would match it. Only a web font (isCustomFont: an @font-face url()
// the page loaded) is the self-hosted face; the local() fallbacks and any installed font report isCustomFont false.
export const isFace = (records, family) => Array.isArray(records)
  && records.some((r) => !!r && r.isCustomFont === true && (r.familyName === family || String(r.familyName).startsWith(family + ' ')));
// the records as one readable line for the cell messages (and for before/after equality)
export const fontsLabel = (records) => (Array.isArray(records) ? records.map((r) => `${r.familyName}${r.isCustomFont ? '' : ' (local)'}`).join(',') : '');
