// Password change, forgot-password (Telegram code) and emergency reset.

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthService, generateResetCode, normalizeResetCode, RESET_MAX_ATTEMPTS } from '../../src/http/auth.js';
import { buildServer } from '../../src/http/server.js';
import { createHarness } from '../helpers.js';

const OLD = 'correct horse battery';
const NEW = 'a brand new passphrase';

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

async function setup(opts: { telegram?: boolean; mode?: 'demo' | 'testnet' } = {}) {
  const h = createHarness();
  const sent: string[] = [];
  const channel = opts.telegram === false ? undefined : async (html: string) => void sent.push(html);
  const auth = new AuthService(h.store, h.clock.now, 8 * 60 * 60_000, channel);
  await auth.ensureInitialAdmin('admin', OLD);
  app = await buildServer({
    store: h.store,
    orders: h.orders,
    processor: h.processor,
    auth,
    networks: [{ settings: h.config.networks.get('simulated')!, adapter: h.chain, label: 'Simulated' }],
    explorerLink: () => null,
    mode: opts.mode ?? 'testnet',
    cookieSecure: false,
    trustProxy: false,
    pollIntervalSeconds: 30,
    now: h.clock.now,
  });
  /** The code is only ever in the Telegram message: read it from there, like the admin would. */
  const lastCode = () => /<code>([A-Z0-9]{5}-[A-Z0-9]{5})<\/code>/.exec(sent.at(-1) ?? '')?.[1] ?? '';
  return { h, app, auth, sent, lastCode };
}

async function login(server: FastifyInstance, password: string) {
  const res = await server.inject({ method: 'POST', url: '/admin/api/login', payload: { username: 'admin', password } });
  const cookie = [res.headers['set-cookie']].flat().find((c) => c?.startsWith('sid='));
  return { status: res.statusCode, cookie: cookie?.split(';')[0] ?? '', csrf: (res.json() as { csrf_token?: string }).csrf_token ?? '' };
}

const post = (server: FastifyInstance, url: string, payload: object, s?: { cookie: string; csrf: string }) =>
  server.inject({ method: 'POST', url, payload, headers: s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {} });

describe('reset codes', () => {
  it('generates readable, unique codes and normalises user input', () => {
    const codes = new Set(Array.from({ length: 200 }, generateResetCode));
    expect(codes.size).toBe(200);
    for (const c of codes) expect(c).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
    expect(normalizeResetCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
  });
});

describe('change password (logged in)', () => {
  it('needs the current password, keeps this session and logs out the others', async () => {
    const { app, h } = await setup();
    const here = await login(app, OLD);
    const elsewhere = await login(app, OLD);

    const wrong = await post(app, '/admin/api/password', { current_password: 'not the password', new_password: NEW }, here);
    expect(wrong.statusCode).toBe(401);
    expect((await post(app, '/admin/api/password', { current_password: OLD, new_password: 'short' }, here)).statusCode).toBe(400);
    expect((await post(app, '/admin/api/password', { current_password: OLD, new_password: OLD }, here)).statusCode).toBe(400);

    const ok = await post(app, '/admin/api/password', { current_password: OLD, new_password: NEW }, here);
    expect(ok.statusCode).toBe(200);

    expect((await app.inject({ url: '/admin/api/orders', headers: { cookie: here.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/admin/api/orders', headers: { cookie: elsewhere.cookie } })).statusCode).toBe(401);
    expect((await login(app, OLD)).status).toBe(401);
    expect((await login(app, NEW)).status).toBe(200);

    const actions = (await h.store.listAudit('admin', 'admin')).map((a) => a.action);
    expect(actions).toContain('password_change_failed');
    expect(actions).toContain('password_changed');
  });

  it('requires a session and the CSRF header', async () => {
    const { app } = await setup();
    expect((await post(app, '/admin/api/password', { current_password: OLD, new_password: NEW })).statusCode).toBe(401);
    const s = await login(app, OLD);
    const noCsrf = await app.inject({
      method: 'POST',
      url: '/admin/api/password',
      payload: { current_password: OLD, new_password: NEW },
      headers: { cookie: s.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('forgot password (code sent to Telegram)', () => {
  it('sends a code only to Telegram, and the code sets a new password once', async () => {
    const { app, h, sent, lastCode } = await setup();
    const oldSession = await login(app, OLD);

    const res = await post(app, '/admin/api/password/forgot', { username: 'admin' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/[A-Z0-9]{5}-[A-Z0-9]{5}/); // the code never goes to the browser
    expect(sent).toHaveLength(1);
    const code = lastCode();
    expect(code).not.toBe('');

    const ok = await post(app, '/admin/api/password/reset', { username: 'admin', code: code.toLowerCase(), new_password: NEW });
    expect(ok.statusCode).toBe(200);
    expect((await login(app, NEW)).status).toBe(200);
    // Every old session ended.
    expect((await app.inject({ url: '/admin/api/orders', headers: { cookie: oldSession.cookie } })).statusCode).toBe(401);
    // Used once only.
    const again = await post(app, '/admin/api/password/reset', { username: 'admin', code, new_password: 'yet another passphrase' });
    expect(again.statusCode).toBe(400);

    const actions = (await h.store.listAudit('admin', 'admin')).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['password_reset_requested', 'password_reset_completed']));
  });

  it('answers the same for unknown users and sends nothing', async () => {
    const { app, sent } = await setup();
    const known = await post(app, '/admin/api/password/forgot', { username: 'admin' });
    const unknown = await post(app, '/admin/api/password/forgot', { username: 'nobody' });
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.json()).toEqual(known.json());
    expect(sent).toHaveLength(1);
  });

  it('expires codes after 15 minutes', async () => {
    const { app, h, lastCode } = await setup();
    await post(app, '/admin/api/password/forgot', { username: 'admin' });
    h.clock.advanceMinutes(16);
    const res = await post(app, '/admin/api/password/reset', { username: 'admin', code: lastCode(), new_password: NEW });
    expect(res.statusCode).toBe(400);
    expect((await login(app, OLD)).status).toBe(200);
  });

  it('burns a code after too many wrong attempts', async () => {
    const { auth, sent, lastCode } = await setup();
    await auth.requestPasswordReset('admin', 'test');
    expect(sent).toHaveLength(1);
    for (let i = 0; i < RESET_MAX_ATTEMPTS; i++) {
      expect((await auth.resetPasswordWithCode('admin', 'WRONG-CODE1', NEW, 'test')).ok).toBe(false);
    }
    // Even the right code no longer works.
    expect((await auth.resetPasswordWithCode('admin', lastCode(), NEW, 'test')).ok).toBe(false);
  });

  it('only the newest code works, and at most 3 codes per hour are sent', async () => {
    const { auth, sent } = await setup();
    await auth.requestPasswordReset('admin', 'test');
    const first = /<code>([A-Z0-9-]{11})<\/code>/.exec(sent[0]!)![1]!;
    await auth.requestPasswordReset('admin', 'test');
    expect((await auth.resetPasswordWithCode('admin', first, NEW, 'test')).ok).toBe(false);
    expect(await auth.requestPasswordReset('admin', 'test')).toBe('sent');
    expect(await auth.requestPasswordReset('admin', 'test')).toBe('rate_limited');
    expect(sent).toHaveLength(3);
  });

  it('is off without Telegram and in the public demo', async () => {
    const off = await setup({ telegram: false });
    expect((await off.app.inject('/admin/api/session')).json().password_reset_available).toBe(false);
    expect((await post(off.app, '/admin/api/password/forgot', { username: 'admin' })).statusCode).toBe(404);
    await off.app.close();

    const demo = await setup({ mode: 'demo' });
    expect((await demo.app.inject('/admin/api/session')).json().password_reset_available).toBe(false);
    expect((await post(demo.app, '/admin/api/password/forgot', { username: 'admin' })).statusCode).toBe(403);
    const s = await login(demo.app, OLD);
    expect((await post(demo.app, '/admin/api/password', { current_password: OLD, new_password: NEW }, s)).statusCode).toBe(403);
  });
});

describe('emergency reset (ADMIN_RESET_PASSWORD)', () => {
  it('resets once per value and ends every session', async () => {
    const { app, auth } = await setup();
    const s = await login(app, OLD);
    expect(await auth.applyEmergencyReset('admin', NEW)).toBe('applied');
    expect((await app.inject({ url: '/admin/api/orders', headers: { cookie: s.cookie } })).statusCode).toBe(401);
    expect((await login(app, NEW)).status).toBe(200);

    // The admin then changes the password; a restart with the same variable must not undo it.
    const fresh = await login(app, NEW);
    await post(app, '/admin/api/password', { current_password: NEW, new_password: 'the final passphrase' }, fresh);
    expect(await auth.applyEmergencyReset('admin', NEW)).toBe('already_applied');
    expect((await login(app, 'the final passphrase')).status).toBe(200);
  });

  it('rejects a weak value', async () => {
    const { auth } = await setup();
    await expect(auth.applyEmergencyReset('admin', 'short')).rejects.toThrow(/12 characters/);
  });
});
