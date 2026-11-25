// HTTP server: merchant REST API, admin API (dashboard) and static dashboard files.
//
// Security in this file:
// - Every input is validated with zod; amounts stay decimal strings (never floats).
// - Rate limits: global per IP, stricter for login and the merchant API.
// - Admin: HttpOnly + SameSite=Strict session cookie, CSRF header on every change.
// - Merchant API: bearer API key compared in constant time; Idempotency-Key support.
// - Security headers (CSP, no framing, no sniffing) via helmet.

import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { ChainAdapter } from '../chains/ChainAdapter.js';
import { ORDER_STATUSES, type Network } from '../core/types.js';
import type { SessionRecord, Store } from '../db/Store.js';
import type { ExplorerLink } from '../notifications/messages.js';
import { ordersCsv, paymentsCsv } from '../services/csv.js';
import { ValidationError, type OrderService } from '../services/OrderService.js';
import type { PaymentProcessor } from '../services/PaymentProcessor.js';
import { buildReconciliationReport, periodRange } from '../services/reports.js';
import type { WatchedNetwork } from '../services/config.js';
import { AuthService, safeEqual, sha256 } from './auth.js';
import { auditDto, orderDto, paymentDto, sumMatched } from './dto.js';

export interface DemoControls {
  pay(orderId: string, kind: 'exact' | 'under' | 'over' | 'base' | 'wrong_token'): Promise<{ txHash: string }>;
  unknownPayment(amount: string): Promise<{ txHash: string }>;
  mine(blocks: number): Promise<void>;
  reorg(depth: number): Promise<void>;
}

export interface ServerDeps {
  store: Store;
  orders: OrderService;
  processor: PaymentProcessor;
  auth: AuthService;
  networks: ReadonlyArray<{ settings: WatchedNetwork; adapter: ChainAdapter; label: string }>;
  explorerLink: ExplorerLink;
  mode: 'demo' | 'testnet' | 'mainnet';
  merchantApiKey?: string | undefined;
  botUsername?: string | undefined;
  cookieSecure: boolean;
  trustProxy: boolean;
  pollIntervalSeconds: number;
  dashboardDir?: string | undefined;
  demo?: DemoControls | undefined;
  demoCredentials?: { username: string; password: string } | undefined;
  /** Demo mode: refuse new orders above this count (keeps the free host small). */
  demoOrderLimit?: number | undefined;
  now?: () => Date;
  logger?: boolean;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const orderIdParam = z.object({ id: z.string().regex(/^ord_[0-9a-f]{20}$/, 'invalid order id') });
const paymentIdParam = z.object({ id: z.coerce.number().int().positive() });
const reasonBody = z.object({ reason: z.string().trim().min(3, 'reason is required').max(500) });
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use YYYY-MM-DD');

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, result.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  }
  return result.data;
}

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const now = deps.now ?? (() => new Date());
  const app = Fastify({
    logger: deps.logger ?? false,
    trustProxy: deps.trustProxy,
    bodyLimit: 16 * 1024,
  });
  const cookieName = deps.cookieSecure ? '__Host-sid' : 'sid';

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof HttpError) return reply.status(error.statusCode).send({ error: error.message });
    if (error instanceof ValidationError) return reply.status(400).send({ error: error.message });
    if (error.statusCode === 429) return reply.status(429).send({ error: 'Too many requests, slow down.' });
    if (error.statusCode && error.statusCode < 500) return reply.status(error.statusCode).send({ error: error.message });
    // Business-rule violations from the processor (e.g. illegal transition).
    if (/Illegal|Only |not found|required|was not sent/.test(error.message)) {
      return reply.status(409).send({ error: error.message });
    }
    request.log.error(error);
    return reply.status(500).send({ error: 'Internal error' });
  });

  // ------------------------------------------------------------------
  // Public
  // ------------------------------------------------------------------
  app.get('/healthz', async () => ({ status: 'ok', mode: deps.mode }));

  // ------------------------------------------------------------------
  // Merchant REST API (for merchants' own systems)
  // ------------------------------------------------------------------
  const requireApiKey = async (request: FastifyRequest) => {
    if (!deps.merchantApiKey) throw new HttpError(503, 'Merchant API is disabled (MERCHANT_API_KEY not set)');
    const header = request.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!provided || !safeEqual(provided, deps.merchantApiKey)) throw new HttpError(401, 'Invalid API key');
  };

  const createOrderBody = z.object({
    amount: z.string().max(30),
    network: z.string().max(20),
    external_ref: z.string().max(100).optional(),
    expires_in_minutes: z.number().int().optional(),
    payer_telegram_chat_id: z.string().max(25).optional(),
  });

  const checkDemoLimit = async () => {
    if (deps.mode !== 'demo' || !deps.demoOrderLimit) return;
    const { total } = await deps.store.listOrders({ limit: 1, offset: 0 });
    if (total >= deps.demoOrderLimit) throw new HttpError(429, 'Demo order limit reached. The demo resets on redeploy.');
  };

  const merchantRateLimit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  app.post('/api/v1/orders', { ...merchantRateLimit, preHandler: requireApiKey }, async (request, reply) => {
    const body = parse(createOrderBody, request.body);
    const idemHeader = request.headers['idempotency-key'];
    const idemKey = typeof idemHeader === 'string' ? idemHeader : undefined;
    if (idemKey !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(idemKey)) {
      throw new HttpError(400, 'Idempotency-Key must be 8-100 characters: letters, digits, _ -');
    }
    if (idemKey) {
      const existingId = await deps.store.getKv(`idem:${sha256(idemKey)}`);
      const existing = existingId ? await deps.store.getOrder(existingId) : null;
      if (existing) return reply.status(200).send(merchantOrder(existing));
    }
    await checkDemoLimit();
    const order = await deps.orders.createOrder({
      amount: body.amount,
      network: body.network,
      externalRef: body.external_ref,
      expiresInMinutes: body.expires_in_minutes,
      payerTelegramChatId: body.payer_telegram_chat_id,
    });
    if (idemKey) await deps.store.setKv(`idem:${sha256(idemKey)}`, order.id);
    return reply.status(201).send(merchantOrder(order));
  });

  app.get('/api/v1/orders/:id', { ...merchantRateLimit, preHandler: requireApiKey }, async (request) => {
    const { id } = parse(orderIdParam, request.params);
    const order = await deps.store.getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found');
    const payments = await deps.store.listPaymentsForOrder(order.id);
    return {
      ...orderDto(order, sumMatched(payments)),
      payments: payments.filter((p) => p.status === 'matched').map((p) => paymentDto(p, deps.explorerLink)),
    };
  });

  function merchantOrder(order: Parameters<typeof orderDto>[0]) {
    return {
      ...orderDto(order),
      payer_link: deps.botUsername ? `https://t.me/${deps.botUsername}?start=${order.id}` : null,
    };
  }

  // ------------------------------------------------------------------
  // Admin API (dashboard)
  // ------------------------------------------------------------------
  const sessionOf = (request: FastifyRequest) => (request as FastifyRequest & { session?: SessionRecord }).session;

  const requireAdmin = async (request: FastifyRequest) => {
    const session = await deps.auth.getSession(request.cookies[cookieName]);
    if (!session) throw new HttpError(401, 'Not logged in');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const csrf = request.headers['x-csrf-token'];
      if (typeof csrf !== 'string' || !safeEqual(csrf, session.csrfToken)) {
        throw new HttpError(403, 'Missing or invalid CSRF token');
      }
    }
    (request as FastifyRequest & { session?: SessionRecord }).session = session;
  };
  const admin = { preHandler: requireAdmin };
  const actor = (request: FastifyRequest) => sessionOf(request)!.username;

  app.get('/admin/api/session', async (request) => {
    const session = await deps.auth.getSession(request.cookies[cookieName]);
    return {
      authenticated: session !== null,
      username: session?.username ?? null,
      csrf_token: session?.csrfToken ?? null,
      mode: deps.mode,
      demo_credentials: deps.mode === 'demo' ? (deps.demoCredentials ?? null) : null,
      password_reset_available: deps.mode !== 'demo' && deps.auth.passwordResetAvailable,
      networks: deps.networks.map((n) => ({ network: n.settings.network, label: n.label })),
    };
  });

  const loginBody = z.object({ username: z.string().max(64), password: z.string().max(256) });
  app.post('/admin/api/login', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const body = parse(loginBody, request.body);
    const result = await deps.auth.login(body.username, body.password);
    await deps.store.addAudit({
      entityType: 'admin',
      entityId: body.username.slice(0, 64),
      action: result ? 'login_success' : 'login_failed',
      fromStatus: null,
      toStatus: null,
      actor: `ip:${request.ip}`,
      details: null,
      createdAt: now(),
    });
    if (!result) throw new HttpError(401, 'Invalid username or password');
    reply.setCookie(cookieName, result.sessionId, {
      httpOnly: true,
      secure: deps.cookieSecure,
      sameSite: 'strict',
      path: '/',
      expires: result.expiresAt,
    });
    return { username: result.username, csrf_token: result.csrfToken };
  });

  app.post('/admin/api/logout', admin, async (request, reply) => {
    await deps.auth.logout(request.cookies[cookieName]);
    reply.clearCookie(cookieName, { path: '/' });
    return { ok: true };
  });

  // ---- Password management ----
  // The public demo shares one account, so changing or resetting its password
  // would lock every other visitor out: these routes are off in demo mode.
  const notInDemo = () => {
    if (deps.mode === 'demo') throw new HttpError(403, 'Password changes are turned off in the public demo');
  };
  const strictLimit = { rateLimit: { max: 5, timeWindow: '15 minutes' } };

  const changeBody = z.object({ current_password: z.string().max(256), new_password: z.string().max(256) });
  app.post('/admin/api/password', { ...admin, config: strictLimit }, async (request) => {
    notInDemo();
    const body = parse(changeBody, request.body);
    const session = sessionOf(request)!;
    const result = await deps.auth.changePassword(session.username, body.current_password, body.new_password, session.idHash);
    if (!result.ok) throw new HttpError(result.status, result.error);
    return { ok: true };
  });

  const forgotBody = z.object({ username: z.string().max(64) });
  app.post('/admin/api/password/forgot', { config: strictLimit }, async (request) => {
    notInDemo();
    if (!deps.auth.passwordResetAvailable) throw new HttpError(404, 'Password reset by Telegram is not set up on this server');
    const body = parse(forgotBody, request.body);
    try {
      await deps.auth.requestPasswordReset(body.username, `ip:${request.ip}`);
    } catch (error) {
      request.log.error({ err: error }, 'password reset code could not be sent');
    }
    // Same answer whether or not the user exists or the message was sent.
    return { ok: true, message: 'If that account exists, a reset code was sent to the admin Telegram chat.' };
  });

  const resetBody = z.object({ username: z.string().max(64), code: z.string().max(64), new_password: z.string().max(256) });
  app.post('/admin/api/password/reset', { config: strictLimit }, async (request) => {
    notInDemo();
    if (!deps.auth.passwordResetAvailable) throw new HttpError(404, 'Password reset by Telegram is not set up on this server');
    const body = parse(resetBody, request.body);
    const result = await deps.auth.resetPasswordWithCode(body.username, body.code, body.new_password, `ip:${request.ip}`);
    if (!result.ok) throw new HttpError(result.status, result.error);
    return { ok: true };
  });

  const listQuery = z.object({
    status: z.string().optional(),
    network: z.string().optional(),
    q: z.string().max(120).optional(),
    from: dateParam.optional(),
    to: dateParam.optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    page_size: z.coerce.number().int().min(1).max(200).default(25),
  });

  app.get('/admin/api/orders', admin, async (request) => {
    const q = parse(listQuery, request.query);
    const statuses = q.status ? q.status.split(',').filter(Boolean) : undefined;
    if (statuses?.some((s) => !(ORDER_STATUSES as readonly string[]).includes(s))) throw new HttpError(400, 'unknown status');
    const { items, total } = await deps.store.listOrders({
      statuses: statuses as typeof ORDER_STATUSES[number][] | undefined,
      network: (q.network || undefined) as Network | undefined,
      search: q.q || undefined,
      createdFrom: q.from ? new Date(`${q.from}T00:00:00Z`) : undefined,
      createdTo: q.to ? new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000) : undefined,
      limit: q.page_size,
      offset: (q.page - 1) * q.page_size,
    });
    const withPaid = await Promise.all(
      items.map(async (o) => orderDto(o, sumMatched(await deps.store.listPaymentsForOrder(o.id)))),
    );
    return { items: withPaid, total, page: q.page, page_size: q.page_size };
  });

  const adminCreateBody = z.object({
    amount: z.string().max(30),
    network: z.string().max(20),
    external_ref: z.string().max(100).optional(),
    expires_in_minutes: z.number().int().optional(),
  });
  app.post('/admin/api/orders', admin, async (request, reply) => {
    const body = parse(adminCreateBody, request.body);
    await checkDemoLimit();
    const order = await deps.orders.createOrder({
      amount: body.amount,
      network: body.network,
      externalRef: body.external_ref || undefined,
      expiresInMinutes: body.expires_in_minutes,
    });
    return reply.status(201).send(merchantOrder(order));
  });

  app.get('/admin/api/orders/:id', admin, async (request) => {
    const { id } = parse(orderIdParam, request.params);
    const order = await deps.store.getOrder(id);
    if (!order) throw new HttpError(404, 'Order not found');
    const payments = await deps.store.listPaymentsForOrder(order.id);
    const audit = [
      ...(await deps.store.listAudit('order', order.id)),
      ...(await Promise.all(payments.map((p) => deps.store.listAudit('payment', String(p.id))))).flat(),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id ?? 0) - (b.id ?? 0));
    return {
      order: orderDto(order, sumMatched(payments)),
      payments: payments.map((p) => paymentDto(p, deps.explorerLink)),
      audit: audit.map(auditDto),
      payer_link: deps.botUsername ? `https://t.me/${deps.botUsername}?start=${order.id}` : null,
    };
  });

  app.post('/admin/api/orders/:id/accept', admin, async (request) => {
    const { id } = parse(orderIdParam, request.params);
    const { reason } = parse(reasonBody, request.body);
    await deps.processor.acceptOrderManually(id, actor(request), reason);
    return { ok: true };
  });

  app.post('/admin/api/orders/:id/cancel', admin, async (request) => {
    const { id } = parse(orderIdParam, request.params);
    const { reason } = parse(reasonBody, request.body);
    await deps.processor.cancelOrderManually(id, actor(request), reason);
    return { ok: true };
  });

  app.get('/admin/api/review', admin, async () => {
    const orders = await deps.store.listOrdersByStatus(['underpaid', 'overpaid', 'late_payment']);
    const payments = await deps.store.listPaymentsByStatus(['unmatched', 'wrong_token']);
    return {
      orders: await Promise.all(orders.map(async (o) => orderDto(o, sumMatched(await deps.store.listPaymentsForOrder(o.id))))),
      payments: payments.map((p) => paymentDto(p, deps.explorerLink)),
    };
  });

  const assignBody = z.object({
    order_id: z.string().regex(/^ord_[0-9a-f]{20}$/, 'invalid order id'),
    reason: z.string().trim().min(3, 'reason is required').max(500),
  });
  app.post('/admin/api/payments/:id/assign', admin, async (request) => {
    const { id } = parse(paymentIdParam, request.params);
    const body = parse(assignBody, request.body);
    await deps.processor.assignPaymentManually(id, body.order_id, actor(request), body.reason);
    return { ok: true };
  });

  app.post('/admin/api/payments/:id/dismiss', admin, async (request) => {
    const { id } = parse(paymentIdParam, request.params);
    const { reason } = parse(reasonBody, request.body);
    await deps.processor.dismissPaymentManually(id, actor(request), reason);
    return { ok: true };
  });

  // ---- Reports and exports ----
  const reportQuery = z.object({ period: z.enum(['day', 'week']).default('day'), date: dateParam.optional() });
  app.get('/admin/api/reports/reconciliation', admin, async (request) => {
    const q = parse(reportQuery, request.query);
    const { from, to } = periodRange(q.period, q.date ? new Date(`${q.date}T00:00:00Z`) : now());
    const orders = await deps.store.listOrdersCreatedBetween(from, to);
    const paymentsByOrder = new Map(await Promise.all(orders.map(async (o) => [o.id, await deps.store.listPaymentsForOrder(o.id)] as const)));
    const payments = await deps.store.listPaymentsBetween(from, to);
    return { period: q.period, ...buildReconciliationReport(from, to, orders, paymentsByOrder, payments, now()) };
  });

  const rangeQuery = z.object({ from: dateParam, to: dateParam });
  const range = (request: FastifyRequest) => {
    const q = parse(rangeQuery, request.query);
    const from = new Date(`${q.from}T00:00:00Z`);
    const to = new Date(new Date(`${q.to}T00:00:00Z`).getTime() + 86_400_000);
    if (to <= from) throw new HttpError(400, '"to" must not be before "from"');
    if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new HttpError(400, 'range too large (max 366 days)');
    return { from, to, label: `${q.from}_${q.to}` };
  };
  const sendCsv = (reply: FastifyReply, filename: string, csv: string) =>
    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .send(csv);

  app.get('/admin/api/exports/orders.csv', admin, async (request, reply) => {
    const { from, to, label } = range(request);
    const orders = await deps.store.listOrdersCreatedBetween(from, to);
    const payments = new Map(await Promise.all(orders.map(async (o) => [o.id, await deps.store.listPaymentsForOrder(o.id)] as const)));
    return sendCsv(reply, `orders_${label}.csv`, ordersCsv(orders, payments));
  });

  app.get('/admin/api/exports/payments.csv', admin, async (request, reply) => {
    const { from, to, label } = range(request);
    return sendCsv(reply, `payments_${label}.csv`, paymentsCsv(await deps.store.listPaymentsBetween(from, to)));
  });

  // ---- Health ----
  app.get('/admin/api/health', admin, async () => {
    const staleAfterMs = (deps.pollIntervalSeconds * 3 + 60) * 1000;
    const watchers = await Promise.all(
      deps.networks.map(async (n) => {
        const s = await deps.store.getChainState(n.settings.network);
        const healthy = s.lastSuccessAt !== null && now().getTime() - s.lastSuccessAt.getTime() < staleAfterMs;
        return {
          network: n.settings.network,
          label: n.label,
          required_confirmations: n.settings.requiredConfirmations,
          watch_addresses: n.settings.watchAddresses,
          token_contract: n.settings.usdtContract,
          cursor_block: s.cursorBlock,
          latest_block: s.latestBlock,
          lag_blocks: s.cursorBlock !== null && s.latestBlock !== null ? s.latestBlock - s.cursorBlock : null,
          last_poll_at: s.lastPollAt?.toISOString() ?? null,
          last_success_at: s.lastSuccessAt?.toISOString() ?? null,
          last_error: s.lastError,
          healthy,
        };
      }),
    );
    const failed = await deps.store.listDeliveries(['failed'], 20);
    return {
      checked_at: now().toISOString(),
      watchers,
      deliveries: await deps.store.countDeliveriesByStatus(),
      failed_deliveries: failed.map((d) => ({ id: d.id, channel: d.channel, attempts: d.attempts, last_error: d.lastError, created_at: d.createdAt.toISOString() })),
    };
  });

  // ---- Demo controls (registered ONLY in demo mode) ----
  if (deps.mode === 'demo' && deps.demo) {
    const demo = deps.demo;
    const payBody = z.object({ order_id: z.string().regex(/^ord_[0-9a-f]{20}$/), kind: z.enum(['exact', 'under', 'over', 'base', 'wrong_token']) });
    app.post('/admin/api/demo/pay', admin, async (request) => {
      const body = parse(payBody, request.body);
      return demo.pay(body.order_id, body.kind);
    });
    app.post('/admin/api/demo/unknown-payment', admin, async (request) => {
      const body = parse(z.object({ amount: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/) }), request.body);
      return demo.unknownPayment(body.amount);
    });
    app.post('/admin/api/demo/mine', admin, async (request) => {
      const body = parse(z.object({ blocks: z.number().int().min(1).max(20) }), request.body);
      await demo.mine(body.blocks);
      return { ok: true };
    });
    app.post('/admin/api/demo/reorg', admin, async (request) => {
      const body = parse(z.object({ depth: z.number().int().min(1).max(5) }), request.body);
      await demo.reorg(body.depth);
      return { ok: true };
    });
  }

  // ------------------------------------------------------------------
  // Dashboard static files (single-page app)
  // ------------------------------------------------------------------
  const dashboardDir = deps.dashboardDir ? resolve(deps.dashboardDir) : null;
  if (dashboardDir && existsSync(resolve(dashboardDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: dashboardDir });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split('?')[0] ?? '';
      const looksLikeFile = /\.[a-z0-9]+$/i.test(path);
      if (request.method === 'GET' && !looksLikeFile && !path.startsWith('/api/') && !path.startsWith('/admin/api/')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: 'Not found' });
    });
  } else {
    app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: 'Not found' }));
  }

  return app;
}
