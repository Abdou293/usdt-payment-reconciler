// Convert internal objects (with bigint amounts) into JSON-safe API objects.

import { formatAmount } from '../core/money.js';
import type { Order, Payment } from '../core/types.js';
import type { AuditEntry } from '../db/Store.js';
import type { ExplorerLink } from '../notifications/messages.js';

export function orderDto(o: Order, paidTotal?: bigint) {
  return {
    id: o.id,
    external_ref: o.externalRef,
    network: o.network,
    token: o.token,
    receiving_address: o.receivingAddress,
    base_amount: formatAmount(o.baseAmount),
    amount: formatAmount(o.payableAmount), // the exact amount the payer must send
    paid_total: paidTotal === undefined ? undefined : formatAmount(paidTotal),
    status: o.status,
    created_at: o.createdAt.toISOString(),
    expires_at: o.expiresAt.toISOString(),
    manually_resolved: o.manuallyResolved,
    payer_telegram_linked: o.payerTelegramChatId !== null,
  };
}

export function paymentDto(p: Payment, explorer: ExplorerLink) {
  return {
    id: p.id,
    network: p.network,
    tx_hash: p.txHash,
    log_index: p.logIndex,
    explorer_url: explorer(p.network, p.txHash),
    token_contract: p.tokenContract,
    from_address: p.fromAddress,
    to_address: p.toAddress,
    amount: formatAmount(p.amount),
    block_number: p.blockNumber,
    block_time: p.blockTimestamp.toISOString(),
    status: p.status,
    order_id: p.orderId,
    note: p.note,
    first_seen_at: p.firstSeenAt.toISOString(),
  };
}

export function auditDto(a: AuditEntry) {
  return {
    id: a.id,
    entity_type: a.entityType,
    entity_id: a.entityId,
    action: a.action,
    from_status: a.fromStatus,
    to_status: a.toStatus,
    actor: a.actor,
    details: a.details,
    created_at: a.createdAt.toISOString(),
  };
}

export function sumMatched(payments: readonly Payment[]): bigint {
  return payments.filter((p) => p.status === 'matched').reduce((s, p) => s + p.amount, 0n);
}
