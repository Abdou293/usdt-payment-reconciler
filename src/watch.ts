// Standalone watcher process: `npm run watch`.
// Polls every configured chain, resuming from the saved cursor after any restart.
// (Phase 4/5 run the same loop inside the web server.)

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

let stopping = false;
async function loop(): Promise<void> {
  while (!stopping) {
    for (const n of runtime.networks) {
      const results = await n.watcher.catchUp(20);
      const last = results.at(-1);
      if (last?.ok) {
        console.log(`[${n.settings.network}] blocks ${results[0]!.fromBlock}-${last.toBlock} of ${last.latestBlock}, transfers=${results.reduce((s, r) => s + r.transfersSeen, 0)}`);
      } else if (last) {
        console.error(`[${n.settings.network}] poll failed: ${last.error}`);
      }
    }
    await new Promise((r) => setTimeout(r, env.POLL_INTERVAL_SECONDS * 1000));
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    runtime.store.close();
    process.exit(0);
  });
}

await loop();
