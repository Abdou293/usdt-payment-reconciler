// CSV export with proper quoting and protection against "CSV injection":
// a cell starting with = + - @ (or tab/CR) can run as a formula when opened in
// Excel/Sheets, so such cells are prefixed with an apostrophe.

import { formatAmount } from '../core/money.js';
import type { Order, Payment } from '../core/types.js';

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function ordersCsv(orders: readonly Order[], payments: ReadonlyMap<string, readonly Payment[]>): string {
  return toCsv(
    ['order_id', 'external_ref', 'created_at', 'expires_at', 'network', 'token', 'receiving_address', 'base_amount', 'payable_amount', 'paid_total', 'status', 'manually_resolved', 'tx_hashes'],
    orders.map((o) => {
      const matched = (payments.get(o.id) ?? []).filter((p) => p.status === 'matched');
      return [
        o.id, o.externalRef, o.createdAt.toISOString(), o.expiresAt.toISOString(), o.network, o.token, o.receivingAddress,
        formatAmount(o.baseAmount), formatAmount(o.payableAmount), formatAmount(matched.reduce((s, p) => s + p.amount, 0n)),
        o.status, o.manuallyResolved, matched.map((p) => p.txHash).join(' '),
      ];
    }),
  );
}

export function paymentsCsv(payments: readonly Payment[]): string {
  return toCsv(
    ['payment_id', 'network', 'tx_hash', 'log_index', 'token_contract', 'from_address', 'to_address', 'amount', 'block_number', 'block_time', 'status', 'order_id', 'note'],
    payments.map((p) => [
      p.id, p.network, p.txHash, p.logIndex, p.tokenContract, p.fromAddress, p.toAddress, formatAmount(p.amount),
      p.blockNumber, p.blockTimestamp.toISOString(), p.status, p.orderId, p.note,
    ]),
  );
}
