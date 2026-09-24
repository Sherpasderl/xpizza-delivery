'use strict';
/**
 * The active-pointer reader — absent is pre-P1, present-but-unusable is a fault.
 * Run: node catalog/pointer-state.test.js
 *
 * 🔴 WHY THIS IS ITS OWN SLICE, AND WHY IT COMES FIRST. Every registry writer Slice E fences reads
 * {version, generation} through pointerStateOf. Until now it COERCED: a version that was present but
 * not a usable string became `null`, and a generation that was present but not a non-negative integer
 * became `0`. Both collapse a fault into the one value that is safest-looking and most dangerous —
 * `null` means "nothing published yet" to every caller, and `0` is the pre-cutover generation that
 * every claim bound before the cutover compares equal to. Building a fence on a reader that answers
 * `0` to garbage is fencing against a liar, so the reader is fixed before anything depends on it.
 *
 * The asymmetry that made it worse: getActiveVersionId already THROWS `active_version_malformed` on
 * exactly the bytes pointerStateOf turned into `null`. One document, two readers, opposite verdicts —
 * so whether corruption was visible depended on which reader a caller happened to use.
 */
const assert = require('assert');
const { readPointerSnap } = require('./catalog-firestore');

/* 🔴 EVERY CELL DRIVES readPointerSnap, BECAUSE IT IS NOW THE ONLY DOOR. These used to call
   pointerStateOf with plain objects — which is exactly the raw-data entry point that let callers
   interpret this document for themselves, and it is no longer exported. Driving the private helper
   also let the cells conflate two different states: `{}` meant "no version FIELD" to pointerStateOf
   and could not mean "the DOCUMENT exists but names none", which is the distinction the defect lived
   in. A snapshot double carries existence, so the cells can now say which one they mean. */
const snapOf = (data) => ({ exists: data !== undefined && data !== null, data: () => data });
const pointerStateOf = (data, where = 'x_pizza') => readPointerSnap(snapOf(data), where);

let n = 0; const ok = (l) => console.log(`  ✓ ${++n} ${l}`);
/* The fault name says WHICH FIELD: an unusable version is `active_version_malformed` (the established
   name, already alarmed on by catalog-menu and catalog-versioned), an unusable generation is
   `active_pointer_malformed` (a condition that did not exist before E-1). One fault, one name. */
const refusesVersion = (data, why) => assert.throws(() => pointerStateOf(data, 'x_pizza'), /active_version_malformed/, why);
const refuses = (data, why) => assert.throws(() => pointerStateOf(data, 'x_pizza'), /active_pointer_malformed/, why);

// ── 1. AN ABSENT DOCUMENT IS PRE-P1 — AND IT IS THE ONLY THING THAT IS ──────────────────────
/* 🔴 THIS CELL USED TO CONFLATE TWO STATES, and the conflation is where the defect lived. It drove the
   private raw-data helper, which cannot see whether the DOCUMENT exists — so `{}` meant "no version
   FIELD" and was treated as the pre-cutover state, exactly as the flip's fourth reader treated it.
   Driving the only door, with a snapshot double that carries existence, the two separate:
     · the DOCUMENT is absent  → nothing published yet. The genuine pre-cutover state.
     · the document EXISTS and names no version → a partial write, and a FAULT (cell 7).
   Refusing the first would refuse every restaurant not yet through bootstrap; accepting the second
   lets a first publish's CAS overwrite whatever is really live. */
{
  const preP1 = (data, label) => {
    try { return readPointerSnap(snapOf(data), 'x_pizza'); } catch (e) {
      assert.fail(`🔴 ${label} was REFUSED as malformed — an ABSENT document is the genuine pre-cutover state, and a reader that refuses it refuses every restaurant not yet through bootstrap: ${e.message}`);
    }
  };
  for (const [label, data] of [['no document at all', undefined], ['a null snapshot payload', null]]) {
    const r = preP1(data, label);
    assert.strictEqual(r.version, null, `${label}: nothing is published`);
    assert.strictEqual(r.generation, 0, `${label}: the fence starts at the pre-cutover baseline`);
    assert.strictEqual(r.exists, false, `${label}: and the reader says the document is not there, which is what separates this from a partial write`);
  }

  /* THE REAL PRE-CUTOVER POINTER: a document that names a version and carries NO generation. That is
     what every un-migrated restaurant looks like — the advisor confirmed both live brands are exactly
     this shape — and it must keep reading as generation 0. */
  const legacy = preP1({ version: 'v1' }, 'a pre-P1 pointer with no generation');
  assert.deepStrictEqual({ version: legacy.version, generation: legacy.generation }, { version: 'v1', generation: 0 },
    '🔴 a live pre-cutover pointer — a real version, no generation field — must read as generation 0, or the cutover refuses every restaurant it is for');
  const explicit = preP1({ version: 'v1', generation: 0 }, 'an explicit generation 0');
  assert.strictEqual(explicit.generation, 0, 'and an explicitly written 0 is the same state');
  ok('an ABSENT document is the only "nothing published yet"; a pre-cutover pointer (version, no generation) still reads as generation 0');
}

// ── 2. 🔴 A PRESENT-BUT-UNUSABLE VERSION IS A FAULT, NOT AN "UNPUBLISHED" ───────────────────
/* This is the dangerous direction. Every caller reads `version: null` as "nothing is published yet",
   and a first publish's CAS expects exactly that — so a corrupt pointer read as null would let a
   publish sail past the check that stops it overwriting a live menu. */
{
  refusesVersion({ version: 42 }, '🔴 a numeric version was read as "unpublished" — a corrupt pointer became a fresh restaurant');
  refusesVersion({ version: '' }, '🔴 an empty version string was read as "unpublished"');
  refusesVersion({ version: {} }, '🔴 an object version was read as "unpublished"');
  refusesVersion({ version: ['v1'] }, '🔴 an array version was read as "unpublished"');
  refusesVersion({ version: true }, '🔴 a boolean version was read as "unpublished"');
  ok('five present-but-unusable versions REFUSE instead of reading as "nothing published yet"');
}

// ── 3. 🔴 A PRESENT-BUT-UNUSABLE GENERATION MUST NOT READ AS 0 ──────────────────────────────
/* 0 is not a neutral default here — it is the pre-cutover baseline, the exact value a claim bound
   before the cutover compares equal to. A fence that answers 0 to garbage opens itself, which is the
   same defect the D-1 pointer write had when a full REPLACE dropped the field entirely. */
{
  refuses({ version: 'v1', generation: -1 }, '🔴 a negative generation read as 0');
  refuses({ version: 'v1', generation: 1.5 }, '🔴 a fractional generation read as 0');
  refuses({ version: 'v1', generation: '3' }, '🔴 a STRING generation read as 0 — the shape a client or a bad migration writes');
  refuses({ version: 'v1', generation: NaN }, '🔴 NaN read as 0');
  refuses({ version: 'v1', generation: Infinity }, '🔴 Infinity read as 0');
  refuses({ version: 'v1', generation: {} }, '🔴 an object generation read as 0');
  refuses({ version: 'v1', generation: true }, '🔴 a boolean generation read as 0');
  ok('seven present-but-unusable generations REFUSE instead of reading as 0, the value every pre-cutover claim matches');
}

// ── 4. 🔴 THE GATE CONDITION: A MALFORMED GENERATION CANNOT REACH A FENCE AS 0 ──────────────
/* Stated as a property of the reader rather than of any one caller, because the fences Slice E adds
   do not exist yet and the ones that do are in transactions a unit test cannot open. What CAN be
   proven here, and is the whole of the claim, is that there is no input for which the reader returns
   generation 0 while the stored generation was present and unusable — so no fence downstream can ever
   be handed that 0, whatever it does with it.
   Driven as a census over every malformed shape rather than a list of examples: a property asserted
   about "these seven values" is a property about seven values. */
{
  const MALFORMED = [-1, -99, 1.5, '0', '3', '', NaN, Infinity, -Infinity, {}, [], true, false, () => 0];
  let refused = 0;
  for (const g of MALFORMED) {
    let out = null;
    try { out = pointerStateOf({ version: 'v1', generation: g }, 'x_pizza'); } catch (e) { refused += 1; continue; }
    assert.fail(`🔴 generation ${JSON.stringify(String(g))} was accepted and read as ${out.generation} — a fence downstream would compare against it`);
  }
  assert.strictEqual(refused, MALFORMED.length, 'every malformed generation refused');

  /* SENSITIVITY — the census is not vacuous: the legitimate values still pass, and a reader that
     refused everything would satisfy the loop above while breaking every restaurant. */
  /* 🔴 THE CALL IS INSIDE THE TRY, NOT INSIDE THE ASSERTION'S ARGUMENTS. An assertion's message only
     protects what happens INSIDE the assertion: `assert.strictEqual(reader(x), y, 'message')` runs the
     reader FIRST, so a reader that throws on a legitimate generation escapes with its raw error and
     the sentence explaining the consequence never runs. The cell still fails — but it reports a crash
     instead of the property, which is the same class as scoring a mutant kill on a stack trace. */
  for (const g of [0, 1, 7, 1000, Number.MAX_SAFE_INTEGER]) {
    let got;
    try { got = pointerStateOf({ version: 'v1', generation: g }).generation; }
    catch (e) {
      assert.fail(`🔴 SENSITIVITY: a legitimate generation ${g} was REFUSED (${e.message}) — the census above passes for the wrong reason, and a reader that refuses real generations breaks every restaurant that has one`);
    }
    assert.strictEqual(got, g,
      `🔴 SENSITIVITY: a legitimate generation ${g} read back as ${got} — the census above passes for the wrong reason`);
  }
  ok(`no malformed generation can reach a fence as 0 (${MALFORMED.length} shapes refused, 5 legitimate ones still read back exactly)`);
}

// ── 5. THE REFUSAL SAYS WHICH FIELD AND WHAT IT HELD ────────────────────────────────────────
/* An operator reading this in a log has to fix a document. "Malformed" alone sends them to read the
   whole pointer; naming the field and the value it carries is the difference between a one-minute fix
   and an investigation. */
{
  try {
    pointerStateOf({ version: 'v1', generation: '3' }, 'x_pizza');
    assert.fail('expected a refusal');
  } catch (e) {
    assert.match(e.message, /x_pizza/, 'names the restaurant');
    assert.match(e.message, /generation/, 'names the field');
    assert.match(e.message, /"3"/, 'and quotes the value actually stored');
  }
  try {
    pointerStateOf({ version: 42 }, 'la_musa');
    assert.fail('expected a refusal');
  } catch (e) {
    assert.match(e.message, /active_version_malformed/, 'an unusable VERSION carries the version fault name');
    assert.match(e.message, /la_musa/, 'names the restaurant');
    assert.match(e.message, /version/, 'names the field');
    assert.match(e.message, /42/, 'and quotes the value');
  }
  // …and the `where` is optional, so a caller with no rid to hand still gets a usable message.
  /* The rid is no longer optional — readPointerSnap is the only door and every caller has one, which
     is itself part of the shape change: a reader you can call without saying WHICH restaurant is a
     reader whose errors cannot be acted on. The `where`-less spelling is gone with the raw-data
     entry point, so what is asserted now is that the rid is always in the message. */
  assert.throws(() => pointerStateOf({ generation: -1 }, 'some_shop'), /active_pointer_malformed: some_shop — generation is -1/,
    'the fault, the restaurant and the field all appear together');
  ok('the refusal names the restaurant, the field, and the value the document actually holds');
}

// ── 6. PURE, AND IT DOES NOT MUTATE THE DOCUMENT IT WAS HANDED ──────────────────────────────
{
  const doc = { version: 'v1', generation: 4, at: 'whenever', extra: { nested: true } };
  const frozen = JSON.parse(JSON.stringify(doc));
  /* Same rule as cell 4: a reader that throws on this perfectly ordinary document would escape with
     its raw error and none of the purity assertions below would report what actually broke. */
  let a, b;
  try { a = pointerStateOf(doc); b = pointerStateOf(doc); }
  catch (e) { assert.fail(`🔴 a well-formed pointer — a real version, a real generation, and the ordinary extra fields the flip writes — was REFUSED: ${e.message}`); }
  assert.deepStrictEqual(a, b, 'the same document gives the same pair');
  assert.deepStrictEqual(doc, frozen, '🔴 the reader MUTATED the pointer document');
  /* The reader returns the pair PLUS `exists`, which is part of its contract — it is what separates
     an absent document from a partial write, and the raw-data helper could not express it. What must
     still not leak is everything ELSE the flip writes: `at`, and anything a future write adds. */
  assert.deepStrictEqual(a, { version: 'v1', generation: 4, exists: true },
    'it returns the pair and the existence fact, and nothing else');
  assert.deepStrictEqual(Object.keys(a).sort(), ['exists', 'generation', 'version'],
    '🔴 a caller can reach `at` or another stored field through the reader — the document is bigger than the decision, and handing back the rest invites someone to use it');
  ok('the reader is pure, mutates nothing, and returns only the {version, generation} pair');
}

// ── 7. 🔴 THE TWO READERS AGREE, BYTE FOR BYTE — THE CONTRACT E-1 SET OUT TO MEET ───────────
/* E-1's first pass fixed pointerStateOf's coercion and left getActiveVersionId parsing the same bytes
   for itself, so the gate could still build a table where one reader said "nothing published" and the
   other threw, and a generation of "0" was fatal to one and invisible to the other. Same document,
   two verdicts, decided by which function a caller happened to call.
   Both now go through readPointerSnap, and this drives IT — the shared decision — rather than only
   the pure parse underneath. The rows are the gate's own table plus the case it exposed. */
{
  const snap = (d) => ({ exists: d !== undefined, data: () => d });
  const verdict = (d) => {
    try { const r = readPointerSnap(snap(d), 'x_pizza'); return { ok: true, version: r.version, generation: r.generation, exists: r.exists }; }
    catch (e) { return { ok: false, code: String(e.message).split(':')[0] }; }
  };

  assert.deepStrictEqual(verdict(undefined), { ok: true, version: null, generation: 0, exists: false },
    'an ABSENT document is the genuine "nothing published yet" — and the only one');
  assert.deepStrictEqual(verdict({ version: 'v1' }), { ok: true, version: 'v1', generation: 0, exists: true },
    'a pre-P1 pointer: a real version, no generation yet');
  assert.deepStrictEqual(verdict({ version: 'v1', generation: 3 }), { ok: true, version: 'v1', generation: 3, exists: true },
    'a post-cutover pointer reads back exactly');

  /* 🔴 AN EXISTING DOCUMENT THAT NAMES NO VERSION IS A FAULT. Only the flip writes this document and
     it always writes a version, so a versionless one is a partial write — and reading it as an
     unpublished restaurant is the same defect E-1 fixed for a version of the wrong TYPE: a corrupt
     pointer that looks like a fresh one, which a FIRST publish's CAS is allowed to overwrite. */
  for (const [label, d] of [['an empty document', {}], ['an explicit null version', { version: null }]]) {
    const v = verdict(d);
    assert.strictEqual(v.ok, false,
      `🔴 ${label} read as "nothing published yet" — a partial write would look like a fresh restaurant, and a first publish would be allowed to overwrite whatever is really live`);
    assert.strictEqual(v.code, 'active_version_malformed', `${label}: expected the version fault name, got ${v.code}`);
  }

  /* 🔴 AND THE FIELD-LEVEL FAULTS REACH IT, so the shared decision is not laxer than the parse it
     delegates to — which is how the two readers drifted apart in the first place. */
  assert.strictEqual(verdict({ version: 'v1', generation: '0' }).code, 'active_pointer_malformed',
    '🔴 a generation of the STRING "0" passed through the shared reader — it is fatal to the parse and must be fatal here');
  assert.strictEqual(verdict({ version: 42 }).code, 'active_version_malformed',
    '🔴 a numeric version passed through the shared reader');
  ok('the shared reader: absent means unpublished, an existing document naming no version is a FAULT, and every field-level fault reaches it');
}

// ── 8. 🔴 RAW DATA CANNOT BE MISTAKEN FOR A SNAPSHOT ────────────────────────────────────────
/* The guard had the defect it exists to prevent. `!snap.exists` is falsy for ANY plain object, so raw
   data read as "nothing published yet" — and not only the empty shapes: a fully populated
   `{version: 'v1', generation: 9}` came back as an ABSENT pointer, which is the one answer a first
   publish's CAS is allowed to overwrite. A caller reaching for the old raw-data habit got the most
   dangerous possible result from the door built to refuse it.
   🔴 THE POPULATED CASE IS THE ONE THAT MATTERS. An empty object reading as absent is nearly
   harmless; a LIVE pointer's data reading as absent is how a menu gets overwritten. It is asserted
   first for that reason. */
{
  const refusesRaw = (v, label) => {
    let out;
    try { out = readPointerSnap(v, 'x_pizza'); }
    catch (e) {
      assert.match(e.message, /active_pointer_not_a_snapshot/,
        `${label} was refused, but not as a snapshot-shape fault: ${e.message}`);
      return;
    }
    assert.fail(`🔴 ${label} was read as a pointer and returned ${JSON.stringify(out)} — raw data must never be mistaken for a snapshot, and reading a populated pointer as "nothing published yet" is the value a first publish is allowed to overwrite`);
  };
  refusesRaw({ version: 'v1', generation: 9 }, 'a fully POPULATED plain object');
  refusesRaw({}, 'an empty plain object');
  refusesRaw({ version: null }, 'a plain object with a null version');
  refusesRaw(null, 'null');
  refusesRaw(undefined, 'undefined');
  refusesRaw('v1', 'a bare string');
  refusesRaw({ exists: true }, 'an object with exists but no data()');
  refusesRaw({ data: () => ({}) }, 'an object with data() but no exists');
  refusesRaw({ exists: 'yes', data: () => ({}) }, 'an object whose exists is not a BOOLEAN');

  /* SENSITIVITY — real snapshots still work, both states. Without this the refusals above are
     satisfied by a reader that refuses everything, which would break every pointer read there is. */
  assert.strictEqual(readPointerSnap({ exists: false, data: () => undefined }, 'x').exists, false,
    '🔴 SENSITIVITY: a genuine ABSENT snapshot was refused');
  assert.strictEqual(readPointerSnap({ exists: true, data: () => ({ version: 'v1', generation: 3 }) }, 'x').generation, 3,
    '🔴 SENSITIVITY: a genuine PRESENT snapshot was refused');
  ok('nine raw shapes — a populated plain object first — are refused as snapshot-shape faults; real snapshots in both states still read');
}

// ── 9. 🔴 NO FOURTH READER — THE CENSUS, WALKED FROM DISK ───────────────────────────────────
/* E-1 claimed there was no third reader and the gate proved it false: three CLI tools parsed the
   pointer document for themselves — one coercing with `|| null`, one validating the version and
   IGNORING the generation, one with no validation at all, and that one was the ROLLBACK tool, the
   path D-2.1 had just shown can move the pointer to a version that was never live.
   All three now go through readPointerSnap. This is what stops a FOURTH appearing: every production
   file that reads the active_version document must also reference the shared reader. Walked from
   disk rather than listed, so a new file is caught the day it is added — the same shape as the
   emulator-ports guard, which caught a script arriving from main on the first rebase after it landed.
   🔴 A TEXT CENSUS IS A LINT, NOT A PROOF — an alternate spelling walks past it, exactly as this
   codebase has said about source-pattern checks before. It is here because it costs nothing and
   catches the copy-paste case, which is how all three of these arose. */
{
  const fs = require('fs'), path = require('path');
  const ROOT = path.join(__dirname, '..');
  const SKIP = new Set(['node_modules', '.git', 'test']);
  const READS = /doc\(\s*['"`]active_version['"`]\s*\)/;
  const SHARED = /readPointerSnap|pointerStateOf|getActivePointer|getActiveVersionId/;
  const offenders = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.js') || /\.test\.js$/.test(name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (READS.test(src) && !SHARED.test(src)) offenders.push(path.relative(ROOT, full));
    }
  };
  walk(ROOT);
  assert.deepStrictEqual(offenders.sort(), [],
    `🔴 a production file reads the active_version document without going through the shared reader — the same bytes will mean different things depending on which path a caller took, which is the asymmetry E-1 exists to remove: ${offenders.join(', ')}`);

  /* SENSITIVITY: the census actually finds the files it is meant to police. If the walk matched
     nothing, the assertion above would pass for a repo with no pointer readers at all. */
  let readers = 0;
  const count = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) { count(full); continue; }
      if (!name.endsWith('.js') || /\.test\.js$/.test(name)) continue;
      if (READS.test(fs.readFileSync(full, 'utf8'))) readers += 1;
    }
  };
  count(ROOT);
  assert.ok(readers >= 4,
    `🔴 SENSITIVITY: the census found only ${readers} files reading the pointer — it is not walking what it claims to, so its empty result proves nothing`);
  ok(`every one of the ${readers} production files that reads the active_version document goes through the shared reader`);
}

console.log(`pointer-state: OK (${n})`);
