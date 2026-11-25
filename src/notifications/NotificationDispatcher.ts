// Sends notifications from the database outbox, with retries.
//
// 1. Fan-out: read new events (after a saved cursor) and create delivery rows.
// 2. Send: deliver due rows; on failure retry later with exponential backoff.
// Everything lives in the database, so a crash or a sleeping host never loses
// a notification: the next run simply continues.

import type { Delivery, Store } from '../db/Store.js';
import type { Clock } from '../services/config.js';
import { planDeliveries, type NotificationContext } from './rules.js';
import { EVENT_ID_HEADER, SIGNATURE_HEADER, signWebhook } from './webhookSignature.js';

/** An error that will not succeed on retry (e.g. the user blocked the bot). */
export class PermanentDeliveryError extends Error {}

export interface TelegramSender {
  sendMessage(chatId: string, html: string): Promise<void>;
}

export interface WebhookConfig {
  url: string;
  secret: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

export interface DispatcherOptions {
  context: NotificationContext;
  telegram?: TelegramSender | undefined;
  webhook?: WebhookConfig | undefined;
  now?: Clock;
  maxAttempts?: number;
  baseRetryDelayMs?: number;
  batchSize?: number;
}

export interface DispatchResult {
  planned: number;
  sent: number;
  retried: number;
  failed: number;
}

const CURSOR_KEY = 'dispatcher.event_cursor';

export class NotificationDispatcher {
  private readonly now: Clock;
  private running = false;

  constructor(
    private readonly store: Store,
    private readonly options: DispatcherOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<DispatchResult> {
    if (this.running) return { planned: 0, sent: 0, retried: 0, failed: 0 }; // no overlapping runs
    this.running = true;
    try {
      const planned = await this.fanOut();
      const result = await this.sendDue();
      return { planned, ...result };
    } finally {
      this.running = false;
    }
  }

  private async fanOut(): Promise<number> {
    let planned = 0;
    for (;;) {
      const batch = await this.store.transaction(async () => {
        const cursor = Number((await this.store.getKv(CURSOR_KEY)) ?? '0');
        const events = await this.store.listEventsAfter(cursor, this.options.batchSize ?? 100);
        for (const event of events) {
          for (const d of planDeliveries(event, this.options.context)) {
            const created = await this.store.insertDeliveryIfNew({
              eventId: event.id,
              channel: d.channel,
              target: d.target,
              dedupeKey: d.dedupeKey,
              body: d.body,
              nextAttemptAt: this.now(),
              createdAt: this.now(),
            });
            if (created) planned += 1;
          }
        }
        if (events.length > 0) await this.store.setKv(CURSOR_KEY, String(events.at(-1)!.id));
        return events.length;
      });
      if (batch === 0) return planned;
    }
  }

  private async sendDue(): Promise<Omit<DispatchResult, 'planned'>> {
    const result = { sent: 0, retried: 0, failed: 0 };
    const due = await this.store.listDueDeliveries(this.now(), this.options.batchSize ?? 100);
    for (const delivery of due) {
      const attempts = delivery.attempts + 1;
      try {
        await this.deliver(delivery);
        await this.store.markDeliverySent(delivery.id, attempts, this.now());
        result.sent += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const maxAttempts = this.options.maxAttempts ?? 8;
        if (error instanceof PermanentDeliveryError || attempts >= maxAttempts) {
          await this.store.markDeliveryFailed(delivery.id, attempts, message);
          result.failed += 1;
        } else {
          const base = this.options.baseRetryDelayMs ?? 30_000;
          const delay = Math.min(base * 2 ** (attempts - 1), 60 * 60_000); // 30s, 60s, 2m ... max 1h
          await this.store.markDeliveryRetry(delivery.id, attempts, new Date(this.now().getTime() + delay), message);
          result.retried += 1;
        }
      }
    }
    return result;
  }

  private async deliver(delivery: Delivery): Promise<void> {
    if (delivery.channel === 'telegram') {
      if (!this.options.telegram) throw new PermanentDeliveryError('Telegram is not configured');
      await this.options.telegram.sendMessage(delivery.target, delivery.body);
      return;
    }
    const webhook = this.options.webhook;
    if (!webhook) throw new PermanentDeliveryError('Webhook is not configured');
    const timestamp = Math.floor(this.now().getTime() / 1000);
    const doFetch = webhook.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
    const response = await doFetch(webhook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signWebhook(webhook.secret, delivery.body, timestamp),
        [EVENT_ID_HEADER]: `delivery_${delivery.id}`,
      },
      body: delivery.body,
      redirect: 'manual', // never follow redirects with a signed payload
      signal: AbortSignal.timeout(webhook.timeoutMs ?? 10_000),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Webhook responded HTTP ${response.status}`);
    }
  }
}
