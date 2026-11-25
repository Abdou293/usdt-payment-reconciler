// Telegram bot command logic, independent of the Telegram library (easy to test).
//
// Payer:  /start <orderId>  (via deep link)  -> link this chat to the order, show instructions
//         /status <orderId>                  -> current status (linked chat or admin only)
// Admin:  /neworder <amount> <network> [ref] -> create an order, get a link for the payer
//         /review                            -> manual review queue

import { formatAmount } from '../core/money.js';
import type { Order } from '../core/types.js';
import type { Store } from '../db/Store.js';
import { escapeHtml, NETWORK_NAMES, paymentInstructions } from '../notifications/messages.js';
import { ValidationError, type OrderService } from '../services/OrderService.js';

const ORDER_ID = /^ord_[0-9a-f]{20}$/;

export interface BotHandlerOptions {
  adminChatId: string | null;
  botUsername: string | null;
}

export class BotHandlers {
  constructor(
    private readonly store: Store,
    private readonly orders: OrderService,
    private readonly options: BotHandlerOptions,
  ) {}

  isAdmin(chatId: string): boolean {
    return this.options.adminChatId !== null && chatId === this.options.adminChatId;
  }

  async start(chatId: string, payload: string): Promise<string> {
    const orderId = payload.trim();
    if (!orderId) return this.help(chatId);
    if (!ORDER_ID.test(orderId)) return 'That link is not valid. Please ask the merchant for a new payment link.';

    const order = await this.store.getOrder(orderId);
    if (!order) return 'Order not found. Please ask the merchant for a new payment link.';

    if (order.payerTelegramChatId === null) {
      const linked = await this.store.setPayerChatId(order.id, chatId);
      if (!linked) return 'This order is already linked to another Telegram chat.';
    } else if (order.payerTelegramChatId !== chatId) {
      return 'This order is already linked to another Telegram chat.';
    }
    return `${paymentInstructions(order)}\n\nYou will get a message here when your payment is received and confirmed.`;
  }

  async status(chatId: string, arg: string): Promise<string> {
    const orderId = arg.trim();
    if (!ORDER_ID.test(orderId)) return 'Usage: /status &lt;order id&gt;';
    const order = await this.store.getOrder(orderId);
    // Same answer for "missing" and "not yours", so order ids can't be probed.
    if (!order || (!this.isAdmin(chatId) && order.payerTelegramChatId !== chatId)) {
      return 'Order not found.';
    }
    return this.describe(order);
  }

  async newOrder(chatId: string, args: string): Promise<string> {
    if (!this.isAdmin(chatId)) return 'This command is for the merchant admin only.';
    const [amount, network, ref] = args.trim().split(/\s+/);
    if (!amount || !network) {
      return 'Usage: /neworder &lt;amount&gt; &lt;network&gt; [your reference]\nExample: /neworder 49.99 tron INV-1001';
    }
    try {
      const order = await this.orders.createOrder({ amount, network: network.toLowerCase(), externalRef: ref });
      const link = this.options.botUsername ? `https://t.me/${this.options.botUsername}?start=${order.id}` : null;
      return [
        paymentInstructions(order),
        '',
        link ? `Send this link to the payer so they get status updates:\n${link}` : 'Set TELEGRAM_BOT_USERNAME to get a payer link.',
      ].join('\n');
    } catch (error) {
      if (error instanceof ValidationError) return `Could not create order: ${escapeHtml(error.message)}`;
      throw error;
    }
  }

  async review(chatId: string): Promise<string> {
    if (!this.isAdmin(chatId)) return 'This command is for the merchant admin only.';
    const orders = await this.store.listOrdersByStatus(['underpaid', 'overpaid', 'late_payment']);
    const payments = await this.store.listPaymentsByStatus(['unmatched', 'wrong_token']);
    if (orders.length === 0 && payments.length === 0) return '✅ Review queue is empty.';
    const lines = ['<b>Manual review queue</b>'];
    for (const o of orders.slice(0, 10)) {
      lines.push(`• Order <code>${o.id}</code> ${o.status}: requested ${formatAmount(o.payableAmount)} USDT`);
    }
    for (const p of payments.slice(0, 10)) {
      lines.push(`• Payment #${p.id} ${p.status}: ${formatAmount(p.amount)} on ${NETWORK_NAMES[p.network]} (${escapeHtml(p.note ?? '')})`);
    }
    lines.push('', 'Resolve items in the admin dashboard.');
    return lines.join('\n');
  }

  help(chatId: string): string {
    const lines = [
      '<b>USDT payment notifications</b>',
      'Open the payment link from the merchant to follow your order here.',
      '/status &lt;order id&gt; - check an order you are following',
    ];
    if (this.isAdmin(chatId)) {
      lines.push('', '<b>Admin</b>', '/neworder &lt;amount&gt; &lt;network&gt; [ref]', '/review - manual review queue');
    }
    lines.push('', 'This service only watches public blockchain data. It will never ask for your private key or seed phrase.');
    return lines.join('\n');
  }

  private describe(order: Order): string {
    return [
      `Order <code>${order.id}</code>${order.externalRef ? ` (#${escapeHtml(order.externalRef)})` : ''}`,
      `Status: <b>${order.status}</b>`,
      `Amount: ${formatAmount(order.payableAmount)} USDT on ${NETWORK_NAMES[order.network]}`,
    ].join('\n');
  }
}

/** Simple per-chat rate limit (in memory: losing it on restart is harmless). */
export class ChatRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly maxPerWindow = 10,
    private readonly windowMs = 60_000,
  ) {}

  allow(chatId: string, now = Date.now()): boolean {
    const recent = (this.hits.get(chatId) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.maxPerWindow) {
      this.hits.set(chatId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(chatId, recent);
    if (this.hits.size > 10_000) this.hits.clear();
    return true;
  }
}
