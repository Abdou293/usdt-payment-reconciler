// Admin authentication.
// - Passwords: bcrypt (cost 12). Plain passwords are never stored or logged.
// - Sessions: random 256-bit id in an HttpOnly cookie; only its SHA-256 hash is
//   stored in the database. Each session also has a CSRF token that every
//   state-changing request must echo in the X-CSRF-Token header.
// - Login failures return one generic message and take the same time whether
//   or not the username exists (no username enumeration).

import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionRecord, Store } from '../db/Store.js';
import type { Clock } from '../services/config.js';

const BCRYPT_COST = 12;
const USERNAME = /^[a-zA-Z0-9_.-]{3,32}$/;

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
  ) {}

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

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
    return this.dummyHash;
  }
}
