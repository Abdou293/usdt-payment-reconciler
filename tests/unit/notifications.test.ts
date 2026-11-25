import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BotHandlers, ChatRateLimiter } from '../../src/bot/BotHandlers.js';
import { parseAmount } from '../../src/core/money.js';
import { loadEnv } from '../../src/config/env.js';
import { adminReviewMessage, escapeHtml } from '../../src/notifications/messages.js';
import {
  NotificationDispatcher,
  PermanentDeliveryError,
  type TelegramSender,
} from '../../src/notifications/NotificationDispatcher.js';
import { signWebhook, verifyWebhookSignature, SIGNATURE_HEADER } from '../../src/notifications/webhookSignature.js';
import { createHarness, payAndPoll, SIM_ADDRESS } from '../helpers.js';

const SECRET = 'test-webhook-secret-that-is-long-enough-123';
const PAYER = '111111';
const ADMIN = '999999';

type Harness = ReturnType<typeof createHarness>;
const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.store.close();
});

class FakeTelegram implements TelegramSender {
  sent: Array<{ chatId: string; html: string }> = [];
  failWith: Error | null = null;
  async sendMessage(chatId: string, html: string): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push({ chatId, html });
  }
}

interface WebhookCall {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function setup(options: { telegram?: boolean; webhook?: boolean; webhookStatus?: () => number; dbPath?: string } = {}) {
  const h = createHarness({ dbPath: options.dbPath });
  open.push(h);
  const telegram = new FakeTelegram();
  const webhookCalls: WebhookCall[] = [];
  const dispatcher = new NotificationDispatcher(h.store, {
    context: {
      telegramEnabled: options.telegram ?? true,
      adminChatId: ADMIN,
      webhookEnabled: options.webhook ?? true,
      explorer: (_n, hash) => `https://explorer.example/tx/${hash}`,
    },
    telegram,
    webhook: {
      url: 'https://merchant.example/webhook',
      secret: SECRET,
      fetch: async (url, init) => {
        webhookCalls.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
        return new Response('ok', { status: options.webhookStatus?.() ?? 200 });
      },
    },
    now: h.clock.now,
    baseRetryDelayMs: 1000,
    maxAttempts: 3,
  });
  return { h, telegram, webhookCalls, dispatcher };
}

async function confirmedOrder(h: Harness, payer: string | undefined = PAYER) {
  await h.watcher.pollOnce();
  const order = await h.orders.createOrder({ amount: '50', network: 'simulated', externalRef: 'INV-7', payerTelegramChatId: payer });
  await payAndPoll(h, SIM_ADDRESS, order.payableAmount, 2);
  return order;
}

describe('webhook HMAC signature', () => {
  const body = '{"type":"order.confirmed"}';
  const t = 1_800_000_000;

  it('accepts a correct signature', () => {
    expect(verifyWebhookSignature(SECRET, signWebhook(SECRET, body, t), body, t)).toEqual({ valid: true });
  });

  it('rejects a tampered body', () => {
    const sig = signWebhook(SECRET, body, t);
    expect(verifyWebhookSignature(SECRET, sig, body.replace('confirmed', 'refunded'), t).valid).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(verifyWebhookSignature('another-secret-another-secret-xx', signWebhook(SECRET, body, t), body, t).valid).toBe(false);
  });

  it('rejects an old (replayed) webhook', () => {
    const result = verifyWebhookSignature(SECRET, signWebhook(SECRET, body, t), body, t + 301);
    expect(result).toEqual({ valid: false, reason: 'timestamp outside tolerance (possible replay)' });
  });

  it('rejects missing or malformed headers', () => {
    expect(verifyWebhookSignature(SECRET, undefined, body, t).valid).toBe(false);
    expect(verifyWebhookSignature(SECRET, 't=abc,v1=xyz', body, t).valid).toBe(false);
    expect(verifyWebhookSignature(SECRET, `t=${t}`, body, t).valid).toBe(false);
  });
});

describe('notification dispatcher', () => {
  it('notifies payer and admin, and sends one signed webhook on confirmation', async () => {
    const { h, telegram, webhookCalls, dispatcher } = setup();
    const order = await confirmedOrder(h);
    const result = await dispatcher.runOnce();
    expect(result.failed).toBe(0);

    const toPayer = telegram.sent.filter((m) => m.chatId === PAYER).map((m) => m.html);
    expect(toPayer).toHaveLength(2);
    expect(toPayer[0]).toContain('Payment received');
    expect(toPayer[1]).toContain('Payment confirmed');
    expect(toPayer[1]).toContain('https://explorer.example/tx/');

    const toAdmin = telegram.sent.filter((m) => m.chatId === ADMIN).map((m) => m.html);
    expect(toAdmin.some((m) => m.includes('New payment'))).toBe(true);
    expect(toAdmin.some((m) => m.includes('Confirmed'))).toBe(true);

    expect(webhookCalls).toHaveLength(1);
    const call = webhookCalls[0]!;
    const now = Math.floor(h.clock.now().getTime() / 1000);
    expect(verifyWebhookSignature(SECRET, call.headers[SIGNATURE_HEADER], call.body, now)).toEqual({ valid: true });
    const payload = JSON.parse(call.body);
    expect(payload).toMatchObject({ type: 'order.confirmed', data: { order_id: order.id, external_ref: 'INV-7', paid_total: payload.data.payable_amount } });
  });

  it('is idempotent: running again sends nothing twice', async () => {
    const { h, telegram, webhookCalls, dispatcher } = setup();
    await confirmedOrder(h);
    await dispatcher.runOnce();
    const count = telegram.sent.length;
    await dispatcher.runOnce();
    await dispatcher.runOnce();
    expect(telegram.sent).toHaveLength(count);
    expect(webhookCalls).toHaveLength(1);
  });

  it('alerts the admin about a problem payment and sends no webhook', async () => {
    const { h, telegram, webhookCalls, dispatcher } = setup();
    await h.watcher.pollOnce();
    await h.orders.createOrder({ amount: '50', network: 'simulated', payerTelegramChatId: PAYER });
    await payAndPoll(h, SIM_ADDRESS, parseAmount('60'), 2);
    await dispatcher.runOnce();
    expect(telegram.sent.some((m) => m.chatId === ADMIN && m.html.includes('Needs manual review'))).toBe(true);
    expect(telegram.sent.some((m) => m.chatId === PAYER && m.html.includes('more than'))).toBe(true);
    expect(webhookCalls).toHaveLength(0);
  });

  it('retries a failing webhook with backoff, then succeeds', async () => {
    let status = 500;
    const { h, webhookCalls, dispatcher } = setup({ webhookStatus: () => status });
    await confirmedOrder(h);
    const first = await dispatcher.runOnce();
    expect(first.retried).toBe(1);
    const [pending] = await h.store.listDeliveries(['pending'], 10).then((d) => d.filter((x) => x.channel === 'webhook'));
    expect(pending!.lastError).toContain('500');
    expect(pending!.nextAttemptAt.getTime()).toBeGreaterThan(h.clock.now().getTime());

    await dispatcher.runOnce(); // too early: not retried yet
    expect(webhookCalls).toHaveLength(1);

    status = 200;
    h.clock.advanceMinutes(1);
    const later = await dispatcher.runOnce();
    expect(later.sent).toBe(1);
    expect(webhookCalls).toHaveLength(2);
  });

  it('gives up after the maximum number of attempts', async () => {
    const { h, dispatcher } = setup({ webhookStatus: () => 503 });
    await confirmedOrder(h);
    for (let i = 0; i < 5; i++) {
      await dispatcher.runOnce();
      h.clock.advanceMinutes(10);
    }
    const failed = await h.store.listDeliveries(['failed'], 10);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.attempts).toBe(3);
  });

  it('does not retry a permanent Telegram error (user blocked the bot)', async () => {
    const { h, telegram, dispatcher } = setup({ webhook: false });
    telegram.failWith = new PermanentDeliveryError('Telegram 403: bot was blocked by the user');
    await confirmedOrder(h);
    const result = await dispatcher.runOnce();
    expect(result.retried).toBe(0);
    expect(result.failed).toBeGreaterThan(0);
    const failed = await h.store.listDeliveries(['failed'], 10);
    expect(failed.every((d) => d.attempts === 1)).toBe(true);
  });

  it('sends only to the channels that are configured', async () => {
    const { h, telegram, webhookCalls, dispatcher } = setup({ telegram: false, webhook: false });
    await confirmedOrder(h);
    const result = await dispatcher.runOnce();
    expect(result.planned).toBe(0);
    expect(telegram.sent).toHaveLength(0);
    expect(webhookCalls).toHaveLength(0);
  });

  it('delivers notifications created before a restart (durable outbox)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'usdt-notify-'));
    try {
      const dbPath = join(dir, 'app.db');
      const first = setup({ dbPath });
      await confirmedOrder(first.h); // payment confirmed, but the process "crashes" before sending
      first.h.store.close();
      open.splice(open.indexOf(first.h), 1);

      const second = setup({ dbPath });
      await second.dispatcher.runOnce();
      expect(second.telegram.sent.some((m) => m.html.includes('Payment confirmed'))).toBe(true);
      expect(second.webhookCalls).toHaveLength(1);
      second.h.store.close();
      open.splice(open.indexOf(second.h), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escapes HTML in messages', () => {
    expect(escapeHtml('<b>&"')).toBe('&lt;b&gt;&amp;&quot;');
    const msg = adminReviewMessage({ kind: 'unmatched_payment', message: '<script>alert(1)</script>', orderId: null, paymentId: 1 });
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;script&gt;');
  });
});

describe('Telegram bot commands', () => {
  function bot(h: Harness) {
    return new BotHandlers(h.store, h.orders, { adminChatId: ADMIN, botUsername: 'demo_usdt_bot' });
  }

  it('shows help, with admin commands only for the admin', async () => {
    const h = createHarness();
    open.push(h);
    expect(await bot(h).start(PAYER, '')).not.toContain('/neworder');
    expect(await bot(h).start(ADMIN, '')).toContain('/neworder');
  });

  it('links a payer chat through the deep link, and refuses a second chat', async () => {
    const h = createHarness();
    open.push(h);
    const order = await h.orders.createOrder({ amount: '25', network: 'simulated' });
    const reply = await bot(h).start(PAYER, order.id);
    expect(reply).toContain('Send <b>exactly');
    expect((await h.store.getOrder(order.id))!.payerTelegramChatId).toBe(PAYER);
    expect(await bot(h).start('222222', order.id)).toContain('already linked');
    expect(await bot(h).start(PAYER, order.id)).toContain('Send <b>exactly'); // same chat again is fine
    expect(await bot(h).start(PAYER, 'not-an-order')).toContain('not valid');
  });

  it('only shows order status to the linked payer or the admin', async () => {
    const h = createHarness();
    open.push(h);
    const order = await h.orders.createOrder({ amount: '25', network: 'simulated', payerTelegramChatId: PAYER });
    expect(await bot(h).status(PAYER, order.id)).toContain('pending');
    expect(await bot(h).status(ADMIN, order.id)).toContain('pending');
    expect(await bot(h).status('333333', order.id)).toBe('Order not found.');
  });

  it('lets only the admin create orders, with validation', async () => {
    const h = createHarness();
    open.push(h);
    expect(await bot(h).newOrder(PAYER, '10 simulated')).toContain('admin only');
    const reply = await bot(h).newOrder(ADMIN, '10 simulated INV-55');
    expect(reply).toMatch(/https:\/\/t\.me\/demo_usdt_bot\?start=ord_[0-9a-f]{20}/);
    expect(await bot(h).newOrder(ADMIN, '10.123 simulated')).toContain('Could not create order');
    expect(await bot(h).newOrder(ADMIN, '')).toContain('Usage');
  });

  it('lists the review queue for the admin', async () => {
    const h = createHarness();
    open.push(h);
    expect(await bot(h).review(ADMIN)).toContain('empty');
    await h.watcher.pollOnce();
    await h.orders.createOrder({ amount: '50', network: 'simulated' });
    await payAndPoll(h, SIM_ADDRESS, parseAmount('60'), 2);
    expect(await bot(h).review(ADMIN)).toContain('overpaid');
    expect(await bot(h).review(PAYER)).toContain('admin only');
  });

  it('rate-limits a chat that sends too many commands', () => {
    const limiter = new ChatRateLimiter(3, 60_000);
    expect([1, 2, 3, 4].map(() => limiter.allow('x', 1000))).toEqual([true, true, true, false]);
    expect(limiter.allow('x', 62_000)).toBe(true);
  });
});

describe('notification settings validation', () => {
  it('refuses placeholder secrets copied from .env.example', () => {
    expect(() => loadEnv({ WEBHOOK_URL: 'https://shop.example/hook', WEBHOOK_SECRET: 'replace_with_a_long_random_string' } as NodeJS.ProcessEnv)).toThrow(/placeholder/);
  });

  it('requires https for webhooks (http only for localhost)', () => {
    const secret = 'x'.repeat(40);
    expect(() => loadEnv({ WEBHOOK_URL: 'http://shop.example/hook', WEBHOOK_SECRET: secret } as NodeJS.ProcessEnv)).toThrow(/https/);
    expect(loadEnv({ WEBHOOK_URL: 'http://localhost:4000/webhook', WEBHOOK_SECRET: secret } as NodeJS.ProcessEnv).WEBHOOK_URL).toBeDefined();
  });

  it('requires a secret when a webhook URL is set', () => {
    expect(() => loadEnv({ WEBHOOK_URL: 'https://shop.example/hook' } as NodeJS.ProcessEnv)).toThrow(/WEBHOOK_SECRET/);
  });

  it('rejects a malformed Telegram bot token', () => {
    expect(() => loadEnv({ TELEGRAM_BOT_TOKEN: 'not-a-token' } as NodeJS.ProcessEnv)).toThrow(/BotFather/);
  });
});
