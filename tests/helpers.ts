// Test harness: an in-memory (or file) database, a controllable clock,
// a simulated chain, and all services wired together.

import { SimulatedChainAdapter, SIMULATED_USDT_CONTRACT } from '../src/chains/simulated/SimulatedChainAdapter.js';
import { parseAmount } from '../src/core/money.js';
import type { Network } from '../src/core/types.js';
import { SqliteStore } from '../src/db/SqliteStore.js';
import type { ServiceConfig, WatchedNetwork } from '../src/services/config.js';
import { OrderService } from '../src/services/OrderService.js';
import { PaymentProcessor, type OrderStatusChange, type ReviewAlert } from '../src/services/PaymentProcessor.js';
import { ChainWatcher } from '../src/workers/ChainWatcher.js';

export const SIM_ADDRESS = 'SIM-MERCHANT-ADDRESS-1';
export const SIM_ADDRESS_2 = 'SIM-MERCHANT-ADDRESS-2';
export const TRON_ADDRESS = 'TFakeWatchOnlyAddressForTests000001';
export const REQUIRED_CONFIRMATIONS = 3;

export class TestClock {
  private current: number;
  constructor(start = '2026-01-01T12:00:00.000Z') {
    this.current = new Date(start).getTime();
  }
  now = (): Date => new Date(this.current);
  advanceMinutes(minutes: number): void {
    this.current += minutes * 60_000;
  }
}

export interface HarnessOptions {
  dbPath?: string;
  underpayTolerance?: string;
  overpayTolerance?: string;
  addresses?: string[];
  maxBlocksPerPoll?: number;
  clock?: TestClock;
  chain?: SimulatedChainAdapter;
}

export function createHarness(options: HarnessOptions = {}) {
  const clock = options.clock ?? new TestClock();
  const store = new SqliteStore(options.dbPath ?? ':memory:');

  const simulated: WatchedNetwork = {
    network: 'simulated',
    usdtContract: SIMULATED_USDT_CONTRACT,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
    watchAddresses: options.addresses ?? [SIM_ADDRESS],
  };
  // A second network configured only so we can test "wrong network" payments.
  const tron: WatchedNetwork = {
    network: 'tron',
    usdtContract: 'TEST-TRON-USDT-CONTRACT',
    requiredConfirmations: 19,
    watchAddresses: [TRON_ADDRESS],
  };

  const config: ServiceConfig = {
    networks: new Map<Network, WatchedNetwork>([
      ['simulated', simulated],
      ['tron', tron],
    ]),
    payment: {
      underpayToleranceUnits: parseAmount(options.underpayTolerance ?? '0'),
      overpayToleranceUnits: parseAmount(options.overpayTolerance ?? '0'),
      lateReservationMinutes: 24 * 60,
    },
    defaultExpiryMinutes: 30,
  };

  const chain = options.chain ?? new SimulatedChainAdapter({ now: clock.now });
  const orders = new OrderService(store, config, clock.now);
  const processor = new PaymentProcessor(store, config, clock.now);
  const watcher = new ChainWatcher(chain, store, processor, {
    usdtContract: SIMULATED_USDT_CONTRACT,
    watchAddresses: simulated.watchAddresses,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
    startBlock: 100,
    maxBlocksPerPoll: options.maxBlocksPerPoll ?? 1000,
    now: clock.now,
  });

  const statusEvents: OrderStatusChange[] = [];
  const reviewAlerts: ReviewAlert[] = [];
  processor.onStatusChange((e) => void statusEvents.push(e));
  processor.onReviewAlert((a) => void reviewAlerts.push(a));

  return { clock, store, config, chain, orders, processor, watcher, statusEvents, reviewAlerts };
}

/** Send a transfer, mine it, and let the watcher process it. */
export async function payAndPoll(
  h: ReturnType<typeof createHarness>,
  toAddress: string,
  amount: bigint,
  extraBlocks = 0,
): Promise<string> {
  const txHash = h.chain.sendTransfer({ toAddress, amount });
  h.chain.mine(1 + extraBlocks);
  await h.watcher.pollOnce();
  return txHash;
}
