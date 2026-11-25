// The heart of the system: turns on-chain transfers into order status changes.
// Every method is IDEMPOTENT (safe to run twice with the same input) and every
// status change is validated by the state machine and written to the audit log.

import { matchDeposit, sameAddress } from '../core/matcher.js';
import { formatAmount } from '../core/money.js';
import { canTransition, assertTransition, REVIEW_STATUSES } from '../core/stateMachine.js';
import { deriveOrderStatus } from '../core/status.js';
import type { Network, Order, OrderStatus, Payment, PaymentStatus, TransferEvent } from '../core/types.js';
import type { Store } from '../db/Store.js';
import type { Clock, ServiceConfig } from './config.js';

export interface OrderStatusChange {
  order: Order;
  from: OrderStatus;
  to: OrderStatus;
  actor: string;
}

export interface ReviewAlert {
  kind: 'unmatched_payment' | 'wrong_token' | 'order_needs_review' | 'reorg_after_final';
  message: string;
  orderId: string | null;
  paymentId: number | null;
}

export type IngestOutcome = 'stored' | 'duplicate' | 'reincluded' | 'block_changed';

export interface IngestResult {
  outcome: IngestOutcome;
  paymentId: number;
  paymentStatus: PaymentStatus;
  orderId: string | null;
}

type Listener<T> = (event: T) => void | Promise<void>;

export class PaymentProcessor {
  private readonly statusListeners: Listener<OrderStatusChange>[] = [];
  private readonly reviewListeners: Listener<ReviewAlert>[] = [];
  /** Events are buffered during a transaction and emitted only after it commits. */
  private outbox: Array<() => Promise<void>> = [];

  constructor(
    private readonly store: Store,
    private readonly config: ServiceConfig,
    private readonly now: Clock = () => new Date(),
  ) {}

  onStatusChange(listener: Listener<OrderStatusChange>): void {
    this.statusListeners.push(listener);
  }

  onReviewAlert(listener: Listener<ReviewAlert>): void {
    this.reviewListeners.push(listener);
  }

  // ------------------------------------------------------------------
  // Incoming transfers
  // ------------------------------------------------------------------

  async ingestTransfer(event: TransferEvent): Promise<IngestResult> {
    return this.inTransaction(async () => {
      const existing = await this.store.getPaymentByKey(event.network, event.txHash, event.logIndex);
      if (existing) return this.handleKnownTransfer(existing, event);
      return this.storeNewTransfer(event);
    });
  }

  private async storeNewTransfer(event: TransferEvent): Promise<IngestResult> {
    const network = this.networkSettings(event.network);
    const now = this.now();
    let status: PaymentStatus;
    let orderId: string | null = null;
    let note: string | null = null;

    if (!sameAddress(event.tokenContract, network.usdtContract)) {
      status = 'wrong_token';
      note = `Token contract ${event.tokenContract} is not the configured USDT contract`;
    } else {
      const decision = await this.match(event);
      status = decision.status;
      orderId = decision.orderId;
      note = decision.note;
    }

    const paymentId = await this.store.insertPayment({
      network: event.network,
      txHash: event.txHash,
      logIndex: event.logIndex,
      tokenContract: event.tokenContract,
      fromAddress: event.fromAddress,
      toAddress: event.toAddress,
      amount: event.amount,
      blockNumber: event.blockNumber,
      blockTimestamp: event.blockTimestamp,
      status,
      orderId,
      note,
      firstSeenAt: now,
    });
    await this.audit('payment', String(paymentId), 'payment_detected', null, status, 'system', {
      txHash: event.txHash,
      logIndex: event.logIndex,
      amount: formatAmount(event.amount),
      orderId,
      note,
    });

    if (status === 'unmatched' || status === 'wrong_token') {
      await this.queueReview({
        kind: status === 'wrong_token' ? 'wrong_token' : 'unmatched_payment',
        message: `${formatAmount(event.amount)} received on ${event.network} (${event.txHash}): ${note ?? status}`,
        orderId: null,
        paymentId,
      });
    }
    if (orderId) await this.recompute(orderId);
    return { outcome: 'stored', paymentId, paymentStatus: status, orderId };
  }

  /** The same transfer seen again (duplicate poll, rescan, or after a reorg). */
  private async handleKnownTransfer(existing: Payment, event: TransferEvent): Promise<IngestResult> {
    if (existing.status === 'orphaned') {
      // It was removed by a reorg and has now been mined again.
      const decision = existing.orderId
        ? { status: 'matched' as const, orderId: existing.orderId, note: existing.note }
        : await this.match(event);
      await this.store.updatePayment(existing.id, {
        status: decision.status,
        orderId: decision.orderId,
        note: decision.note,
        blockNumber: event.blockNumber,
        blockTimestamp: event.blockTimestamp,
      });
      await this.audit('payment', String(existing.id), 'payment_reincluded', 'orphaned', decision.status, 'system', {
        blockNumber: event.blockNumber,
      });
      if (decision.orderId) await this.recompute(decision.orderId);
      return { outcome: 'reincluded', paymentId: existing.id, paymentStatus: decision.status, orderId: decision.orderId };
    }

    if (existing.blockNumber !== event.blockNumber) {
      // A reorg moved the transfer into a different block: confirmations restart.
      await this.store.updatePayment(existing.id, {
        blockNumber: event.blockNumber,
        blockTimestamp: event.blockTimestamp,
      });
      await this.audit('payment', String(existing.id), 'payment_block_changed', existing.status, existing.status, 'system', {
        oldBlock: existing.blockNumber,
        newBlock: event.blockNumber,
      });
      if (existing.orderId) await this.recompute(existing.orderId);
      return { outcome: 'block_changed', paymentId: existing.id, paymentStatus: existing.status, orderId: existing.orderId };
    }

    // Exact duplicate: nothing to do. No write, no audit, no notification.
    return { outcome: 'duplicate', paymentId: existing.id, paymentStatus: existing.status, orderId: existing.orderId };
  }

  private async match(event: TransferEvent): Promise<{ status: PaymentStatus; orderId: string | null; note: string | null }> {
    const reservedSince = new Date(this.now().getTime() - this.config.payment.lateReservationMinutes * 60_000);
    const candidates = await this.store.listMatchCandidates(event.network, 'USDT', event.toAddress, reservedSince);
    const result = matchDeposit(event, candidates);
    if (result.matched) {
      return { status: 'matched', orderId: result.orderId, note: `matched_by:${result.reason}` };
    }
    // Was this amount meant for an order on a different network?
    const elsewhere = await this.store.listOrdersByPayableOnOtherNetworks(event.amount, event.network);
    const note =
      elsewhere.length > 0
        ? `possible_wrong_network: amount matches order ${elsewhere.map((o) => `${o.id} (${o.network})`).join(', ')}`
        : `unmatched:${result.reason}`;
    return { status: 'unmatched', orderId: null, note };
  }

  // ------------------------------------------------------------------
  // Confirmations, reorgs, expiry
  // ------------------------------------------------------------------

  /** Re-evaluate in-flight orders after the chain head moved. */
  async refreshConfirmations(network: Network): Promise<void> {
    await this.inTransaction(async () => {
      const orders = await this.store.listOrdersByStatus(['detected', 'confirming', 'underpaid']);
      for (const order of orders.filter((o) => o.network === network)) {
        await this.recompute(order.id);
      }
    });
  }

  /** A reorg removed this transfer from the canonical chain. */
  async markOrphaned(network: Network, txHash: string, logIndex: number): Promise<void> {
    await this.inTransaction(async () => {
      const payment = await this.store.getPaymentByKey(network, txHash, logIndex);
      if (!payment || payment.status === 'orphaned') return; // idempotent
      await this.store.updatePayment(payment.id, { status: 'orphaned' });
      await this.audit('payment', String(payment.id), 'payment_orphaned_by_reorg', payment.status, 'orphaned', 'system', {
        txHash,
        logIndex,
        orderId: payment.orderId,
      });
      if (!payment.orderId) return;
      const order = await this.store.getOrder(payment.orderId);
      if (order && ['confirmed', 'overpaid', 'late_payment'].includes(order.status)) {
        // Should not happen once N confirmations are reached, but if it does a human must look.
        await this.audit('order', order.id, 'reorg_after_final', order.status, order.status, 'system', { paymentId: payment.id });
        await this.queueReview({
          kind: 'reorg_after_final',
          message: `CRITICAL: payment ${txHash} for ${order.status} order ${order.id} was removed by a chain reorganization`,
          orderId: order.id,
          paymentId: payment.id,
        });
        return;
      }
      await this.recompute(payment.orderId);
    });
  }

  /** Expire pending orders whose time ran out. Safe to run on every poll. */
  async expireOrders(): Promise<number> {
    return this.inTransaction(async () => {
      const due = await this.store.listPendingExpiredBefore(this.now());
      for (const order of due) await this.recompute(order.id);
      return due.length;
    });
  }

  // ------------------------------------------------------------------
  // Manual review (admin actions)
  // ------------------------------------------------------------------

  /** Admin accepts an underpaid / overpaid / late order as paid. */
  async acceptOrderManually(orderId: string, admin: string, reason: string): Promise<void> {
    if (!reason.trim()) throw new Error('A reason is required for manual resolution');
    await this.inTransaction(async () => {
      const order = await this.requireOrder(orderId);
      // Only orders in the review queue can be accepted by hand. (The state machine
      // also allows expired -> confirmed, but only for the system when an in-time
      // payment is found; an admin must never confirm an order that has no payment.)
      if (!REVIEW_STATUSES.includes(order.status)) {
        throw new Error(`Illegal manual accept: order ${order.id} is ${order.status}, not in review`);
      }
      assertTransition(order.status, 'confirmed', 'admin');
      await this.store.updateOrderStatus(order.id, 'confirmed', true);
      await this.audit('order', order.id, 'manual_accept', order.status, 'confirmed', `admin:${admin}`, { reason });
      await this.queueStatusChange({ ...order, status: 'confirmed', manuallyResolved: true }, order.status, 'confirmed', `admin:${admin}`);
    });
  }

  /** Admin links an unmatched payment to an order (e.g. a top-up for an underpaid order). */
  async assignPaymentManually(paymentId: number, orderId: string, admin: string, reason: string): Promise<void> {
    if (!reason.trim()) throw new Error('A reason is required for manual assignment');
    await this.inTransaction(async () => {
      const payment = await this.store.getPayment(paymentId);
      if (!payment) throw new Error(`Payment ${paymentId} not found`);
      if (payment.status !== 'unmatched') throw new Error(`Only unmatched payments can be assigned (is ${payment.status})`);
      const order = await this.requireOrder(orderId);
      if (order.network !== payment.network || !sameAddress(order.receivingAddress, payment.toAddress)) {
        throw new Error('Payment was not sent to this order\'s network and address');
      }
      await this.store.updatePayment(payment.id, { status: 'matched', orderId, note: `assigned_by:admin:${admin}` });
      await this.audit('payment', String(payment.id), 'manual_assign', 'unmatched', 'matched', `admin:${admin}`, { orderId, reason });
      await this.recompute(orderId);
    });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Bring one order's stored status in line with its payments. */
  private async recompute(orderId: string): Promise<void> {
    const order = await this.requireOrder(orderId);
    const network = this.networkSettings(order.network);
    const chain = await this.store.getChainState(order.network);
    const payments = (await this.store.listPaymentsForOrder(orderId)).filter((p) => p.status === 'matched');
    const views = payments.map((p) => ({
      amount: p.amount,
      blockTimestamp: p.blockTimestamp,
      confirmations: chain.latestBlock === null ? 0 : Math.max(0, chain.latestBlock - p.blockNumber + 1),
    }));
    const target = deriveOrderStatus(order, views, this.now(), network.requiredConfirmations, this.config.payment);
    if (target === order.status) return;

    if (!canTransition(order.status, target, 'system')) {
      await this.audit('order', order.id, 'transition_blocked', order.status, target, 'system', null);
      return;
    }
    await this.store.updateOrderStatus(order.id, target);
    await this.audit('order', order.id, 'status_changed', order.status, target, 'system', {
      paidTotal: formatAmount(views.reduce((s, v) => s + v.amount, 0n)),
      payable: formatAmount(order.payableAmount),
    });
    await this.queueStatusChange({ ...order, status: target }, order.status, target, 'system');
    if (REVIEW_STATUSES.includes(target)) {
      await this.queueReview({
        kind: 'order_needs_review',
        message: `Order ${order.id} is ${target} and needs manual review`,
        orderId: order.id,
        paymentId: null,
      });
    }
  }

  private async requireOrder(orderId: string): Promise<Order> {
    const order = await this.store.getOrder(orderId);
    if (!order) throw new Error(`Order ${orderId} not found`);
    return order;
  }

  private networkSettings(network: Network) {
    const settings = this.config.networks.get(network);
    if (!settings) throw new Error(`Network ${network} is not configured`);
    return settings;
  }

  private async audit(
    entityType: 'order' | 'payment',
    entityId: string,
    action: string,
    fromStatus: string | null,
    toStatus: string | null,
    actor: string,
    details: Record<string, unknown> | null,
  ): Promise<void> {
    await this.store.addAudit({ entityType, entityId, action, fromStatus, toStatus, actor, details, createdAt: this.now() });
  }

  /**
   * Record the change as a durable event (same DB transaction as the status
   * change) for the notification dispatcher, and queue in-process listeners.
   */
  private async queueStatusChange(order: Order, from: OrderStatus, to: OrderStatus, actor: string): Promise<void> {
    const payments = (await this.store.listPaymentsForOrder(order.id)).filter((p) => p.status === 'matched');
    await this.store.addEvent(
      'order_status_changed',
      {
        orderId: order.id,
        from,
        to,
        actor,
        network: order.network,
        externalRef: order.externalRef,
        receivingAddress: order.receivingAddress,
        baseAmount: formatAmount(order.baseAmount),
        payableAmount: formatAmount(order.payableAmount),
        paidTotal: formatAmount(payments.reduce((s, p) => s + p.amount, 0n)),
        txHashes: payments.map((p) => p.txHash),
        expiresAt: order.expiresAt.toISOString(),
        payerTelegramChatId: order.payerTelegramChatId,
        manuallyResolved: order.manuallyResolved,
      },
      this.now(),
    );
    const event: OrderStatusChange = { order, from, to, actor };
    this.outbox.push(async () => {
      for (const listener of this.statusListeners) await listener(event);
    });
  }

  private async queueReview(alert: ReviewAlert): Promise<void> {
    await this.store.addEvent('review_alert', { ...alert }, this.now());
    this.outbox.push(async () => {
      for (const listener of this.reviewListeners) await listener(alert);
    });
  }

  /** Run inside a DB transaction, then emit buffered events only if it committed. */
  private async inTransaction<T>(fn: () => Promise<T>): Promise<T> {
    // The store runs one transaction at a time, so the outbox is exclusive inside `fn`.
    const { result, pending } = await this.store.transaction(async () => {
      this.outbox = [];
      try {
        const value = await fn();
        return { result: value, pending: this.outbox };
      } finally {
        this.outbox = [];
      }
    });
    for (const emit of pending) {
      try {
        await emit();
      } catch (error) {
        // A failing notification must never undo or block payment processing.
        console.error('Event listener failed:', error);
      }
    }
    return result;
  }
}
