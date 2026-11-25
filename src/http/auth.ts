// Admin authentication.
// - Passwords: bcrypt (cost 12). Plain passwords are never stored or logged.
// - Sessions: random 256-bit id in an HttpOnly cookie; only its SHA-256 hash is
//   stored in the database. Each session also has a CSRF token that every
//   state-changing request must echo in the X-CSRF-Token header.
// - Login failures return one generic message and take the same time whether
//   or not the username exists (no username enumeration).
// - Password change: needs the current password; logs out every other session.
// - Forgot password: a one-time code is sent to the admin's Telegram chat
//   (never shown in the browser). Only its SHA-256 hash is stored; it expires
//   in 15 minutes, works once, and is burned after 5 wrong attempts.
// - Emergency reset: ADMIN_RESET_PASSWORD, set by whoever controls the server
//   (hosting settings or .env). Applied once per value at startup.

import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionRecord, Store } from '../db/Store.js';
import type { Clock } from '../services/config.js';

const BCRYPT_COST = 12;
const USERNAME = /^[a-zA-Z0-9_.-]{3,32}$/;
export const RESET_CODE_TTL_MS = 15 * 60_000;
export const RESET_MAX_ATTEMPTS = 5;
/** At most this many reset codes per user per hour (stops Telegram spam). */
export const RESET_MAX_PER_HOUR = 3;
// No 0/O or 1/I/L: easy to read on a phone and type back.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const EMERGENCY_META_KEY = 'admin_emergency_reset_bcrypt';

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Constant-time string comparison (via fixed-length hashes). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

export function validatePasswordPolicy(password: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters';
  if (password.length > 128) return 'Password must be at most 128 characters';
  return null;
}

/** Turns user input like " k7qpm-3zx9a " into the canonical form "K7QPM3ZX9A". */
export function normalizeResetCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** 10 random characters (about 49 bits), shown as XXXXX-XXXXX. No modulo bias. */
export function generateResetCode(): string {
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < 10) {
    for (const b of randomBytes(16)) {
      if (b < limit && out.length < 10) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    }
  }
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}

/** Sends a message to the admin (Telegram). Undefined = reset by code is turned off. */
export type ResetChannel = (html: string) => Promise<void>;

export type PasswordChangeResult = { ok: true } | { ok: false; status: 400 | 401; error: string };

export interface LoginResult {
  sessionId: string;
  csrfToken: string;
  username: string;
  expiresAt: Date;
}

export class AuthService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly store: Store,
    private readonly now: Clock = () => new Date(),
    private readonly sessionTtlMs = 8 * 60 * 60_000,
    private readonly resetChannel?: ResetChannel,
  ) {}

  get passwordResetAvailable(): boolean {
    return this.resetChannel !== undefined;
  }

  /** Create the first admin from configuration if no admin exists yet. */
  async ensureInitialAdmin(username: string, password: string): Promise<boolean> {
    if ((await this.store.countAdminUsers()) > 0) return false;
    if (!USERNAME.test(username)) throw new Error('ADMIN_USERNAME must be 3-32 letters, digits, . _ -');
    const problem = validatePasswordPolicy(password);
    if (problem) throw new Error(`ADMIN_INITIAL_PASSWORD: ${problem}`);
    await this.store.createAdminUser(username, await hashPassword(password), this.now());
    return true;
  }

  async login(username: string, password: string): Promise<LoginResult | null> {
    const user = USERNAME.test(username) ? await this.store.getAdminUser(username) : null;
    // Always run bcrypt, even for unknown users, so timing reveals nothing.
    const hash = user?.passwordHash ?? (await this.getDummyHash());
    const ok = await bcrypt.compare(password.slice(0, 128), hash);
    if (!user || !ok) return null;

    await this.store.deleteExpiredSessions(this.now());
    const sessionId = randomBytes(32).toString('base64url');
    const record: SessionRecord = {
      idHash: sha256(sessionId),
      username: user.username,
      csrfToken: randomBytes(32).toString('base64url'),
      createdAt: this.now(),
      expiresAt: new Date(this.now().getTime() + this.sessionTtlMs),
    };
    await this.store.createSession(record);
    return { sessionId, csrfToken: record.csrfToken, username: user.username, expiresAt: record.expiresAt };
  }

  async getSession(sessionId: string | undefined): Promise<SessionRecord | null> {
    if (!sessionId || sessionId.length > 100) return null;
    const session = await this.store.getSession(sha256(sessionId));
    if (!session) return null;
    if (session.expiresAt.getTime() <= this.now().getTime()) {
      await this.store.deleteSession(session.idHash);
      return null;
    }
    return session;
  }

  async logout(sessionId: string | undefined): Promise<void> {
    if (sessionId) await this.store.deleteSession(sha256(sessionId));
  }

  /** Logged-in password change. Keeps the current session and ends all others. */
  async changePassword(
    username: string,
    currentPassword: string,
    newPassword: string,
    currentSessionIdHash: string,
  ): Promise<PasswordChangeResult> {
    const user = await this.store.getAdminUser(username);
    if (!user || !(await bcrypt.compare(currentPassword.slice(0, 128), user.passwordHash))) {
      await this.audit(username, 'password_change_failed', username, { reason: 'wrong current password' });
      return { ok: false, status: 401, error: 'Current password is wrong' };
    }
    const problem = validatePasswordPolicy(newPassword);
    if (problem) return { ok: false, status: 400, error: problem };
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      return { ok: false, status: 400, error: 'New password must be different from the current one' };
    }
    await this.store.updateAdminPassword(username, await hashPassword(newPassword));
    await this.store.deleteSessionsForUser(username, currentSessionIdHash);
    await this.store.closePasswordResets(username, this.now());
    await this.audit(username, 'password_changed', username, { other_sessions_ended: true });
    return { ok: true };
  }

  /**
   * Forgot password, step 1: send a one-time code to the admin's Telegram.
   * The HTTP route answers the same way whatever this returns, so a visitor
   * cannot learn whether a username exists. The result is for logs and tests.
   */
  async requestPasswordReset(username: string, requestedBy: string): Promise<'sent' | 'ignored' | 'rate_limited'> {
    if (!this.resetChannel || !USERNAME.test(username)) return 'ignored';
    const user = await this.store.getAdminUser(username);
    if (!user) return 'ignored';
    const now = this.now();
    const hourAgo = new Date(now.getTime() - 60 * 60_000);
    if ((await this.store.countRecentPasswordResets(username, hourAgo)) >= RESET_MAX_PER_HOUR) {
      await this.audit(username, 'password_reset_rate_limited', requestedBy, null);
      return 'rate_limited';
    }
    const code = generateResetCode();
    await this.store.closePasswordResets(username, now); // only the newest code works
    await this.store.createPasswordReset({
      username,
      codeHash: sha256(normalizeResetCode(code)),
      createdAt: now,
      expiresAt: new Date(now.getTime() + RESET_CODE_TTL_MS),
    });
    await this.resetChannel(
      [
        `🔑 <b>Password reset code</b> for <code>${username}</code>:`,
        '',
        `<code>${code}</code>`,
        '',
        'It works once and expires in 15 minutes.',
        'If you did not ask for this, ignore it: your password has not changed.',
      ].join('\n'),
    );
    await this.audit(username, 'password_reset_requested', requestedBy, null);
    return 'sent';
  }

  /** Forgot password, step 2: check the code and set the new password. Ends every session. */
  async resetPasswordWithCode(
    username: string,
    code: string,
    newPassword: string,
    requestedBy: string,
  ): Promise<PasswordChangeResult> {
    const invalid: PasswordChangeResult = { ok: false, status: 400, error: 'Invalid or expired code' };
    if (!this.resetChannel || !USERNAME.test(username)) return invalid;
    const problem = validatePasswordPolicy(newPassword);
    if (problem) return { ok: false, status: 400, error: problem };

    const reset = await this.store.getActivePasswordReset(username, this.now());
    if (!reset) return invalid;
    if (reset.attempts >= RESET_MAX_ATTEMPTS) {
      await this.store.closePasswordResets(username, this.now());
      return invalid;
    }
    if (!safeEqual(sha256(normalizeResetCode(code.slice(0, 64))), reset.codeHash)) {
      await this.store.incrementPasswordResetAttempts(reset.id);
      await this.audit(username, 'password_reset_failed', requestedBy, { attempt: reset.attempts + 1 });
      return invalid;
    }
    await this.store.updateAdminPassword(username, await hashPassword(newPassword));
    await this.store.closePasswordResets(username, this.now());
    await this.store.deleteSessionsForUser(username);
    await this.audit(username, 'password_reset_completed', requestedBy, { all_sessions_ended: true });
    return { ok: true };
  }

  /**
   * Emergency reset by the server owner (ADMIN_RESET_PASSWORD). Applied once
   * per value: a bcrypt hash of the applied value is remembered, so leaving the
   * variable set does not undo a later password change on every restart.
   */
  async applyEmergencyReset(username: string, password: string): Promise<'applied' | 'already_applied'> {
    if (!USERNAME.test(username)) throw new Error('ADMIN_USERNAME must be 3-32 letters, digits, . _ -');
    const problem = validatePasswordPolicy(password);
    if (problem) throw new Error(`ADMIN_RESET_PASSWORD: ${problem}`);
    const applied = await this.store.getMeta(EMERGENCY_META_KEY);
    if (applied && (await bcrypt.compare(password, applied))) return 'already_applied';

    const hash = await hashPassword(password);
    if (await this.store.getAdminUser(username)) await this.store.updateAdminPassword(username, hash);
    else await this.store.createAdminUser(username, hash, this.now());
    await this.store.deleteSessionsForUser(username);
    await this.store.closePasswordResets(username, this.now());
    await this.store.setMeta(EMERGENCY_META_KEY, await hashPassword(password));
    await this.audit(username, 'password_emergency_reset', 'server:ADMIN_RESET_PASSWORD', { all_sessions_ended: true });
    return 'applied';
  }

  private audit(username: string, action: string, actor: string, details: Record<string, unknown> | null): Promise<void> {
    return this.store.addAudit({
      entityType: 'admin',
      entityId: username,
      action,
      fromStatus: null,
      toStatus: null,
      actor,
      details,
      createdAt: this.now(),
    });
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    return this.dummyHash;
  }
}
