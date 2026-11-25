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
  entityType: 'order' | 'payment' | 'chain' | 'admin';
  entityId: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  actor: string;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

export type EventType = 'order_status_changed' | 'review_alert';

export interface DomainEvent {
  id: number;
  type: EventType;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type DeliveryChannel = 'telegram' | 'webhook';
export type DeliveryStatus = 'pending' | 'sent' | 'failed';

export interface Delivery {
  id: number;
  eventId: number;
  channel: DeliveryChannel;
  target: string; //      Telegram chat id, or "merchant" for the webhook
  dedupeKey: string;
  body: string; //        message text, or the exact JSON webhook body
  status: DeliveryStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

export type NewDelivery = Pick<Delivery, 'eventId' | 'channel' | 'target' | 'dedupeKey' | 'body' | 'nextAttemptAt' | 'createdAt'>;

export interface OrderFilter {
  statuses?: readonly OrderStatus[] | undefined;
  network?: Network | undefined;
  /** Matches order id, merchant reference, receiving address or a payment tx hash. */
  search?: string | undefined;
  createdFrom?: Date | undefined;
  createdTo?: Date | undefined;
  limit: number;
  offset: number;
}

export interface AdminUser {
  username: string;
  passwordHash: string;
}

export interface SessionRecord {
  idHash: string;
  username: string;
  csrfToken: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface PasswordResetRecord {
  id: number;
  username: string;
  codeHash: string;
  attempts: number;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
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

  /** Link a payer's Telegram chat to an order. Only succeeds if no chat is linked yet. */
  setPayerChatId(orderId: string, chatId: string): Promise<boolean>;
  listRecentOrders(limit: number): Promise<Order[]>;

  // Outbox: events and deliveries (notifications, webhooks)
  addEvent(type: EventType, payload: Record<string, unknown>, createdAt: Date): Promise<number>;
  listEventsAfter(afterId: number, limit: number): Promise<DomainEvent[]>;
  getKv(key: string): Promise<string | null>;
  setKv(key: string, value: string): Promise<void>;
  /** Returns false if a delivery with the same dedupe key already exists. */
  insertDeliveryIfNew(delivery: NewDelivery): Promise<boolean>;
  listDueDeliveries(now: Date, limit: number): Promise<Delivery[]>;
  markDeliverySent(id: number, attempts: number, at: Date): Promise<void>;
  markDeliveryRetry(id: number, attempts: number, nextAttemptAt: Date, error: string): Promise<void>;
  markDeliveryFailed(id: number, attempts: number, error: string): Promise<void>;
  listDeliveries(statuses: readonly DeliveryStatus[], limit: number): Promise<Delivery[]>;

  countDeliveriesByStatus(): Promise<Record<DeliveryStatus, number>>;

  // Dashboard queries and reports
  listOrders(filter: OrderFilter): Promise<{ items: Order[]; total: number }>;
  listOrdersCreatedBetween(from: Date, to: Date): Promise<Order[]>;
  /** Payments by on-chain block time. */
  listPaymentsBetween(from: Date, to: Date): Promise<Payment[]>;

  // Admin accounts and sessions
  getAdminUser(username: string): Promise<AdminUser | null>;
  createAdminUser(username: string, passwordHash: string, at: Date): Promise<void>;
  countAdminUsers(): Promise<number>;
  createSession(session: SessionRecord): Promise<void>;
  getSession(idHash: string): Promise<SessionRecord | null>;
  deleteSession(idHash: string): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<void>;
  updateAdminPassword(username: string, passwordHash: string): Promise<void>;
  /** Log a user out everywhere, optionally keeping one session (the current one). */
  deleteSessionsForUser(username: string, exceptIdHash?: string): Promise<void>;

  // Password reset codes (only hashes are stored)
  createPasswordReset(r: Omit<PasswordResetRecord, 'id' | 'attempts' | 'usedAt'>): Promise<void>;
  /** The newest unused, unexpired reset for this user, if any. */
  getActivePasswordReset(username: string, now: Date): Promise<PasswordResetRecord | null>;
  countRecentPasswordResets(username: string, since: Date): Promise<number>;
  incrementPasswordResetAttempts(id: number): Promise<void>;
  /** Mark every open reset of this user as used (after success, or when a new one is issued). */
  closePasswordResets(username: string, at: Date): Promise<void>;

  // Small key/value settings
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;

  // Audit
  addAudit(entry: Omit<AuditEntry, 'id'>): Promise<void>;
  listAudit(entityType: AuditEntry['entityType'], entityId: string): Promise<AuditEntry[]>;

  close(): void;
}
