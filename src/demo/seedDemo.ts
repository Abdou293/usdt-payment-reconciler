// Demo data: one week of realistic history on SIMULATED chains (one fake chain
// per network in the demo: TRON, BSC, Ethereum, Arbitrum).
// No real wallet, chain or money is involved.
//
// The seed runs the REAL services (OrderService, PaymentProcessor, ChainWatcher)
// with a fake clock that starts 7 days ago, so every order, payment, status
// change and audit entry is produced by the same code a real merchant runs.

import { SimulatedChainAdapter, SIMULATED_USDT_CONTRACT } from '../chains/simulated/SimulatedChainAdapter.js';
import { parseAmount } from '../core/money.js';
import type { Network, Order } from '../core/types.js';
import type { Store } from '../db/Store.js';
import type { ServiceConfig } from '../services/config.js';
import { OrderService } from '../services/OrderService.js';
import { PaymentProcessor } from '../services/PaymentProcessor.js';
import { ChainWatcher } from '../workers/ChainWatcher.js';

export const DEMO_START_BLOCK = 1000;
export const DEMO_OTHER_TOKEN = 'SIM-OTHER-TOKEN-NOT-USDT';

type Kind = 'exact' | 'under' | 'over' | 'base';

const AMOUNTS = ['25.00', '49.99', '120.00', '15.50', '300.00', '75.25', '9.99', '60.00', '210.00', '35.00'];

class SeedClock {
  constructor(private t: number) {}
  now = (): Date => new Date(this.t);
  advance(minutes: number): void {
    this.t += minutes * 60_000;
  }
}

export interface SeedResult {
  seeded: boolean;
  orders: number;
  /** Last scanned block per simulated network, so the live chains continue from there. */
  latestBlocks: Map<Network, number | null>;
}

/** Seed the database once (only when it has no orders yet). */
export async function seedDemo(store: Store, config: ServiceConfig, realNow: Date = new Date()): Promise<SeedResult> {
  const networks = [...config.networks.values()];
  if (networks.length === 0) throw new Error('Demo seed needs at least one simulated network');
  if ((await store.listOrders({ limit: 1, offset: 0 })).total > 0) {
    const latestBlocks = new Map<Network, number | null>();
    for (const n of networks) latestBlocks.set(n.network, (await store.getChainState(n.network)).latestBlock);
    return { seeded: false, orders: 0, latestBlocks };
  }

  // Day 0 starts exactly 7 days ago; each day's activity fits well inside 24h,
  // so no seeded timestamp is ever in the future.
  const DAY_MS = 86_400_000;
  const startOfFirstDay = realNow.getTime() - 7 * DAY_MS;
  const clock = new SeedClock(startOfFirstDay);
  const orders = new OrderService(store, config, clock.now);
  const processor = new PaymentProcessor(store, config, clock.now);
  const sims = networks.map((settings) => {
    const chain = new SimulatedChainAdapter({ network: settings.network, startBlock: DEMO_START_BLOCK, now: clock.now });
    const watcher = new ChainWatcher(chain, store, processor, {
      usdtContract: SIMULATED_USDT_CONTRACT,
      watchAddresses: settings.watchAddresses,
      requiredConfirmations: settings.requiredConfirmations,
      startBlock: DEMO_START_BLOCK,
      maxBlocksPerPoll: 1000,
      now: clock.now,
    });
    return { settings, chain, watcher };
  });
  const simFor = (network: Network) => sims.find((x) => x.settings.network === network)!;
  /** Spread the orders over the networks (the first one, TRON in the demo, gets the most). */
  const pick = (n: number) => sims[[0, 1, 0, 2, 3, 0, 1][n % 7]! % sims.length]!;
  /** Blocks to wait so a payment on this network is confirmed. */
  const settle = (network: Network) => tick(simFor(network).settings.requiredConfirmations + 1);

  /** Let time pass: mine one block per step on every chain and run the watchers. */
  const tick = async (steps = 1, minutesPerStep = 1) => {
    for (let i = 0; i < steps; i++) {
      clock.advance(minutesPerStep);
      for (const x of sims) {
        x.chain.mine(1);
        await x.watcher.pollOnce();
      }
    }
  };
  const pay = (order: Order, amount: bigint, from: string, tokenContract?: string) =>
    simFor(order.network).chain.sendTransfer({ toAddress: order.receivingAddress, amount, fromAddress: from, tokenContract });

  for (const x of sims) await x.watcher.pollOnce(); // initialise the cursors
  let created = 0;
  const underpaidIds: string[] = [];
  const unmatchedTx: string[] = [];

  for (let day = 0; day < 7; day++) {
    // Daily mix: mostly correct payments plus the edge cases this system handles.
    const plan: Kind[] = ['exact', 'exact', 'exact', 'exact'];
    if (day % 2 === 0) plan.push('under');
    if (day % 3 === 1) plan.push('over');
    if (day % 2 === 1) plan.push('base');
    if (day >= 4) plan.push('exact', 'exact');

    for (let i = 0; i < plan.length; i++) {
      const kind = plan[i]!;
      const amount = AMOUNTS[(day * 3 + i) % AMOUNTS.length]!;
      const order = await orders.createOrder({ amount, network: pick(day * 3 + i).settings.network, externalRef: `SHOP-${day + 1}${String(i + 1).padStart(2, '0')}` });
      created += 1;
      await tick(1, 3 + ((day + i) % 5)); // the customer takes a few minutes to pay
      const payer = `SIM-CUSTOMER-${(day * 10 + i) % 17}`;
      if (kind === 'exact') pay(order, order.payableAmount, payer);
      if (kind === 'under') {
        pay(order, order.payableAmount - parseAmount('2.00'), payer);
        underpaidIds.push(order.id);
      }
      if (kind === 'over') pay(order, order.payableAmount + parseAmount('5.00'), payer);
      if (kind === 'base') pay(order, order.baseAmount, payer); // payer dropped the unique cents
      await settle(order.network);
      clock.advance(25 + ((day * 7 + i * 11) % 60));
    }

    // An order nobody pays (expires) and one paid after its deadline (late).
    const expired = await orders.createOrder({ amount: AMOUNTS[day % AMOUNTS.length]!, network: pick(day + 1).settings.network, externalRef: `SHOP-${day + 1}90` });
    const late = day % 2 === 0
      ? await orders.createOrder({ amount: AMOUNTS[(day + 4) % AMOUNTS.length]!, externalRef: `SHOP-${day + 1}91`, network: pick(day + 3).settings.network, expiresInMinutes: 20 })
      : null;
    created += late ? 2 : 1;
    void expired;
    await tick(1, 45); // both deadlines pass -> expired
    if (late) {
      pay(late, late.payableAmount, 'SIM-CUSTOMER-LATE');
      await settle(late.network);
    }

    // A deposit that matches no order, and a token that is not USDT.
    if (day % 3 === 2) {
      const x = pick(day);
      const tx = x.chain.sendTransfer({ toAddress: x.settings.watchAddresses[0]!, amount: parseAmount(`${13 + day}.37`), fromAddress: 'SIM-UNKNOWN-SENDER' });
      unmatchedTx.push(tx);
      await settle(x.settings.network);
    }
    if (day === 3) {
      const x = pick(day + 1);
      x.chain.sendTransfer({ toAddress: x.settings.watchAddresses[0]!, amount: parseAmount('50.00'), fromAddress: 'SIM-CONFUSED-PAYER', tokenContract: DEMO_OTHER_TOKEN });
      await settle(x.settings.network);
    }

    // Jump to the next morning.
    const nextDay = startOfFirstDay + (day + 1) * DAY_MS;
    clock.advance(Math.max(1, Math.round((nextDay - clock.now().getTime()) / 60_000)));
  }

  // Show admin resolutions in the audit trail.
  if (underpaidIds[0]) {
    await processor.acceptOrderManually(underpaidIds[0], 'demo-admin', 'Customer paid the missing 2 USDT off-chain (demo)');
  }
  const unmatched = (await store.listPaymentsByStatus(['unmatched'])).find((p) => p.txHash === unmatchedTx[0]);
  if (unmatched) {
    await processor.dismissPaymentManually(unmatched.id, 'demo-admin', 'Test transfer from our own wallet (demo)');
  }

  // A few open orders that the visitor can "pay" with the demo buttons.
  const live = new OrderService(store, config, () => realNow);
  for (const [i, amount] of ['19.99', '45.00', '150.00', '72.50'].entries()) {
    await live.createOrder({ amount, network: sims[i % sims.length]!.settings.network, externalRef: `SHOP-OPEN-${i + 1}`, expiresInMinutes: 1440 });
    created += 1;
  }

  const latestBlocks = new Map<Network, number | null>();
  for (const x of sims) latestBlocks.set(x.settings.network, await x.chain.getLatestBlockNumber());
  return { seeded: true, orders: created, latestBlocks };
}
