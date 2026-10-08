# Runbook: pausing orders for a restaurant ("Pausar pedidos")

Design: `PLAN-D4c4.md` rev 13. Code:
- `xpizza-functions/order-control-state.js` (how the switch is read);
- `xpizza-functions/order-control.js` (the reader);
- `xpizza-functions/tools/order-control.js` (this CLI, the only writer).

## What a pause does — and what it never does

A pause stops NEW intake for ONE restaurant:
- **New orders:** a new cash, card-on-delivery or free order, and a new or rotated online checkout, are refused with `423 ordering_paused`.
  - The customer sees: "Este restaurante no está recibiendo pedidos en este momento. Probá de nuevo más tarde."
  - Their cart, order number and reward are kept.
- **Scheduled orders:** they are HELD at their release time. They release on the next sweep after the pause ends.

A pause NEVER touches money. There are no refunds and no voids, and it changes no captured payment.
- A checkout the customer already started keeps working: they can still pay, and that order goes live as usual.
- A retry of an order the restaurant already accepted still succeeds.
- An order paid during a pause is a normal, accepted order. Fulfil it.

If the pause state can't be read (an outage, or a malformed node), new intake gets a retryable `503`. The customer sees "Tuvimos un problema momentáneo, probá de nuevo." The functions fail CLOSED for new orders only.

## Commands

The project is ALWAYS stated explicitly. Every command is a DRY RUN until you add `--apply`.

```bash
cd xpizza-functions

# pause with no end time (until you resume)
node tools/order-control.js --project xpizza-delivery --rid <rid> --pause --reason "cocina llena" --actor "<your name>" --apply

# pause for a while: auto-resumes on its own, nothing to clean up (N minutes or hours, at most 7 days)
node tools/order-control.js --project xpizza-delivery --rid <rid> --pause --for 2h --reason "…" --actor "<your name>" --apply

# pause until a given time — the time MUST carry an explicit offset (Z or ±HH:MM) and be more than 60 s away
node tools/order-control.js --project xpizza-delivery --rid <rid> --pause --until 2026-10-08T21:00:00-06:00 --reason "…" --actor "<your name>" --apply

# resume now
node tools/order-control.js --project xpizza-delivery --rid <rid> --resume --reason "…" --actor "<your name>" --apply
```

- **Dry run.** Run without `--apply` first to see the current state, the change and the version.
  - To bind the apply to exactly what you saw, add `--expect-version <N>`.
  - If anyone changed the switch in between, the apply is REFUSED and nothing is written. Re-run it.
- **Unknown restaurant.** An unknown `--rid` is refused.
- **No-op.** The same state (and the same end time) writes nothing.
- **Audit.** Every applied change is ONE atomic write: the new state plus an audit row in `order_control/<rid>/events/<op_id>`. The row records:
  - the full before/after `{paused, until}`;
  - your `--actor`;
  - the authenticated Google account (`principal`);
  - the reason and server time.
- **Clock.** The CLI uses the SERVER's clock (from RTDB). If your laptop clock is off by more than 5 minutes it prints a WARNING, but still uses the corrected time. Fix your clock anyway.

## What "effective" means

After `--apply` the CLI waits about 12 s (the functions' 10 s cache, plus a margin), then reads the switch again.
- It prints `EFFECTIVE` when its change is still the current one.
- It prints `SUPERSEDED by <op_id>` when someone changed it after you.

From that point, every request whose pause check STARTS after the change sees it. A request already in flight that read "open" just before your change may still complete. That is in-flight work, by design.

A timed pause ends on its own at `until`: the functions compare `until` with their own clock on every request. No job runs and nothing is written. Function clocks may differ by a few seconds; simultaneity across instances is not promised.

## What staff see

**Dispatch** shows a banner for every effectively paused restaurant: "<name> — pedidos pausados hasta HH:MM · <reason>". The time is in the dispatcher's browser time.
- The banner disappears by itself within 30 s of `until` (sooner on tab focus). Nothing is written.
- "Estado de pausa no disponible — reintentando" means dispatch can't read the switch, or the node is malformed. That never means "open".

**Held scheduled orders** show a tag in En Fila → Programados:
- "retenido — pausa";
- "retenido — estado de pausa no disponible", when the hold came from an unreadable state.

When the pause ends, the sweep (every 2 minutes) releases them through today's checks. A slot that expired meanwhile gets today's block-and-alert behaviour. A manual "release" from dispatch is refused while the restaurant is paused, and it changes nothing (an existing block stays).

**Kitchens and customers** cannot read the switch. Customers learn about a pause only through the refusal message.

## A real emergency

There is NO automatic stop of payments already in progress. A customer who already has a checkout can still pay.
- If an order must not be fulfilled, staff use the existing tools: "Cancelar pedido pagado" (`cancelPaidOrder`, which refunds) or the reconciliation resolver.
- A human decides, per the owner's rule.

## Rollback rule

Do NOT roll an enforcing function (createOrder, chargeOnlineOrder, sweepScheduledReleases, releaseScheduledOrder) back to a version without the pause check while any pause is in effect. First resume every paused restaurant, or have the owner explicitly decide to reopen intake and record that decision. An old version simply ignores the switch.

With every switch absent or open, a rollback restores today's behaviour exactly.

## Limits

- **One switch per restaurant.** There is no platform-wide switch and no emergency mode.
- **Raw writes bypass it.** A raw database write by staff is not gated.
- **Writer.** The portal button is a later slice; until then this CLI is the only writer.
