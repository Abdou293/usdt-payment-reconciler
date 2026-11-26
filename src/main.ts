// Main process: HTTP API + dashboard, chain watchers, notification dispatcher,
// and the optional Telegram bot. Run with `npm run dev` (or `npm start` after build).
//
// Free-host friendly: every loop resumes from state saved in the database,
// so a restart or a sleeping host never loses payments or notifications.

import { createBot } from './bot/createBot.js';
import { loadEnv } from './config/env.js';
import { buildRuntime } from './config/runtime.js';
import { Mutex } from './core/mutex.js';
import { seedDemo } from './demo/seedDemo.js';
import { createSimulatorControls } from './demo/SimulatorControls.js';
import { buildServer } from './http/server.js';

const DEMO_USERNAME = 'demo';
const DEMO_ORDER_LIMIT = 2000;

const env = loadEnv();
const runtime = buildRuntime(env);
const lock = new Mutex();
const isDemo = env.APP_MODE === 'demo';

console.log(`Mode: ${env.APP_MODE}. Watch-only: no private keys are used or accepted.`);
if (env.APP_MODE === 'mainnet') {
  console.log('*** MAINNET READ-ONLY MODE: watching public data only. Not audited. Use at your own risk. ***');
}
for (const w of runtime.warnings) console.warn(`WARNING: ${w}`);
for (const n of runtime.networks) {
  console.log(`Watching ${n.label}: ${n.settings.watchAddresses.join(', ')} (${n.settings.requiredConfirmations} confirmations)`);
}
console.log(`Telegram: ${env.TELEGRAM_BOT_TOKEN ? 'enabled' : 'disabled'} | Webhook: ${env.WEBHOOK_URL ? 'enabled' : 'disabled'}`);

// ---- Admin account ----
if (isDemo) {
  await runtime.auth.ensureInitialAdmin(DEMO_USERNAME, env.DEMO_ADMIN_PASSWORD);
} else if (env.ADMIN_INITIAL_PASSWORD) {
  if (await runtime.auth.ensureInitialAdmin(env.ADMIN_USERNAME, env.ADMIN_INITIAL_PASSWORD)) {
    console.log(`Created admin user "${env.ADMIN_USERNAME}". You can now remove ADMIN_INITIAL_PASSWORD from .env.`);
  }
} else if ((await runtime.store.countAdminUsers()) === 0 && !env.ADMIN_RESET_PASSWORD) {
  console.warn('WARNING: no admin user exists and ADMIN_INITIAL_PASSWORD is not set: nobody can log in to the dashboard.');
}

if (!isDemo && env.ADMIN_RESET_PASSWORD) {
  const r = await runtime.auth.applyEmergencyReset(env.ADMIN_USERNAME, env.ADMIN_RESET_PASSWORD);
  console.warn(
    r === 'applied'
      ? `Password of "${env.ADMIN_USERNAME}" was reset from ADMIN_RESET_PASSWORD and all sessions were ended. Remove ADMIN_RESET_PASSWORD now.`
      : 'ADMIN_RESET_PASSWORD was already applied earlier and was ignored. Remove it from the settings.',
  );
}
if (!isDemo) {
  console.log(`Forgot-password by Telegram: ${runtime.auth.passwordResetAvailable ? 'enabled' : 'disabled (needs TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_CHAT_ID)'}`);
}

// ---- Demo data ----
// One simulated chain per demo network (TRON, BSC, Ethereum, Arbitrum): all fake.
const demoChains = runtime.networks.flatMap((n) => {
  const chain = runtime.simulatedChains.get(n.settings.network);
  return chain ? [{ network: n.settings.network, chain, watcher: n.watcher, watchAddresses: n.settings.watchAddresses }] : [];
});
if (isDemo && demoChains.length > 0) {
  const seed = await seedDemo(runtime.store, runtime.config);
  if (seed.seeded) console.log(`Demo data seeded: ${seed.orders} orders on ${demoChains.length} simulated networks.`);
  // Continue each in-memory chain from where its saved cursor stopped.
  for (const c of demoChains) {
    const latest = seed.latestBlocks.get(c.network);
    if (latest !== null && latest !== undefined) c.chain.fastForwardTo(latest);
  }
  // Seeded history should not trigger notifications.
  if (seed.seeded) await runtime.dispatcher.skipExistingEvents();
}

// ---- HTTP server ----
const server = await buildServer({
  store: runtime.store,
  orders: runtime.orders,
  processor: runtime.processor,
  auth: runtime.auth,
  networks: runtime.networks,
  explorerLink: runtime.explorerLink,
  mode: env.APP_MODE,
  merchantApiKey: env.MERCHANT_API_KEY,
  botUsername: env.TELEGRAM_BOT_USERNAME,
  cookieSecure: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
  trustProxy: env.TRUST_PROXY ?? false,
  pollIntervalSeconds: env.POLL_INTERVAL_SECONDS,
  dashboardDir: 'dashboard/dist',
  demo:
    isDemo && demoChains.length > 0
      ? createSimulatorControls({ chains: demoChains, dispatcher: runtime.dispatcher, store: runtime.store, lock })
      : undefined,
  demoCredentials: isDemo ? { username: DEMO_USERNAME, password: env.DEMO_ADMIN_PASSWORD } : undefined,
  demoOrderLimit: DEMO_ORDER_LIMIT,
  logger: env.NODE_ENV === 'production',
});
await server.listen({ host: '0.0.0.0', port: env.PORT });
console.log(`HTTP server on http://localhost:${env.PORT} (dashboard + API)`);

// ---- Background loop ----
let stopping = false;

async function tick(): Promise<void> {
  await lock.run(async () => {
    // Demo: each simulated chain produces one block per tick, like a real chain.
    if (isDemo) for (const c of demoChains) c.chain.mine(1);
    for (const n of runtime.networks) {
      const results = await n.watcher.catchUp(20);
      const last = results.at(-1);
      if (last && !last.ok) console.error(`[${n.settings.network}] poll failed: ${last.error}`);
      else if (last && results.some((r) => r.transfersSeen > 0)) {
        console.log(`[${n.settings.network}] up to block ${last.toBlock}: ${results.reduce((s, r) => s + r.transfersSeen, 0)} transfer(s)`);
      }
    }
    try {
      const r = await runtime.dispatcher.runOnce();
      if (r.sent || r.failed || r.retried) console.log(`[notify] sent=${r.sent} retried=${r.retried} failed=${r.failed}`);
    } catch (error) {
      console.error('[notify] dispatcher error:', (error as Error).message);
    }
  });
}

async function loop(): Promise<void> {
  const intervalMs = (isDemo ? Math.min(env.POLL_INTERVAL_SECONDS, 10) : env.POLL_INTERVAL_SECONDS) * 1000;
  while (!stopping) {
    try {
      await tick();
    } catch (error) {
      console.error('[loop] unexpected error:', (error as Error).message);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const bot = env.TELEGRAM_BOT_TOKEN ? createBot(env.TELEGRAM_BOT_TOKEN, runtime.botHandlers) : null;
if (bot) {
  // Long polling: simple and works behind any host. The bot only reads commands.
  void bot.start({ drop_pending_updates: true, onStart: (me) => console.log(`Telegram bot @${me.username} started`) });
}

async function shutdown(): Promise<void> {
  stopping = true;
  if (bot) await bot.stop();
  await server.close();
  runtime.store.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await loop();
