// Buttons for the PUBLIC DEMO: "pay this order", "mine a block", "reorg".
// They only touch the in-memory SIMULATED chains (one fake chain per network). Never available in testnet or
// mainnet mode (the HTTP routes are registered only when APP_MODE=demo).

import { SimulatedChainAdapter } from '../chains/simulated/SimulatedChainAdapter.js';
import { parseAmount } from '../core/money.js';
import type { Network } from '../core/types.js';
import type { Mutex } from '../core/mutex.js';
import type { Store } from '../db/Store.js';
import type { DemoControls } from '../http/server.js';
import type { NotificationDispatcher } from '../notifications/NotificationDispatcher.js';
import type { ChainWatcher } from '../workers/ChainWatcher.js';
import { DEMO_OTHER_TOKEN } from './seedDemo.js';

class DemoError extends Error {
  readonly statusCode = 400;
}

/** One simulated chain in the demo (the demo runs one per network, all fake). */
export interface DemoChain {
  network: Network;
  chain: SimulatedChainAdapter;
  watcher: ChainWatcher;
  watchAddresses: readonly string[];
}

export function createSimulatorControls(deps: {
  chains: readonly DemoChain[];
  dispatcher: NotificationDispatcher;
  store: Store;
  lock: Mutex;
}): DemoControls {
  const { chains, dispatcher, store, lock } = deps;
  if (chains.length === 0) throw new Error('Demo controls need at least one simulated chain');

  const settle = async () => {
    for (const c of chains) await c.watcher.pollOnce();
    await dispatcher.runOnce();
  };

  return {
    pay: (orderId, kind) =>
      lock.run(async () => {
        const order = await store.getOrder(orderId);
        if (!order) throw new DemoError('Order not found');
        const target = chains.find((c) => c.network === order.network);
        if (!target) throw new DemoError('Demo payments only work for orders on a simulated chain');
        const amount =
          kind === 'under' ? order.payableAmount - parseAmount('1.00')
          : kind === 'over' ? order.payableAmount + parseAmount('2.50')
          : kind === 'base' ? order.baseAmount
          : order.payableAmount;
        if (amount <= 0n) throw new DemoError('Order amount too small for this demo payment');
        const txHash = target.chain.sendTransfer({
          toAddress: order.receivingAddress,
          amount,
          fromAddress: 'SIM-DEMO-VISITOR',
          tokenContract: kind === 'wrong_token' ? DEMO_OTHER_TOKEN : undefined,
        });
        target.chain.mine(1);
        await settle();
        return { txHash };
      }),

    unknownPayment: (amount) =>
      lock.run(async () => {
        const target = chains[0]!;
        const txHash = target.chain.sendTransfer({ toAddress: target.watchAddresses[0]!, amount: parseAmount(amount), fromAddress: 'SIM-UNKNOWN-SENDER' });
        target.chain.mine(1);
        await settle();
        return { txHash };
      }),

    mine: (blocks) =>
      lock.run(async () => {
        for (const c of chains) c.chain.mine(blocks);
        await settle();
      }),

    reorg: (depth) =>
      lock.run(async () => {
        for (const c of chains) c.chain.reorg(depth, false);
        await settle();
      }),
  };
}
