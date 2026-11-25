// Reconciliation report: compares what was REQUESTED (orders) with what was
// actually RECEIVED on-chain (payments) for a period, per network, and lists
// every exception a human should look at. Pure function, easy to test.

import { formatAmount } from '../core/money.js';
import type { Network, Order, OrderStatus, Payment } from '../core/types.js';

export interface NetworkReconciliation {
  network: Network;
  ordersCreated: number;
  ordersByStatus: Partial<Record<OrderStatus, number>>;
  /** Sum of payable amounts of orders that were not expired/cancelled. */
  requestedTotal: string;
  /** Sum of matched payments for orders that ended up confirmed. */
  confirmedReceivedTotal: string;
  /** Every valid USDT deposit seen on-chain in the period (matched or not). */
  depositsCount: number;
  depositsTotal: string;
  unmatchedCount: number;
  unmatchedTotal: string;
  wrongTokenCount: number;
  orphanedCount: number;
}

export interface ReconciliationException {
  kind: 'underpaid' | 'overpaid' | 'late_payment' | 'manually_resolved' | 'unmatched_payment' | 'wrong_token';
  network: Network;
  orderId: string | null;
  paymentId: number | null;
  detail: string;
}

export interface ReconciliationReport {
  from: string;
  to: string;
  generatedAt: string;
  networks: NetworkReconciliation[];
  exceptions: ReconciliationException[];
}

export function buildReconciliationReport(
  from: Date,
  to: Date,
  orders: readonly Order[], //           orders CREATED in the period
  ordersPayments: ReadonlyMap<string, readonly Payment[]>, // payments of those orders
  periodPayments: readonly Payment[], // payments MINED in the period
  now: Date,
): ReconciliationReport {
  const networks = new Set<Network>([...orders.map((o) => o.network), ...periodPayments.map((p) => p.network)]);
  const exceptions: ReconciliationException[] = [];
  const result: NetworkReconciliation[] = [];

  for (const network of [...networks].sort()) {
    const netOrders = orders.filter((o) => o.network === network);
    const netPayments = periodPayments.filter((p) => p.network === network);
    const byStatus: Partial<Record<OrderStatus, number>> = {};
    let requested = 0n;
    let confirmedReceived = 0n;

    for (const order of netOrders) {
      byStatus[order.status] = (byStatus[order.status] ?? 0) + 1;
      if (order.status !== 'expired' && order.status !== 'cancelled') requested += order.payableAmount;
      const paid = (ordersPayments.get(order.id) ?? [])
        .filter((p) => p.status === 'matched')
        .reduce((s, p) => s + p.amount, 0n);
      if (order.status === 'confirmed') confirmedReceived += paid;

      if (order.status === 'underpaid' || order.status === 'overpaid' || order.status === 'late_payment') {
        exceptions.push({
          kind: order.status,
          network,
          orderId: order.id,
          paymentId: null,
          detail: `requested ${formatAmount(order.payableAmount)}, received ${formatAmount(paid)}`,
        });
      } else if (order.manuallyResolved) {
        exceptions.push({
          kind: 'manually_resolved',
          network,
          orderId: order.id,
          paymentId: null,
          detail: `${order.status} by admin; requested ${formatAmount(order.payableAmount)}, received ${formatAmount(paid)}`,
        });
      }
    }

    const valid = netPayments.filter((p) => p.status === 'matched' || p.status === 'unmatched' || p.status === 'dismissed');
    const unmatched = netPayments.filter((p) => p.status === 'unmatched');
    for (const p of unmatched) {
      exceptions.push({ kind: 'unmatched_payment', network, orderId: null, paymentId: p.id, detail: `${formatAmount(p.amount)} USDT, tx ${p.txHash}` });
    }
    const wrongToken = netPayments.filter((p) => p.status === 'wrong_token');
    for (const p of wrongToken) {
      exceptions.push({ kind: 'wrong_token', network, orderId: null, paymentId: p.id, detail: `token ${p.tokenContract}, tx ${p.txHash}` });
    }

    result.push({
      network,
      ordersCreated: netOrders.length,
      ordersByStatus: byStatus,
      requestedTotal: formatAmount(requested),
      confirmedReceivedTotal: formatAmount(confirmedReceived),
      depositsCount: valid.length,
      depositsTotal: formatAmount(valid.reduce((s, p) => s + p.amount, 0n)),
      unmatchedCount: unmatched.length,
      unmatchedTotal: formatAmount(unmatched.reduce((s, p) => s + p.amount, 0n)),
      wrongTokenCount: wrongToken.length,
      orphanedCount: netPayments.filter((p) => p.status === 'orphaned').length,
    });
  }

  return { from: from.toISOString(), to: to.toISOString(), generatedAt: now.toISOString(), networks: result, exceptions };
}

/** Period helpers (UTC). "day" = the given UTC day; "week" = 7 days ending at the end of that day. */
export function periodRange(kind: 'day' | 'week', date: Date): { from: Date; to: Date } {
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  const days = kind === 'day' ? 1 : 7;
  return { from: new Date(end.getTime() - days * 86_400_000), to: end };
}
