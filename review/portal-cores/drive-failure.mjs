// The census tool's drive failure (advisor 11-18, the owed-2 slot STOP): a core state's drive can fail BECAUSE its own data function was
// not served — the 2×1 picker lists no dishes when getEditableCatalog 404s, so the drive's waitFor fails before corePremise runs. When the
// state's own data function is recorded in `unserved`, that 404 is reported FIRST (the drive error kept as the cause); any other drive
// failure is returned unchanged. Never a pre-check before the drive: it would move every state's timing.
export function driveFailure(name, own, unserved, err) {
  if (!own || !unserved.includes(own)) return err;
  return new Error(`premise: ${name}: its own data function ${own} was not served (404) during the capture (drive) — then the drive failed: ${err && err.message}`, { cause: err });
}
