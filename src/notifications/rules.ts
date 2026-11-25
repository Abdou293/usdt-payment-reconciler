// Who gets told what. Pure function: one stored event -> planned deliveries.
// dedupe keys make this idempotent: re-running fan-out never sends twice.

import type { DeliveryChannel, DomainEvent } from '../db/Store.js';
import {
  adminReviewMessage,
  adminStatusMessage,
  payerMessage,
  type ExplorerLink,
  type ReviewPayload,
  type StatusPayload,
} from './messages.js';

export interface PlannedDelivery {
  channel: DeliveryChannel;
  target: string;
  dedupeKey: string;
  body: string;
}

export interface NotificationContext {
  telegramEnabled: boolean;
  adminChatId: string | null;
  webhookEnabled: boolean;
  explorer: ExplorerLink;
}

export function planDeliveries(event: DomainEvent, ctx: NotificationContext): PlannedDelivery[] {
  const out: PlannedDelivery[] = [];

  if (event.type === 'review_alert') {
    const p = event.payload as unknown as ReviewPayload;
    if (ctx.telegramEnabled && ctx.adminChatId) {
      out.push({ channel: 'telegram', target: ctx.adminChatId, dedupeKey: `evt:${event.id}:admin`, body: adminReviewMessage(p) });
    }
    return out;
  }

  const p = event.payload as unknown as StatusPayload;
  // Semantic key: one message per (order, new status, recipient), even if a
  // reorg makes the order pass through the same status twice.
  const key = (who: string) => `order:${p.orderId}:${p.to}:${who}`;

  if (ctx.telegramEnabled) {
    const payerText = p.payerTelegramChatId ? payerMessage(p, ctx.explorer) : null;
    if (payerText && p.payerTelegramChatId) {
      out.push({ channel: 'telegram', target: p.payerTelegramChatId, dedupeKey: key('payer'), body: payerText });
    }
    const adminText = ctx.adminChatId ? adminStatusMessage(p, ctx.explorer) : null;
    if (adminText && ctx.adminChatId) {
      out.push({ channel: 'telegram', target: ctx.adminChatId, dedupeKey: key('admin'), body: adminText });
    }
  }

  if (ctx.webhookEnabled && p.to === 'confirmed') {
    const body = JSON.stringify({
      id: `evt_${event.id}`,
      type: 'order.confirmed',
      created_at: event.createdAt.toISOString(),
      data: {
        order_id: p.orderId,
        external_ref: p.externalRef,
        network: p.network,
        token: 'USDT',
        payable_amount: p.payableAmount,
        paid_total: p.paidTotal,
        tx_hashes: p.txHashes,
        manually_resolved: p.manuallyResolved,
        confirmed_by: p.actor,
      },
    });
    // Exactly one "order.confirmed" webhook per order.
    out.push({ channel: 'webhook', target: 'merchant', dedupeKey: `webhook:order.confirmed:${p.orderId}`, body });
  }
  return out;
}
