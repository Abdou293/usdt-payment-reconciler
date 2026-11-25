// Unique payable amounts.
// Several orders can share one receiving address. To tell their payments
// apart, each open order gets a tiny unique "suffix" added to its amount,
// e.g. 50 USDT -> 50.000137 USDT. A deposit of exactly 50.000137 can then
// belong to only one order.

import { randomInt } from 'node:crypto';

/** Largest suffix in base units. 9_999 units = 0.009999 USDT. */
export const MAX_SUFFIX_UNITS = 9_999;

export type RandomIntFn = (minInclusive: number, maxExclusive: number) => number;

/**
 * Pick a payable amount = base + suffix that is not already reserved.
 * `reserved` holds payable amounts of other orders on the same
 * network + token + address that could still receive a payment.
 */
export function pickUniquePayableAmount(
  baseAmount: bigint,
  reserved: ReadonlySet<bigint>,
  random: RandomIntFn = randomInt,
  maxSuffix: number = MAX_SUFFIX_UNITS,
): bigint {
  if (baseAmount <= 0n) throw new Error('Base amount must be positive');

  // Fast path: a few random tries (unpredictable suffixes).
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = baseAmount + BigInt(random(1, maxSuffix + 1));
    if (!reserved.has(candidate)) return candidate;
  }
  // Slow path: scan every suffix so we never fail while a slot is free.
  for (let suffix = 1; suffix <= maxSuffix; suffix++) {
    const candidate = baseAmount + BigInt(suffix);
    if (!reserved.has(candidate)) return candidate;
  }
  throw new Error('No unique amount available for this address; add more receiving addresses');
}
