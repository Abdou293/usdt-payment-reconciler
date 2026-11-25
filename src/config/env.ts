// Load and VALIDATE configuration from environment variables (.env).
// The app refuses to start with a bad config instead of running half-broken.

import { z } from 'zod';
import { isValidTronAddress } from '../chains/tron/address.js';

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Anything that looks like a private key or seed phrase is rejected outright. */
function looksLikeSecretKey(value: string): boolean {
  const v = value.trim();
  return /^(0x)?[0-9a-fA-F]{64}$/.test(v) || v.split(/\s+/).length >= 12;
}

const csv = (validate: (s: string) => boolean, label: string) =>
  z
    .string()
    .default('')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
    .superRefine((list, ctx) => {
      for (const item of list) {
        if (looksLikeSecretKey(item)) {
          ctx.addIssue({ code: 'custom', message: `${label}: this looks like a PRIVATE KEY or SEED PHRASE. Never put one here. Use public addresses only.` });
        } else if (!validate(item)) {
          ctx.addIssue({ code: 'custom', message: `${label}: invalid address "${item}"` });
        }
      }
    });

const optionalString = z
  .string()
  .optional()
  .transform((s) => (s && s.trim() !== '' ? s.trim() : undefined));

/** A secret value: optional, but placeholders copied from .env.example are refused. */
const secretString = optionalString.refine(
  (s) => s === undefined || !s.startsWith('replace_with'),
  'still contains the placeholder from .env.example',
);

function isAllowedWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

const booleanString = z
  .enum(['true', 'false', ''])
  .optional()
  .transform((s) => (s === 'true' ? true : s === 'false' ? false : undefined));

const amountUnits = z
  .string()
  .default('0')
  .refine((s) => /^\d{1,12}$/.test(s), 'must be a whole number of base units')
  .transform((s) => BigInt(s));

export const envSchema = z.object({
  APP_MODE: z.enum(['demo', 'testnet', 'mainnet']).default('demo'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .default('file:./data/app.db')
    .refine((s) => s.startsWith('file:'), 'only file: (SQLite) URLs are supported for now')
    .transform((s) => s.slice('file:'.length)),

  // ---- Admin dashboard + merchant API ----
  ADMIN_USERNAME: z.string().regex(/^[a-zA-Z0-9_.-]{3,32}$/, '3-32 letters, digits, . _ -').default('admin'),
  /** Only used once, to create the first admin (stored as a bcrypt hash). */
  ADMIN_INITIAL_PASSWORD: secretString.refine((s) => s === undefined || (s.length >= 12 && s.length <= 128), 'must be 12-128 characters'),
  /** Public demo login (APP_MODE=demo only). Shown on the login page on purpose. */
  DEMO_ADMIN_PASSWORD: z.string().min(12).max(128).default('demo-password-2026'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(8),
  COOKIE_SECURE: booleanString,
  TRUST_PROXY: booleanString,
  MERCHANT_API_KEY: secretString.refine((s) => s === undefined || s.length >= 32, 'must be at least 32 characters'),

  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),

  TRON_WATCH_ADDRESSES: csv(isValidTronAddress, 'TRON_WATCH_ADDRESSES'),
  TRONGRID_API_URL: optionalString,
  TRONGRID_API_KEY: optionalString,
  TRON_CONFIRMATIONS: z.coerce.number().int().min(1).max(200).default(19),
  TRON_START_BLOCK: z.coerce.number().int().min(0).optional(),

  EVM_WATCH_ADDRESSES: csv((s) => EVM_ADDRESS.test(s), 'EVM_WATCH_ADDRESSES').transform((l) =>
    l.map((a) => a.toLowerCase()),
  ),
  EVM_RPC_URL: optionalString,
  EVM_CONFIRMATIONS: z.coerce.number().int().min(1).max(1000).default(20),
  EVM_START_BLOCK: z.coerce.number().int().min(0).optional(),
  EVM_MAX_BLOCKS_PER_POLL: z.coerce.number().int().min(1).max(100_000).default(2000),
  /** Testnet only: a test token YOU deployed on Arbitrum Sepolia. Clearly unverified. */
  EVM_UNVERIFIED_TEST_TOKEN: optionalString.refine((s) => s === undefined || EVM_ADDRESS.test(s), 'invalid address'),

  ORDER_EXPIRY_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  UNDERPAY_TOLERANCE_UNITS: amountUnits,
  OVERPAY_TOLERANCE_UNITS: amountUnits,
  LATE_RESERVATION_MINUTES: z.coerce.number().int().min(0).max(10_080).default(1440),

  // ---- Telegram (optional) ----
  TELEGRAM_BOT_TOKEN: secretString.refine(
    (s) => s === undefined || /^\d{6,12}:[A-Za-z0-9_-]{30,50}$/.test(s),
    'does not look like a Telegram bot token from @BotFather',
  ),
  TELEGRAM_BOT_USERNAME: optionalString.refine((s) => s === undefined || /^[A-Za-z0-9_]{5,32}$/.test(s), 'invalid bot username (without @)'),
  TELEGRAM_ADMIN_CHAT_ID: optionalString.refine((s) => s === undefined || /^-?\d{1,20}$/.test(s), 'must be a numeric chat id'),

  // ---- Merchant webhook (optional) ----
  WEBHOOK_URL: optionalString.refine((s) => s === undefined || isAllowedWebhookUrl(s), 'must be https:// (http:// only for localhost)'),
  WEBHOOK_SECRET: secretString.refine((s) => s === undefined || s.length >= 32, 'must be at least 32 characters'),
}).superRefine((env, ctx) => {
  if (env.WEBHOOK_URL && !env.WEBHOOK_SECRET) {
    ctx.addIssue({ code: 'custom', path: ['WEBHOOK_SECRET'], message: 'required when WEBHOOK_URL is set' });
  }
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
