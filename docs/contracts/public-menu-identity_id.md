# Contract note — `identity_id` on the public menu (INTERIM, owner-approved direction)

**Date:** 2026-09-28 · **Status:** **INTERIM — owner-approved 2026-09-28; finalize at rename-enablement.** Owner direction: **document, do not strip.** Owned by the identity/catalog programme (D4-P1 / xpizza-delivery-02).
**Trigger:** after the D4-P1a x_pizza identity cutover, `getPublicMenu` (`/menu/x_pizza`) now returns an **additive `identity_id`** on every dish and extra. Currently `identity_id === dish_id` / `extra_id`; prices and pricing keys unchanged; the x_pizza order form's `liveMenuPrepare` accepts it.

## What `identity_id` is
The **stable identity key** for a catalog object (dish, extra), assigned by identity-preserving publishing. It is designed to **survive catalog-version republishes and (future) renames** — unlike display fields (name, and today the display id), which may change. It is the key the multi-merchant catalog is being built toward.

## Interim contract (what consumers may rely on TODAY — the safe rules)
1. **Additive, reserved, safe to ignore.** No current consumer (order form, tracker, any public menu reader) may **depend** on `identity_id`. It may be **absent** (La Musa is not cut over; any pre-cutover brand), may **equal** the display id, and its role is **not final**.
2. **Not a pricing/cart/fiscal key.** Pricing continues to key off the existing `items[].id` / current pricing key — never `identity_id`. Do not use `identity_id` for cart lines, quotes, redemption, or factura. (That decoupling is the config-ize slice's job, separately.)
3. **Tolerate absence and equality.** A consumer must work whether `identity_id` is present or absent, and must not assume it differs from the display id.

## Forward intent (why we document rather than strip)
- `identity_id` is the intended **stable cross-version key**. Once **renames are enabled** (`identity_flags`, currently OFF for both brands), a renamed dish keeps its `identity_id` while its display id/text changes — that is the moment `identity_id` **diverges** from the display id and becomes load-bearing.
- Stripping it now would fight the direction of the whole identity migration. Keeping it additive-and-reserved lets the platform grow into it without a churny re-expose later.

## Open items for the identity programme to finalize (before any consumer depends on it)
- **Finalize the public contract** at rename-enablement: does `identity_id` stay in the public `getPublicMenu` payload, and exactly what may consumers rely on once it diverges from the display id?
- **La Musa:** it gets `identity_id` at its cutover; keep the "tolerate absence" rule until then.
- **Order form:** confirm `liveMenuPrepare` continues to ignore it for pricing/cart identity (accept-and-ignore), and document that expectation where the form's menu contract lives.
- **Brand-agnostic tie-in:** the multi-merchant catalog should key object identity off `identity_id`, not per-brand display-id conventions — one of the things provisioning depends on.

**Bottom line:** DOCUMENT `identity_id` as an additive, reserved stable-identity key that current consumers may ignore and must not depend on; revisit and finalize the public contract when renames are enabled. Owned by the identity/catalog programme.

## Enforcement

The three rules above are not left to review. They are pinned by
**`xpizza-functions/catalog/identity-public-contract.test.js`**, wired into the `test` chain, which fails
if any of them stops holding:

| Rule | How it is enforced |
|---|---|
| Rule 1 — additive, and may be absent | Cells 1-2 drive the REAL projection (`buildPublicMenu` over `catalog-menu`'s reader) against a version published by the REAL publisher and certified by the REAL cutover (`bootstrapIdentityStamps`). For a stamped version every dish carries `identity_id === dish_id` and every extra `identity_id === extra_id`; for an UNSTAMPED version `identity_id` is ABSENT from every object. Both brands. (The certified check already catches deletion, since an absent field fails `!d.identity_id`; the uncertified case proves the different thing Rule 1 rests on — that an uncertified version carries no stamp at all.) |
| Rule 2 — not a pricing/cart/fiscal key (runtime) | Cells 3-4 read both states through the PRODUCTION path (`getRestaurantDocs` + `buildTablesFromDocs`, the same transform the serve path uses) and require the tables and the quote total to be IDENTICAL. The sensitivity partner raises one dish's price UPSTREAM, in the catalog that gets published, and requires that same production read to show it — so a converter returning fixed tables cannot satisfy both halves. |
| Rule 2 — not a pricing/cart/fiscal key (structurally) | Cell 7 selects by DEPENDENCY CLOSURE, not by filename, on BOTH SIDES OF THE WIRE: the local require-closure of `index.js` (126 modules after excluding 5 allowlisted identity owners) plus the transitive BROWSER closure of both forms — their inline scripts, all 16 of their local `<script src>` files, and anything those import — `form-cart.js` among them, where `adapter.pricingKey(record)` lives. Each file is TOKENIZED, so comments are excluded by construction and the contract note in the forms is not a hit while `d.identity_id`, `x['identity_id']` and a template use each are. It also pins that the identity CUTOVER (`identity-bootstrap.js`, `identity-restore.js`) stays OUT of the serving closure. |
| Rule 3 — tolerate absence and equality | Cells 5-6 run a REAL CONSUMER on both payloads: each form's own `liveMenuPrepare` (lifted out of the shipped HTML) and its own cart adapter. Both must ACCEPT the certified and the uncertified payload, yield menus identical apart from the identity fields, and produce identical cart/pricing keys and prices — and deleting `identity_id` from the records must not change those keys, which is what "not an input" means. Note that for La Musa the display id, `dish_id` and `identity_id` are the SAME string today, so "the key is not the stamp" is NOT a valid check; the contract forbids assuming they differ. |

**What "structurally" covers, exactly.** Two graphs, both allowlist-shaped — known-safe loader shapes are
followed, and every other loader reference fails by name with `file:line`:

- **The server graph.** `require('./literal')` with a bare `require` callee and a literal or
  substitution-free template argument, and `import`/`export … from` with a literal source. Specifiers are
  classified by where they RESOLVE, not by their spelling: builtin (via Node's own `module.isBuiltin`),
  package (inside `node_modules`, not followed), local (inside a declared root, followed), and a named
  FAILURE for anything unresolvable or resolving outside every declared root. `module.require`,
  `module["require"]`, a computed member of `module`, an aliased `require`, `require.call`, a non-literal
  specifier and a dynamic `import()` each fail.
- **The browser graph.** Every inline block and every local `<script src>` file of both forms, plus what they
  import, transitively. Resolution is BROWSER semantics — a relative URL against the importing file's own
  location, `?query` and `#fragment` stripped, no `node_modules` and no extension guessing — so a bare
  specifier (which needs an import map) and a site-absolute `/x.js` are named failures rather than silent
  passes. Loaders are decided by **TOKEN INVENTORY**, not by any AST position: every token in browser code
  whose value is `Worker`, `SharedWorker` or `importScripts` — identifier, property, destructuring key, string
  or template chunk — fails by name. Successive review rounds each found one more spelling that a
  position-based rule missed (`new Worker()`, then `new window.Worker()`, `const W = Worker`,
  `self.importScripts()`, `globalThis["Worker"]`, and finally `const { Worker: W } = window`, whose pattern key
  the code mistook for an object-literal key). A token carries no position semantics to get wrong. Measured
  when the rule was written: 22 browser units, 0 unparseable, **0 loader tokens**. A non-literal import source
  and a `require` in browser code fail too.

**The pinned exceptions.** Each is recorded and asserted to equal an exact set, so none can quietly
become a habit:

1. **`if (require.main === module)`** at `ready-time-quality-run.js` — the CLI-entrypoint guard. Accepted on
   its exact AST shape (that comparison, either operand order); `require.main` reached any other way — a
   further member access, a call, an assignment, a different comparison — fails.
2. **Six dynamic `import()` calls**, the modular Firebase SDK's lazy loads in `xpizza-orders/account.js`
   and `la-musa-orders/account.js`. These are accepted only because the base is PROVED remote from the file:
   the specifier must be ``import(`${V}/<tail>`)``, and the base is proved by **TOKEN INVENTORY** rather than by
   binding analysis: the file's identifier-token count for `V` must equal exactly one declaration plus its
   accepted interpolations, that single non-interpolation token must be the id of a `const` declarator holding
   an `https://` string literal, the declaration must structurally **enclose** every site using it, and the
   folded URL must parse as `https:`. Any other appearance of the name — a class-expression name, a
   destructuring key, a parameter, a property, `window.V` — makes the count wrong and refuses the site.
   Hand-rolled binding analysis was tried twice and lost twice, each time to a JS binding form nobody had
   modelled (a `window.V` write past a binding count, then a `class V` name past a lexical scope walk); the
   tokenizer enumerates forms nobody remembered. Measured: each `account.js` holds exactly four `V` tokens —
   one declaration and three interpolations. The remote-ness is NOT visible in the specifier text — the template
   begins with the interpolation, so its static prefix is empty — which is why it is proved from the
   declaration rather than assumed from the shape. Each accepted site is pinned by `file:line` + the exact
   specifier source + the folded URL, so a new dynamic import fails **even if the proof would accept it**,
   and a pinned site cannot change what it loads without failing. `account.js` is production code and is not
   edited for this test's sake.

3. **Twelve `window[key]` sites**, six in each form's inline script, where a one-off dismiss handler is
   stashed on and removed from `window` under a computed key. An opaque key on a global cannot be ruled out as
   a loader by reading it, so these are not ignored: each is recorded by its SOURCE TEXT and count (not by
   line, which shifts on any HTML edit) and pinned, so a new opaque key on a global fails and has to be looked
   at. The alternative — a taxonomy of "positions that cannot load" — is the enumerate-the-spellings game this
   file has already lost three times.

**Threat model.** The enforcement above detects ACCIDENTAL dependence on `identity_id` in our own code.
Deliberate concealment — `eval`, the `Function` constructor, an obfuscated loader, a native module — is out
of scope, and platform tampering belongs to the platform-security initiative rather than to this test. Every
check reads the source this repo ships, so someone who wants to hide a read can; what it buys is a guarantee
against carelessness, which is the failure that actually happens. Discovery is an ALLOWLIST of known-safe
loader shapes with any other loader reference failing by name, and the forms are parsed with jsdom rather
than by pattern, because successive review rounds each found one more spelling a denylist had missed — a
space before a paren, `module.require`, `module["require"]`, a `data-src` attribute, a dotless local
specifier, an unknown `node:` name, and finally a browser import that no server-side rule could see.

🔴 **If you are here because that test failed, it is telling you a consumer has begun depending on
`identity_id`.** That is the event this contract exists to catch. The fix is not to widen the allowlist: it
is to finalize the public contract (the open items above) and decide deliberately what consumers may rely
on. Widening the allowlist without that conversation converts a reserved field into a load-bearing one by
accident, which is exactly what "document, do not strip" was chosen to avoid.

