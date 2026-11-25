// Matching: decide which order (if any) an incoming deposit belongs to.
// Pure function: no database, no network, easy to test.

import { OPEN_STATUSES } from './stateMachine.js';
import type { Order, TransferEvent } from './types.js';

export type MatchReason =
  | 'exact_amount' //       deposit equals the order's unique payable amount
  | 'base_amount' //        payer sent the base amount without the unique suffix
  | 'only_open_order'; //   wrong amount, but only one open order uses this address

export type MatchResult =
  | { matched: true; orderId: string; reason: MatchReason }
  | { matched: false; reason: 'no_candidate' | 'ambiguous' };

/**
 * @param candidates orders on the SAME network, token and receiving address
 *   that may still receive a payment (open, underpaid, or recently expired).
 */
export function matchDeposit(deposit: TransferEvent, candidates: readonly Order[]): MatchResult {
  const sameDestination = candidates.filter(
    (o) => o.network === deposit.network && sameAddress(o.receivingAddress, deposit.toAddress),
  );

  // 1) Exact unique amount. Includes recently expired orders (late payments).
  const exact = sameDestination.filter((o) => o.payableAmount === deposit.amount);
  if (exact.length === 1) return { matched: true, orderId: exact[0]!.id, reason: 'exact_amount' };
  if (exact.length > 1) return { matched: false, reason: 'ambiguous' };

  const open = sameDestination.filter((o) => OPEN_STATUSES.includes(o.status));

  // 2) Payer dropped the unique suffix and sent the round base amount.
  const byBase = open.filter((o) => o.baseAmount === deposit.amount);
  if (byBase.length === 1) return { matched: true, orderId: byBase[0]!.id, reason: 'base_amount' };
  if (byBase.length > 1) return { matched: false, reason: 'ambiguous' };

  // 3) Wrong amount, but there is exactly one open order on this address.
  if (open.length === 1) return { matched: true, orderId: open[0]!.id, reason: 'only_open_order' };

  return { matched: false, reason: open.length > 1 ? 'ambiguous' : 'no_candidate' };
}

/** TRON addresses are case-sensitive base58; EVM hex addresses are not. */
export function sameAddress(a: string, b: string): boolean {
  if (a.startsWith('0x') && b.startsWith('0x')) return a.toLowerCase() === b.toLowerCase();
  return a === b;
}
