// Order lifecycle state machine.
// Every status change must go through `assertTransition`, so an illegal jump
// (for example "expired" -> "confirmed" without a human) is impossible.

import type { OrderStatus } from './types.js';

const ALLOWED: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['detected', 'confirming', 'confirmed', 'underpaid', 'overpaid', 'expired', 'late_payment'],
  detected: ['confirming', 'confirmed', 'underpaid', 'overpaid', 'pending', 'expired', 'late_payment'],
  confirming: ['detected', 'confirmed', 'underpaid', 'overpaid', 'pending', 'expired', 'late_payment'],
  // A top-up payment assigned by an admin can complete an underpaid order.
  underpaid: ['confirming', 'detected', 'confirmed', 'overpaid'],
  overpaid: [],
  // If the server was asleep, an order can be marked expired before we see a
  // payment that was actually made IN TIME (block timestamp <= expiresAt).
  // The status derivation only takes these paths when that is true.
  expired: ['detected', 'confirming', 'confirmed', 'underpaid', 'overpaid', 'late_payment'],
  late_payment: [],
  confirmed: [],
  cancelled: [],
};

/** Transitions only a human admin may perform (manual review queue). */
const MANUAL_ONLY: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['cancelled'],
  detected: [],
  confirming: [],
  underpaid: ['confirmed', 'cancelled'],
  overpaid: ['confirmed', 'cancelled'],
  late_payment: ['confirmed', 'cancelled'],
  expired: [],
  confirmed: [],
  cancelled: [],
};

export type Actor = 'system' | 'admin';

export function canTransition(from: OrderStatus, to: OrderStatus, actor: Actor = 'system'): boolean {
  if (ALLOWED[from].includes(to)) return true;
  return actor === 'admin' && MANUAL_ONLY[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus, actor: Actor = 'system'): void {
  if (!canTransition(from, to, actor)) {
    throw new Error(`Illegal order transition ${from} -> ${to} by ${actor}`);
  }
}

export const FINAL_STATUSES: readonly OrderStatus[] = ['confirmed', 'cancelled'];
export const REVIEW_STATUSES: readonly OrderStatus[] = ['underpaid', 'overpaid', 'late_payment'];
export const OPEN_STATUSES: readonly OrderStatus[] = ['pending', 'detected', 'confirming'];
