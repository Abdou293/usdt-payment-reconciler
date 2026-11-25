// Derive what an order's status SHOULD be from its payments and the chain.
// Pure function. The processor compares the result with the stored status,
// validates the transition with the state machine, and writes an audit entry.

import type { Order, OrderStatus, PaymentSettings } from './types.js';

export interface PaymentView {
  amount: bigint;
  blockTimestamp: Date;
  confirmations: number;
}

/** Statuses the automatic system never leaves on its own. */
const SYSTEM_TERMINAL: readonly OrderStatus[] = ['confirmed', 'overpaid', 'late_payment'];

export function deriveOrderStatus(
  order: Order,
  activePayments: readonly PaymentView[],
  now: Date,
  requiredConfirmations: number,
  settings: PaymentSettings,
): OrderStatus {
  if (SYSTEM_TERMINAL.includes(order.status)) return order.status;

  if (activePayments.length === 0) {
    return now.getTime() >= order.expiresAt.getTime() ? 'expired' : 'pending';
  }

  // Only payments made on-chain before the expiry time count as "in time".
  const inTime = activePayments.filter((p) => p.blockTimestamp.getTime() <= order.expiresAt.getTime());
  if (inTime.length === 0) return 'late_payment';

  if (inTime.some((p) => p.confirmations <= 0)) return 'detected';
  if (inTime.some((p) => p.confirmations < requiredConfirmations)) return 'confirming';

  const total = inTime.reduce((sum, p) => sum + p.amount, 0n);
  if (total < order.payableAmount - settings.underpayToleranceUnits) return 'underpaid';
  if (total > order.payableAmount + settings.overpayToleranceUnits) return 'overpaid';
  return 'confirmed';
}
