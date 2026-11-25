// HTTP API tests (Fastify inject: no real network port is opened).

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Mutex } from '../../src/core/mutex.js';
import { parseAmount } from '../../src/core/money.js';
import { createSimulatorControls } from '../../src/demo/SimulatorControls.js';
import { AuthService } from '../../src/http/auth.js';
import { buildServer, type ServerDeps } from '../../src/http/server.js';
import { NotificationDispatcher } from '../../src/notifications/NotificationDispatcher.js';
import { createHarness, payAndPoll, SIM_ADDRESS } from '../helpers.js';

const API_KEY = 'test-merchant-key-0123456789abcdef0123456789';
const PASSWORD = 'correct horse battery';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function setup(overrides: Omit<Partial<ServerDeps>, "demo"> & { demoMode?: boolean } = {}) {
  const h = createHarness();
  const auth = new AuthService(h.store, h.clock.now);
  await auth.ensureInitialAdmin('admin', PASSWORD);
  const dispatcher = new NotificationDispatcher(h.store, {
    context: { telegramEnabled: false, adminChatId: null, webhookEnabled: false, explorer: () => null },
  });
  const networks = [{ settings: h.config.networks.get('simulated')!, adapter: h.chain, label: 'Simulated' }];
  const { demoMode: demo, ...rest } = overrides;
  app = await buildServer({
    store: h.store,
    orders: h.orders,
    processor: h.processor,
    auth,
    networks,
    explorerLink: () => null,
    mode: demo ? 'demo' : 'testnet',
    merchantApiKey: API_KEY,
    cookieSecure: false,
    trustProxy: false,
    pollIntervalSeconds: 30,
    now: h.clock.now,
    demo: demo
      ? createSimulatorControls({ chain: h.chain, watcher: h.watcher, dispatcher, store: h.store, lock: new Mutex(), watchAddresses: [SIM_ADDRESS] })
      : undefined,
    ...rest,
  });
  await h.watcher.pollOnce(); // initialise the cursor
  return { h, app };
}

async function login(server: FastifyInstance, password = PASSWORD) {
  const res = await server.inject({ method: 'POST', url: '/admin/api/login', payload: { username: 'admin', password } });
  const cookie = [res.headers['set-cookie']].flat().find((c) => c?.startsWith('sid='));
  return { res, cookie: cookie?.split(';')[0] ?? '', csrf: (res.json() as { csrf_token?: string }).csrf_token ?? '' };
}

describe('public endpoints and headers', () => {
  it('serves /healthz with security headers', async () => {
    const { app } = await setup();
    const res = await app.inject('/healthz');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', mode: 'testnet' });
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns JSON 404 for unknown API routes', async () => {
    const { app } = await setup();
    expect((await app.inject('/admin/api/nope')).statusCode).toBe(404);
  });
});

describe('admin authentication', () => {
  it('rejects admin API calls without a session', async () => {
    const { app } = await setup();
    expect((await app.inject('/admin/api/orders')).statusCode).toBe(401);
    expect((await app.inject('/admin/api/health')).statusCode).toBe(401);
  });

  it('logs in with a secure cookie, and audits failed and successful logins', async () => {
    const { app, h } = await setup();
    const bad = await login(app, 'wrong password!!');
    expect(bad.res.statusCode).toBe(401);
    expect(bad.res.json()).toEqual({ error: 'Invalid username or password' });

    const good = await login(app);
    expect(good.res.statusCode).toBe(200);
    const raw = [good.res.headers['set-cookie']].flat().join(';');
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Strict');

    const session = await app.inject({ url: '/admin/api/session', headers: { cookie: good.cookie } });
    expect(session.json()).toMatchObject({ authenticated: true, username: 'admin', mode: 'testnet', demo_credentials: null });

    const audit = await h.store.listAudit('admin', 'admin');
    expect(audit.map((a) => a.action)).toEqual(['login_failed', 'login_success']);
  }, 20_000);

  it('does not reveal whether a username exists', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/admin/api/login', payload: { username: 'nobody', password: 'x' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Invalid username or password' });
  }, 20_000);

  it('rate-limits login attempts', async () => {
    const { app } = await setup();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/admin/api/login', payload: { username: 'nobody', password: 'x' } })).statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes[5]).toBe(429);
  }, 30_000);

  it('requires the CSRF token on every state-changing admin request', async () => {
    const { app } = await setup();
    const { cookie, csrf } = await login(app);
    const payload = { amount: '10.00', network: 'simulated' };
    const noToken = await app.inject({ method: 'POST', url: '/admin/api/orders', headers: { cookie }, payload });
    expect(noToken.statusCode).toBe(403);
    const wrong = await app.inject({ method: 'POST', url: '/admin/api/orders', headers: { cookie, 'x-csrf-token': 'nope' }, payload });
    expect(wrong.statusCode).toBe(403);
    const ok = await app.inject({ method: 'POST', url: '/admin/api/orders', headers: { cookie, 'x-csrf-token': csrf }, payload });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ base_amount: '10.000000', status: 'pending' });
  }, 20_000);

  it('ends the session on logout', async () => {
    const { app } = await setup();
    const { cookie, csrf } = await login(app);
    expect((await app.inject({ method: 'POST', url: '/admin/api/logout', headers: { cookie, 'x-csrf-token': csrf } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/admin/api/orders', headers: { cookie } })).statusCode).toBe(401);
  }, 20_000);

  it('expires sessions after their lifetime', async () => {
    const { app, h } = await setup();
    const { cookie } = await login(app);
    h.clock.advanceMinutes(8 * 60 + 1);
    expect((await app.inject({ url: '/admin/api/orders', headers: { cookie } })).statusCode).toBe(401);
  }, 20_000);
});

describe('merchant REST API', () => {
  const auth = { authorization: `Bearer ${API_KEY}` };

  it('requires the API key', async () => {
    const { app } = await setup();
    const payload = { amount: '10.00', network: 'simulated' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/orders', payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/orders', payload, headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
  });

  it('is disabled when no API key is configured', async () => {
    const { app } = await setup({ merchantApiKey: undefined });
    const res = await app.inject({ method: 'POST', url: '/api/v1/orders', payload: {}, headers: auth });
    expect(res.statusCode).toBe(503);
  });

  it('creates an order, and replays it for the same Idempotency-Key', async () => {
    const { app } = await setup();
    const headers = { ...auth, 'idempotency-key': 'checkout-12345' };
    const first = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: { amount: '49.99', network: 'simulated', external_ref: 'INV-1' } });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({ method: 'POST', url: '/api/v1/orders', headers, payload: { amount: '49.99', network: 'simulated', external_ref: 'INV-1' } });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const body = first.json();
    expect(body.external_ref).toBe('INV-1');
    expect(body.amount).toMatch(/^49\.99\d{4}$/); // unique payable amount
    const got = await app.inject({ url: `/api/v1/orders/${body.id}`, headers: auth });
    expect(got.json()).toMatchObject({ id: body.id, status: 'pending', paid_total: '0.000000', payments: [] });
  });

  it('validates input', async () => {
    const { app } = await setup();
    const bad = async (payload: unknown) => (await app.inject({ method: 'POST', url: '/api/v1/orders', headers: auth, payload: payload as object })).statusCode;
    expect(await bad({ amount: '1.234', network: 'simulated' })).toBe(400); // max 2 decimals
    expect(await bad({ amount: '-5', network: 'simulated' })).toBe(400);
    expect(await bad({ amount: 10, network: 'simulated' })).toBe(400); // numbers (floats) refused
    expect(await bad({ amount: '10', network: 'dogecoin' })).toBe(400);
    expect(await bad({ amount: '10', network: 'simulated', external_ref: '<script>' })).toBe(400);
    const badKey = await app.inject({ method: 'POST', url: '/api/v1/orders', headers: { ...auth, 'idempotency-key': 'x' }, payload: { amount: '10', network: 'simulated' } });
    expect(badKey.statusCode).toBe(400);
    expect((await app.inject({ url: '/api/v1/orders/not-an-id', headers: auth })).statusCode).toBe(400);
  });
});

describe('admin review actions', () => {
  it('accepts an underpaid order with a reason, and refuses illegal actions', async () => {
    const { app, h } = await setup();
    const { cookie, csrf } = await login(app);
    const headers = { cookie, 'x-csrf-token': csrf };
    const order = await h.orders.createOrder({ amount: '20.00', network: 'simulated' });
    await payAndPoll(h, order.receivingAddress, order.payableAmount - parseAmount('1.00'), 3);
    await h.watcher.pollOnce();

    const review = await app.inject({ url: '/admin/api/review', headers: { cookie } });
    expect(review.json().orders.map((o: { id: string }) => o.id)).toEqual([order.id]);

    const noReason = await app.inject({ method: 'POST', url: `/admin/api/orders/${order.id}/accept`, headers, payload: {} });
    expect(noReason.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/admin/api/orders/${order.id}/accept`, headers, payload: { reason: 'Customer paid the rest by bank' } });
    expect(ok.statusCode).toBe(200);
    expect((await h.store.getOrder(order.id))!.status).toBe('confirmed');

    // A confirmed order can not be cancelled.
    const cancel = await app.inject({ method: 'POST', url: `/admin/api/orders/${order.id}/cancel`, headers, payload: { reason: 'try to cancel' } });
    expect(cancel.statusCode).toBe(409);

    const detail = await app.inject({ url: `/admin/api/orders/${order.id}`, headers: { cookie } });
    const actions = detail.json().audit.map((a: { action: string }) => a.action);
    expect(actions).toContain('manual_accept');
    expect(detail.json().payments).toHaveLength(1);
  }, 20_000);

  it('dismisses an unmatched payment', async () => {
    const { app, h } = await setup();
    const { cookie, csrf } = await login(app);
    await payAndPoll(h, SIM_ADDRESS, parseAmount('3.21'), 3);
    const review = await app.inject({ url: '/admin/api/review', headers: { cookie } });
    const [payment] = review.json().payments;
    expect(payment.status).toBe('unmatched');
    const res = await app.inject({ method: 'POST', url: `/admin/api/payments/${payment.id}/dismiss`, headers: { cookie, 'x-csrf-token': csrf }, payload: { reason: 'Our own test transfer' } });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ url: '/admin/api/review', headers: { cookie } })).json().payments).toHaveLength(0);
  }, 20_000);
});

describe('reports, exports and health', () => {
  it('builds a reconciliation report and CSV exports', async () => {
    const { app, h } = await setup();
    const { cookie } = await login(app);
    const order = await h.orders.createOrder({ amount: '15.00', network: 'simulated' });
    await payAndPoll(h, order.receivingAddress, order.payableAmount, 3);
    await h.watcher.pollOnce();

    const day = h.clock.now().toISOString().slice(0, 10);
    const report = await app.inject({ url: `/admin/api/reports/reconciliation?period=day&date=${day}`, headers: { cookie } });
    const net = report.json().networks[0];
    expect(net).toMatchObject({ network: 'simulated', ordersCreated: 1, depositsCount: 1, unmatchedCount: 0 });
    expect(net.confirmedReceivedTotal).toBe(net.requestedTotal);

    const csv = await app.inject({ url: `/admin/api/exports/orders.csv?from=${day}&to=${day}`, headers: { cookie } });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.headers['content-disposition']).toContain(`orders_${day}_${day}.csv`);
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toMatch(/^order_id,external_ref,/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(order.id);

    const payments = await app.inject({ url: `/admin/api/exports/payments.csv?from=${day}&to=${day}`, headers: { cookie } });
    expect(payments.body.trim().split('\r\n')).toHaveLength(2);

    expect((await app.inject({ url: '/admin/api/exports/orders.csv?from=2026-02-01&to=2026-01-01', headers: { cookie } })).statusCode).toBe(400);
    expect((await app.inject({ url: '/admin/api/exports/orders.csv?from=bad&to=2026-01-01', headers: { cookie } })).statusCode).toBe(400);
  }, 20_000);

  it('reports watcher health', async () => {
    const { app } = await setup();
    const { cookie } = await login(app);
    const res = await app.inject({ url: '/admin/api/health', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const [w] = res.json().watchers;
    expect(w).toMatchObject({ network: 'simulated', healthy: true, last_error: null, required_confirmations: 3 });
  }, 20_000);
});

describe('demo controls', () => {
  it('are not registered outside demo mode', async () => {
    const { app } = await setup();
    const { cookie, csrf } = await login(app);
    const res = await app.inject({ method: 'POST', url: '/admin/api/demo/mine', headers: { cookie, 'x-csrf-token': csrf }, payload: { blocks: 1 } });
    expect(res.statusCode).toBe(404);
  }, 20_000);

  it('pay and mine on the simulated chain until the order is confirmed', async () => {
    const { app, h } = await setup({ demoMode: true });
    const { cookie, csrf } = await login(app);
    const headers = { cookie, 'x-csrf-token': csrf };
    const order = await h.orders.createOrder({ amount: '12.00', network: 'simulated' });

    const pay = await app.inject({ method: 'POST', url: '/admin/api/demo/pay', headers, payload: { order_id: order.id, kind: 'exact' } });
    expect(pay.statusCode).toBe(200);
    expect(['detected', 'confirming']).toContain((await h.store.getOrder(order.id))!.status);

    await app.inject({ method: 'POST', url: '/admin/api/demo/mine', headers, payload: { blocks: 3 } });
    expect((await h.store.getOrder(order.id))!.status).toBe('confirmed');

    const tooMany = await app.inject({ method: 'POST', url: '/admin/api/demo/mine', headers, payload: { blocks: 500 } });
    expect(tooMany.statusCode).toBe(400);
  }, 20_000);

  it('a reorg returns an unconfirmed order to pending', async () => {
    const { app, h } = await setup({ demoMode: true });
    const { cookie, csrf } = await login(app);
    const headers = { cookie, 'x-csrf-token': csrf };
    const order = await h.orders.createOrder({ amount: '7.00', network: 'simulated' });
    await app.inject({ method: 'POST', url: '/admin/api/demo/pay', headers, payload: { order_id: order.id, kind: 'exact' } });
    await app.inject({ method: 'POST', url: '/admin/api/demo/reorg', headers, payload: { depth: 1 } });
    expect((await h.store.getOrder(order.id))!.status).toBe('pending');
  }, 20_000);

  it('caps the number of demo orders', async () => {
    const { app } = await setup({ demoMode: true, demoOrderLimit: 1 });
    const { cookie, csrf } = await login(app);
    const headers = { cookie, 'x-csrf-token': csrf };
    const payload = { amount: '5.00', network: 'simulated' };
    expect((await app.inject({ method: 'POST', url: '/admin/api/orders', headers, payload })).statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/admin/api/orders', headers, payload })).statusCode).toBe(429);
  }, 20_000);
});
