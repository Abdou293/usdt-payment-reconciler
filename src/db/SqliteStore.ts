// SQLite implementation of Store, using Node's built-in `node:sqlite`
// (no native add-on to compile). All queries use bound parameters,
// never string concatenation, to prevent SQL injection.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { unitsFromDb } from '../core/money.js';
import type { Network, Order, OrderStatus, Payment, PaymentStatus, Token } from '../core/types.js';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';
import type {
  AuditEntry,
  ChainState,
  Delivery,
  DeliveryChannel,
  DeliveryStatus,
  DomainEvent,
  EventType,
  NewDelivery,
  NewPayment,
  Store,
} from './Store.js';

type Row = Record<string, SQLInputValue>;

export class SqliteStore implements Store {
  private readonly db: DatabaseSync;
  private txQueue: Promise<unknown> = Promise.resolve();

  /** @param path file path, or ":memory:" for tests */
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA_SQL);
    this.db
      .prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)')
      .run('schema_version', String(SCHEMA_VERSION));
  }

  /** Transactions are queued so two async callers never interleave inside one. */
  transaction<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn();
        this.db.exec('COMMIT');
        return result;
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    };
    const next = this.txQueue.then(run, run);
    this.txQueue = next.catch(() => undefined);
    return next;
  }

  // ---------- Orders ----------

  async insertOrder(o: Order): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO orders (id, external_ref, network, token, receiving_address, base_amount,
           payable_amount, status, created_at, expires_at, payer_telegram_chat_id, manually_resolved)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.id, o.externalRef, o.network, o.token, o.receivingAddress, o.baseAmount.toString(),
        o.payableAmount.toString(), o.status, o.createdAt.toISOString(), o.expiresAt.toISOString(),
        o.payerTelegramChatId, o.manuallyResolved ? 1 : 0,
      );
  }

  async getOrder(id: string): Promise<Order | null> {
    const row = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as Row | undefined;
    return row ? toOrder(row) : null;
  }

  async updateOrderStatus(id: string, status: OrderStatus, manuallyResolved?: boolean): Promise<void> {
    if (manuallyResolved === undefined) {
      this.db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, id);
    } else {
      this.db
        .prepare('UPDATE orders SET status = ?, manually_resolved = ? WHERE id = ?')
        .run(status, manuallyResolved ? 1 : 0, id);
    }
  }

  async listMatchCandidates(network: Network, token: Token, address: string, reservedSince: Date): Promise<Order[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM orders
          WHERE network = ? AND token = ? AND lower(receiving_address) = lower(?)
            AND (status IN ('pending', 'detected', 'confirming', 'underpaid')
                 OR (status = 'expired' AND expires_at >= ?))`,
      )
      .all(network, token, address, reservedSince.toISOString()) as Row[];
    // lower() above is a coarse filter; exact (case-sensitive for TRON) check happens in the matcher.
    return rows.map(toOrder);
  }

  async listOrdersByPayableOnOtherNetworks(amount: bigint, network: Network): Promise<Order[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM orders WHERE payable_amount = ? AND network <> ?
           AND status IN ('pending', 'detected', 'confirming', 'expired')`,
      )
      .all(amount.toString(), network) as Row[];
    return rows.map(toOrder);
  }

  async listOrdersByStatus(statuses: readonly OrderStatus[]): Promise<Order[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM orders WHERE status IN (${placeholders}) ORDER BY created_at`)
      .all(...statuses) as Row[];
    return rows.map(toOrder);
  }

  async listPendingExpiredBefore(now: Date): Promise<Order[]> {
    const rows = this.db
      .prepare(`SELECT * FROM orders WHERE status = 'pending' AND expires_at <= ?`)
      .all(now.toISOString()) as Row[];
    return rows.map(toOrder);
  }

  async countOpenOrdersByAddress(network: Network): Promise<Map<string, number>> {
    const rows = this.db
      .prepare(
        `SELECT receiving_address AS address, COUNT(*) AS n FROM orders
          WHERE network = ? AND status IN ('pending', 'detected', 'confirming')
          GROUP BY receiving_address`,
      )
      .all(network) as Row[];
    return new Map(rows.map((r) => [String(r.address), Number(r.n)]));
  }

  // ---------- Payments ----------

  async getPaymentByKey(network: Network, txHash: string, logIndex: number): Promise<Payment | null> {
    const row = this.db
      .prepare('SELECT * FROM payments WHERE network = ? AND tx_hash = ? AND log_index = ?')
      .get(network, txHash, logIndex) as Row | undefined;
    return row ? toPayment(row) : null;
  }

  async getPayment(id: number): Promise<Payment | null> {
    const row = this.db.prepare('SELECT * FROM payments WHERE id = ?').get(id) as Row | undefined;
    return row ? toPayment(row) : null;
  }

  async insertPayment(p: NewPayment): Promise<number> {
    const result = this.db
      .prepare(
        `INSERT INTO payments (network, tx_hash, log_index, token_contract, from_address, to_address,
           amount, block_number, block_timestamp, status, order_id, note, first_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.network, p.txHash, p.logIndex, p.tokenContract, p.fromAddress, p.toAddress,
        p.amount.toString(), p.blockNumber, p.blockTimestamp.toISOString(), p.status,
        p.orderId, p.note, p.firstSeenAt.toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  async updatePayment(
    id: number,
    fields: Partial<Pick<Payment, 'status' | 'orderId' | 'note' | 'blockNumber' | 'blockTimestamp'>>,
  ): Promise<void> {
    const columns: Record<string, SQLInputValue> = {};
    if (fields.status !== undefined) columns.status = fields.status;
    if (fields.orderId !== undefined) columns.order_id = fields.orderId;
    if (fields.note !== undefined) columns.note = fields.note;
    if (fields.blockNumber !== undefined) columns.block_number = fields.blockNumber;
    if (fields.blockTimestamp !== undefined) columns.block_timestamp = fields.blockTimestamp.toISOString();
    const names = Object.keys(columns);
    if (names.length === 0) return;
    // Column names come from the fixed list above, never from user input.
    const setClause = names.map((n) => `${n} = ?`).join(', ');
    this.db.prepare(`UPDATE payments SET ${setClause} WHERE id = ?`).run(...Object.values(columns), id);
  }

  async listPaymentsForOrder(orderId: string): Promise<Payment[]> {
    const rows = this.db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(orderId) as Row[];
    return rows.map(toPayment);
  }

  async listPaymentsByStatus(statuses: readonly PaymentStatus[]): Promise<Payment[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM payments WHERE status IN (${placeholders}) ORDER BY id`)
      .all(...statuses) as Row[];
    return rows.map(toPayment);
  }

  async listRecentMatchedPayments(network: Network, minBlock: number): Promise<Payment[]> {
    const rows = this.db
      .prepare(
        `SELECT * FROM payments WHERE network = ? AND status IN ('matched', 'unmatched') AND block_number >= ?`,
      )
      .all(network, minBlock) as Row[];
    return rows.map(toPayment);
  }

  // ---------- Chain state ----------

  async getChainState(network: Network): Promise<ChainState> {
    const row = this.db.prepare('SELECT * FROM chain_state WHERE network = ?').get(network) as Row | undefined;
    if (!row) {
      return { network, cursorBlock: null, latestBlock: null, lastPollAt: null, lastSuccessAt: null, lastError: null };
    }
    return {
      network,
      cursorBlock: row.cursor_block === null ? null : Number(row.cursor_block),
      latestBlock: row.latest_block === null ? null : Number(row.latest_block),
      lastPollAt: optDate(row.last_poll_at),
      lastSuccessAt: optDate(row.last_success_at),
      lastError: row.last_error === null ? null : String(row.last_error),
    };
  }

  async saveChainState(s: ChainState): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO chain_state (network, cursor_block, latest_block, last_poll_at, last_success_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(network) DO UPDATE SET cursor_block = excluded.cursor_block,
           latest_block = excluded.latest_block, last_poll_at = excluded.last_poll_at,
           last_success_at = excluded.last_success_at, last_error = excluded.last_error`,
      )
      .run(
        s.network, s.cursorBlock, s.latestBlock, s.lastPollAt?.toISOString() ?? null,
        s.lastSuccessAt?.toISOString() ?? null, s.lastError,
      );
  }

  async setPayerChatId(orderId: string, chatId: string): Promise<boolean> {
    const result = this.db
      .prepare('UPDATE orders SET payer_telegram_chat_id = ? WHERE id = ? AND payer_telegram_chat_id IS NULL')
      .run(chatId, orderId);
    return Number(result.changes) === 1;
  }

  async listRecentOrders(limit: number): Promise<Order[]> {
    const rows = this.db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit) as Row[];
    return rows.map(toOrder);
  }

  // ---------- Outbox ----------

  async addEvent(type: EventType, payload: Record<string, unknown>, createdAt: Date): Promise<number> {
    const result = this.db
      .prepare('INSERT INTO events (type, payload, created_at) VALUES (?, ?, ?)')
      .run(type, JSON.stringify(payload), createdAt.toISOString());
    return Number(result.lastInsertRowid);
  }

  async listEventsAfter(afterId: number, limit: number): Promise<DomainEvent[]> {
    const rows = this.db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      type: String(r.type) as EventType,
      payload: JSON.parse(String(r.payload)) as Record<string, unknown>,
      createdAt: new Date(String(r.created_at)),
    }));
  }

  async getKv(key: string): Promise<string | null> {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  async setKv(key: string, value: string): Promise<void> {
    this.db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  async insertDeliveryIfNew(d: NewDelivery): Promise<boolean> {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO deliveries (event_id, channel, target, dedupe_key, body, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(d.eventId, d.channel, d.target, d.dedupeKey, d.body, d.nextAttemptAt.toISOString(), d.createdAt.toISOString());
    return Number(result.changes) === 1;
  }

  async listDueDeliveries(now: Date, limit: number): Promise<Delivery[]> {
    const rows = this.db
      .prepare(`SELECT * FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY id LIMIT ?`)
      .all(now.toISOString(), limit) as Row[];
    return rows.map(toDelivery);
  }

  async markDeliverySent(id: number, attempts: number, at: Date): Promise<void> {
    this.db
      .prepare(`UPDATE deliveries SET status = 'sent', attempts = ?, sent_at = ?, last_error = NULL WHERE id = ?`)
      .run(attempts, at.toISOString(), id);
  }

  async markDeliveryRetry(id: number, attempts: number, nextAttemptAt: Date, error: string): Promise<void> {
    this.db
      .prepare(`UPDATE deliveries SET attempts = ?, next_attempt_at = ?, last_error = ? WHERE id = ?`)
      .run(attempts, nextAttemptAt.toISOString(), error.slice(0, 500), id);
  }

  async markDeliveryFailed(id: number, attempts: number, error: string): Promise<void> {
    this.db
      .prepare(`UPDATE deliveries SET status = 'failed', attempts = ?, last_error = ? WHERE id = ?`)
      .run(attempts, error.slice(0, 500), id);
  }

  async listDeliveries(statuses: readonly DeliveryStatus[], limit: number): Promise<Delivery[]> {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => '?').join(', ');
    const rows = this.db
      .prepare(`SELECT * FROM deliveries WHERE status IN (${placeholders}) ORDER BY id DESC LIMIT ?`)
      .all(...statuses, limit) as Row[];
    return rows.map(toDelivery);
  }

  // ---------- Audit ----------

  async addAudit(e: Omit<AuditEntry, 'id'>): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO audit_log (entity_type, entity_id, action, from_status, to_status, actor, details, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.entityType, e.entityId, e.action, e.fromStatus, e.toStatus, e.actor,
        e.details ? JSON.stringify(e.details) : null, e.createdAt.toISOString(),
      );
  }

  async listAudit(entityType: AuditEntry['entityType'], entityId: string): Promise<AuditEntry[]> {
    const rows = this.db
      .prepare('SELECT * FROM audit_log WHERE entity_type = ? AND entity_id = ? ORDER BY id')
      .all(entityType, entityId) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      entityType: String(r.entity_type) as AuditEntry['entityType'],
      entityId: String(r.entity_id),
      action: String(r.action),
      fromStatus: r.from_status === null ? null : String(r.from_status),
      toStatus: r.to_status === null ? null : String(r.to_status),
      actor: String(r.actor),
      details: r.details === null ? null : (JSON.parse(String(r.details)) as Record<string, unknown>),
      createdAt: new Date(String(r.created_at)),
    }));
  }

  /** Test helper: run raw SQL (used to prove the audit log is append-only). */
  execRaw(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

function optDate(value: SQLInputValue | undefined): Date | null {
  return value === null || value === undefined ? null : new Date(String(value));
}

function toOrder(r: Row): Order {
  return {
    id: String(r.id),
    externalRef: r.external_ref === null ? null : String(r.external_ref),
    network: String(r.network) as Network,
    token: String(r.token) as Token,
    receivingAddress: String(r.receiving_address),
    baseAmount: unitsFromDb(String(r.base_amount)),
    payableAmount: unitsFromDb(String(r.payable_amount)),
    status: String(r.status) as OrderStatus,
    createdAt: new Date(String(r.created_at)),
    expiresAt: new Date(String(r.expires_at)),
    payerTelegramChatId: r.payer_telegram_chat_id === null ? null : String(r.payer_telegram_chat_id),
    manuallyResolved: Number(r.manually_resolved) === 1,
  };
}

function toDelivery(r: Row): Delivery {
  return {
    id: Number(r.id),
    eventId: Number(r.event_id),
    channel: String(r.channel) as DeliveryChannel,
    target: String(r.target),
    dedupeKey: String(r.dedupe_key),
    body: String(r.body),
    status: String(r.status) as DeliveryStatus,
    attempts: Number(r.attempts),
    nextAttemptAt: new Date(String(r.next_attempt_at)),
    lastError: r.last_error === null ? null : String(r.last_error),
    sentAt: optDate(r.sent_at),
    createdAt: new Date(String(r.created_at)),
  };
}

function toPayment(r: Row): Payment {
  return {
    id: Number(r.id),
    network: String(r.network) as Network,
    txHash: String(r.tx_hash),
    logIndex: Number(r.log_index),
    tokenContract: String(r.token_contract),
    fromAddress: String(r.from_address),
    toAddress: String(r.to_address),
    amount: unitsFromDb(String(r.amount)),
    blockNumber: Number(r.block_number),
    blockTimestamp: new Date(String(r.block_timestamp)),
    status: String(r.status) as PaymentStatus,
    orderId: r.order_id === null ? null : String(r.order_id),
    note: r.note === null ? null : String(r.note),
    firstSeenAt: new Date(String(r.first_seen_at)),
  };
}
