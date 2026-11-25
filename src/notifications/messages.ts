// Human-readable message texts (Telegram HTML). Everything dynamic is escaped.

import { formatAmount } from '../core/money.js';
import type { Network, Order } from '../core/types.js';

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export const NETWORK_NAMES: Record<Network, string> = {
  tron: 'TRON (TRC20)',
  arbitrum: 'Arbitrum One',
  simulated: 'Simulated chain (demo)',
};

export type ExplorerLink = (network: Network, txHash: string) => string | null;

function utc(iso: string | Date): string {
  return `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function txLinks(network: Network, hashes: readonly string[], explorer: ExplorerLink): string {
  return hashes
    .map((h) => {
      const url = explorer(network, h);
      const short = `${h.slice(0, 10)}…`;
      return url && url.startsWith('https://') ? `<a href="${escapeHtml(url)}">${escapeHtml(short)}</a>` : escapeHtml(short);
    })
    .join(', ');
}

/** Exact payment instructions for the payer. */
export function paymentInstructions(order: Order): string {
  return [
    `<b>Payment request</b> ${order.externalRef ? `#${escapeHtml(order.externalRef)}` : ''}`.trim(),
    '',
    `Send <b>exactly ${formatAmount(order.payableAmount)} USDT</b>`,
    `Network: <b>${NETWORK_NAMES[order.network]}</b>`,
    `To: <code>${escapeHtml(order.receivingAddress)}</code>`,
    `Before: ${utc(order.expiresAt)}`,
    '',
    'The last digits of the amount identify your order. Sending a different amount,',
    'another token or another network will delay confirmation.',
    `Order: <code>${escapeHtml(order.id)}</code>`,
  ].join('\n');
}

export interface StatusPayload {
  orderId: string;
  from: string;
  to: string;
  actor: string;
  network: Network;
  externalRef: string | null;
  payableAmount: string;
  paidTotal: string;
  txHashes: string[];
  payerTelegramChatId: string | null;
  manuallyResolved: boolean;
}

/** Message to the PAYER for a status change, or null if none is needed. */
export function payerMessage(p: StatusPayload, explorer: ExplorerLink): string | null {
  const ref = p.externalRef ? ` #${escapeHtml(p.externalRef)}` : '';
  const links = p.txHashes.length ? `\nTransaction: ${txLinks(p.network, p.txHashes, explorer)}` : '';
  switch (p.to) {
    case 'detected':
      return `✅ Payment received for order${ref} (${p.paidTotal} USDT). Waiting for blockchain confirmations…${links}`;
    case 'confirming':
      return p.from === 'detected' ? null : `⏳ Your payment for order${ref} is confirming on the blockchain…${links}`;
    case 'confirmed':
      return `🎉 Payment confirmed for order${ref}. Thank you!${links}`;
    case 'underpaid':
      return `⚠️ We received ${p.paidTotal} USDT for order${ref}, but ${p.payableAmount} USDT was requested. The merchant will review it.${links}`;
    case 'overpaid':
      return `⚠️ We received ${p.paidTotal} USDT for order${ref}, more than the ${p.payableAmount} USDT requested. The merchant will review it.${links}`;
    case 'late_payment':
      return `⚠️ Your payment for order${ref} arrived after the order expired. The merchant will review it.${links}`;
    case 'expired':
      return `⌛ Order${ref} expired without a payment. Please do not send funds for it; ask the merchant for a new payment request.`;
    default:
      return null;
  }
}

/** Message to the ADMIN for a status change, or null if none is needed. */
export function adminStatusMessage(p: StatusPayload, explorer: ExplorerLink): string | null {
  const head = `Order <code>${escapeHtml(p.orderId)}</code>${p.externalRef ? ` (#${escapeHtml(p.externalRef)})` : ''} on ${NETWORK_NAMES[p.network]}`;
  const links = p.txHashes.length ? `\nTx: ${txLinks(p.network, p.txHashes, explorer)}` : '';
  switch (p.to) {
    case 'detected':
      return `💰 New payment: ${p.paidTotal} USDT\n${head}${links}`;
    case 'confirmed':
      return `✅ Confirmed${p.manuallyResolved ? ' (manually by admin)' : ''}: ${p.paidTotal} USDT\n${head}${links}`;
    default:
      return null; // review states are announced by review alerts
  }
}

export interface ReviewPayload {
  kind: string;
  message: string;
  orderId: string | null;
  paymentId: number | null;
}

export function adminReviewMessage(p: ReviewPayload): string {
  const icon = p.kind === 'reorg_after_final' ? '🚨' : '🔎';
  return `${icon} <b>Needs manual review</b> (${escapeHtml(p.kind)})\n${escapeHtml(p.message)}`;
}
