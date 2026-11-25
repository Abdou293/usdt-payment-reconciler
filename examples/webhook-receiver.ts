// Example: how a MERCHANT verifies webhooks from this system.
// Run: WEBHOOK_SECRET=... npx tsx examples/webhook-receiver.ts
// Then set WEBHOOK_URL=http://localhost:4000/webhook in the system's .env.

import { createServer } from 'node:http';
import { EVENT_ID_HEADER, SIGNATURE_HEADER, verifyWebhookSignature } from '../src/notifications/webhookSignature.js';

const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error('Set WEBHOOK_SECRET (the same value as in the system .env)');

const processedEventIds = new Set<string>(); // use your database in production

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    // Verify against the RAW body bytes, before parsing JSON.
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const check = verifyWebhookSignature(secret, req.headers[SIGNATURE_HEADER] as string | undefined, rawBody);
    if (!check.valid) {
      console.warn(`Rejected webhook: ${check.reason}`);
      res.writeHead(401).end();
      return;
    }
    // Webhooks can be delivered more than once (retries): de-duplicate by event id.
    const eventId = String(req.headers[EVENT_ID_HEADER]);
    if (!processedEventIds.has(eventId)) {
      processedEventIds.add(eventId);
      const event = JSON.parse(rawBody) as { type: string; data: { order_id: string; external_ref: string | null } };
      console.log(`Verified ${event.type} for order ${event.data.order_id} (your ref: ${event.data.external_ref})`);
      // -> mark the order as paid in your shop here
    }
    res.writeHead(200).end('ok');
  });
}).listen(4000, () => console.log('Webhook receiver listening on http://localhost:4000/webhook'));
