// Buttons for the PUBLIC DEMO: "pay this order", "mine a block", "reorg".
// They only touch the in-memory SIMULATED chain. Never available in testnet or
// mainnet mode (the HTTP routes are registered only when APP_MODE=demo).

import { SimulatedChainAdapter } from '../chains/simulated/SimulatedChainAdapter.js';
import { parseAmount } from '../core/money.js';
import type { Mutex } from '../core/mutex.js';
import type { Store } from '../db/Store.js';
import type { DemoControls } from '../http/server.js';
import type { NotificationDispatcher } from '../notifications/NotificationDispatcher.js';
import type { ChainWatcher } from '../workers/ChainWatcher.js';
import { DEMO_OTHER_TOKEN } from './seedDemo.js';

class DemoError extends Error {
  readonly statusCode = 400;
}

export function createSimulatorControls(deps: {
  chain: SimulatedChainAdapter;
  watcher: ChainWatcher;
  dispatcher: NotificationDispatcher;
  store: Store;
  lock: Mutex;
  watchAddresses: readonly string[];
}): DemoControls {
  const { chain, watcher, dispatcher, store, lock } = deps;

  const settle = async () => {
    await watcher.pollOnce();
    await dispatcher.runOnce();
  };

  return {
    pay: (orderId, kind) =>
      lock.run(async () => {
        const order = await store.getOrder(orderId);
        if (!order) throw new DemoError('Order not found');
        if (order.network !== 'simulated') throw new DemoError('Demo payments only work for simulated orders');
        const amount =
          kind === 'under' ? order.payableAmount - parseAmount('1.00')
          : kind === 'over' ? order.payableAmount + parseAmount('2.50')
          : kind === 'base' ? order.baseAmount
          : order.payableAmount;
        if (amount <= 0n) throw new DemoError('Order amount too small for this demo payment');
        const txHash = chain.sendTransfer({
          toAddress: order.receivingAddress,
          amount,
          fromAddress: 'SIM-DEMO-VISITOR',
          tokenContract: kind === 'wrong_token' ? DEMO_OTHER_TOKEN : undefined,
        });
        chain.mine(1);
        await settle();
        return { txHash };
      }),

    unknownPayment: (amount) =>
      lock.run(async () => {
        const txHash = chain.sendTransfer({ toAddress: deps.watchAddresses[0]!, amount: parseAmount(amount), fromAddress: 'SIM-UNKNOWN-SENDER' });
        chain.mine(1);
        await settle();
        return { txHash };
      }),

    mine: (blocks) =>
      lock.run(async () => {
        chain.mine(blocks);
        await settle();
      }),

    reorg: (depth) =>
      lock.run(async () => {
        chain.reorg(depth, false);
        await settle();
      }),
  };
}
