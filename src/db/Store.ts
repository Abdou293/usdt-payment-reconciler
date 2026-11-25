// Data-access interface. Business logic talks ONLY to this interface,
// so the SQLite implementation can later be swapped for PostgreSQL.
// Methods are async so a network database fits the same shape.

import type { Network, Order, OrderStatus, Payment, PaymentStatus, Token } from '../core/types.js';

export interface NewPayment extends Omit<Payment, 'id'> {}

export interface ChainState {
  network: Network;
  /** Last block fully scanned for transfers (the resume point after restart). */
  cursorBlock: number | null;
  /** Latest block number the chain reported. Used for confirmation counts. */
  latestBlock: number | null;
  lastPollAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

export interface AuditEntry {
  id?: number;
  entityType: 'order' | 'payment' | 'chain';
  entityId: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export interface Store {
  /** Run `fn` atomically: all writes succeed together or none do. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;

  // Orders
  insertOrder(order: Order): Promise<void>;
  getOrder(id: string): Promise<Order | null>;
  updateOrderStatus(id: string, status: OrderStatus, manuallyResolved?: boolean): Promise<void>;
  /** Orders that may still receive a payment on this destination. */
  listMatchCandidates(network: Network, token: Token, address: string, reservedSince: Date): Promise<Order[]>;
  /** Orders on OTHER networks with this exact payable amount (wrong-network hint). */
  listOrdersByPayableOnOtherNetworks(amount: bigint, network: Network): Promise<Order[]>;
  listOrdersByStatus(statuses: readonly OrderStatus[]): Promise<Order[]>;
  listPendingExpiredBefore(now: Date): Promise<Order[]>;
  countOpenOrdersByAddress(network: Network): Promise<Map<string, number>>;

  // Payments
  getPaymentByKey(network: Network, txHash: string, logIndex: number): Promise<Payment | null>;
  getPayment(id: number): Promise<Payment | null>;
  insertPayment(payment: NewPayment): Promise<number>;
  updatePayment(id: number, fields: Partial<Pick<Payment, 'status' | 'orderId' | 'note' | 'blockNumber' | 'blockTimestamp'>>): Promise<void>;
  listPaymentsForOrder(orderId: string): Promise<Payment[]>;
  listPaymentsByStatus(statuses: readonly PaymentStatus[]): Promise<Payment[]>;
  /** Matched payments on a network whose block is at or above `minBlock`. */
  listRecentMatchedPayments(network: Network, minBlock: number): Promise<Payment[]>;

  // Chain watcher state
  getChainState(network: Network): Promise<ChainState>;
  saveChainState(state: ChainState): Promise<void>;

  // Audit
  addAudit(entry: Omit<AuditEntry, 'id'>): Promise<void>;
  listAudit(entityType: AuditEntry['entityType'], entityId: string): Promise<AuditEntry[]>;

  close(): void;
}
