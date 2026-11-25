// HMAC-SHA256 webhook signatures.
//
// Header sent with every webhook:
//   X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
//
// Including the timestamp in the signed text stops replay attacks: an attacker
// who captured an old webhook cannot resend it later, because the receiver
// rejects timestamps older than the tolerance (default 5 minutes).
// Merchants verify with `verifyWebhookSignature` (see examples/webhook-receiver.ts).

import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-signature';
export const EVENT_ID_HEADER = 'x-event-id';

export function signWebhook(secret: string, rawBody: string, timestampSeconds: number): string {
  const digest = createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
  return `t=${timestampSeconds},v1=${digest}`;
}

export type VerifyResult = { valid: true } | { valid: false; reason: string };

export function verifyWebhookSignature(
  secret: string,
  header: string | undefined | null,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
): VerifyResult {
  if (!header) return { valid: false, reason: 'missing signature header' };
  const parts = new Map(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) {
    return { valid: false, reason: 'malformed signature header' };
  }
  if (Math.abs(nowSeconds - t) > toleranceSeconds) {
    return { valid: false, reason: 'timestamp outside tolerance (possible replay)' };
  }
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const received = Buffer.from(v1, 'hex');
  // Constant-time comparison so attackers can't guess the signature byte by byte.
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return { valid: false, reason: 'signature mismatch' };
  }
  return { valid: true };
}
