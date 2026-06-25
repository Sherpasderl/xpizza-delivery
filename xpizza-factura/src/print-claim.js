'use strict';

/**
 * Pure decision for the print agent's transactional claim on a factura record (ADR-0004 /
 * plan §7). Prevents double-printing from duplicate listeners, multiple agents, or restart
 * re-firing child_added. The agent runs this inside a transaction on the factura node and
 * only sends bytes if action === 'claim'.
 */

function decidePrintClaim(record, { owner, now, ttlMs }) {
  if (record == null) return { action: 'skip', reason: 'absent' };
  if (record.printed) return { action: 'skip', reason: 'already_printed' };
  if (record.void) return { action: 'skip', reason: 'void' };

  const claim = record.print_claim;
  const liveByOther = claim && claim.owner !== owner && claim.expires_at > now;
  if (liveByOther) return { action: 'skip', reason: 'claimed_by_other' };

  return {
    action: 'claim',
    nextClaim: { owner, claimed_at: now, expires_at: now + ttlMs },
  };
}

module.exports = { decidePrintClaim };
