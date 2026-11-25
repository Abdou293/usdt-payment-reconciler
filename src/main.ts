// Main process: chain watchers + notification dispatcher + Telegram bot.
// Run with `npm run dev`. (Phase 5 adds the HTTP API and dashboard here.)
//
// Free-host friendly: every loop resumes from state saved in the database,
// so a restart or a sleeping host never loses payments or notifications.

import { createBot } from './bot/createBot.js';
import { loadEnv } from './config/env.js';
import { buildRuntime } from './config/runtime.js';

const env = loadEnv();
const runtime = buildRuntime(env);

console.log(`Mode: ${env.APP_MODE}. Watch-only: no private keys are used or accepted.`);
if (env.APP_MODE === 'mainnet') {
  console.log('*** MAINNET READ-ONLY MODE: watching public data only. Not audited. Use at your own risk. ***');
}
for (const w of runtime.warnings) console.warn(`WARNING: ${w}`);
for (const n of runtime.networks) {
  console.log(`Watching ${n.label}: ${n.settings.watchAddresses.join(', ')} (${n.settings.requiredConfirmations} confirmations)`);
}
console.log(`Telegram: ${env.TELEGRAM_BOT_TOKEN ? 'enabled' : 'disabled'} | Webhook: ${env.WEBHOOK_URL ? 'enabled' : 'disabled'}`);

let stopping = false;

async function watchLoop(): Promise<void> {
  while (!stopping) {
    for (const n of runtime.networks) {
      const results = await n.watcher.catchUp(20);
      const last = results.at(-1);
      if (last && !last.ok) console.error(`[${n.settings.network}] poll failed: ${last.error}`);
      else if (last && results.some((r) => r.transfersSeen > 0)) {
        console.log(`[${n.settings.network}] up to block ${last.toBlock}: ${results.reduce((s, r) => s + r.transfersSeen, 0)} transfer(s)`);
      }
    }
    await runDispatcher();
    await sleep(env.POLL_INTERVAL_SECONDS * 1000);
  }
}

async function runDispatcher(): Promise<void> {
  try {
    const r = await runtime.dispatcher.runOnce();
    if (r.sent || r.failed || r.retried) console.log(`[notify] sent=${r.sent} retried=${r.retried} failed=${r.failed}`);
  } catch (error) {
    console.error('[notify] dispatcher error:', (error as Error).message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const bot = env.TELEGRAM_BOT_TOKEN ? createBot(env.TELEGRAM_BOT_TOKEN, runtime.botHandlers) : null;
if (bot) {
  // Long polling: simple and works behind any host. The bot only reads commands.
  void bot.start({ drop_pending_updates: true, onStart: (me) => console.log(`Telegram bot @${me.username} started`) });
}

async function shutdown(): Promise<void> {
  stopping = true;
  if (bot) await bot.stop();
  runtime.store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await watchLoop();
