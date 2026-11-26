// Demo seed, CSV safety, reconciliation report and simulated-chain restart behaviour.

import { describe, expect, it } from 'vitest';
import { SimulatedChainAdapter, SIMULATED_USDT_CONTRACT } from '../../src/chains/simulated/SimulatedChainAdapter.js';
import { loadEnv } from '../../src/config/env.js';
import { buildRuntime } from '../../src/config/runtime.js';
import { parseAmount } from '../../src/core/money.js';
import type { Order, Payment } from '../../src/core/types.js';
import { seedDemo } from '../../src/demo/seedDemo.js';
import { csvCell, toCsv } from '../../src/services/csv.js';
import { buildReconciliationReport, periodRange } from '../../src/services/reports.js';
import { createHarness } from '../helpers.js';

describe('CSV export safety', () => {
  it('neutralises spreadsheet formulas (CSV injection)', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('normal, with comma')).toBe('"normal, with comma"');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, 'x']])).toBe('a,b\r\n1,x\r\n');
  });
});

describe('reconciliation report', () => {
  const base = { network: 'simulated' as const, token: 'USDT', receivingAddress: 'A', externalRef: null, payerTelegramChatId: null, manuallyResolved: false };
  const order = (id: string, status: Order['status'], payable: string): Order => ({
    ...base, id, status, baseAmount: parseAmount(payable), payableAmount: parseAmount(payable),
    createdAt: new Date('2026-03-01T10:00:00Z'), expiresAt: new Date('2026-03-01T10:30:00Z'), updatedAt: new Date('2026-03-01T10:00:00Z'),
  } as Order);
  const payment = (id: number, status: Payment['status'], amount: string, orderId: string | null): Payment => ({
    id, network: 'simulated', txHash: `0x${id}`, logIndex: 0, tokenContract: 'T', fromAddress: 'F', toAddress: 'A', amount: parseAmount(amount),
    blockNumber: 1, blockTimestamp: new Date('2026-03-01T10:05:00Z'), status, orderId, note: null, confirmations: 3, firstSeenAt: new Date('2026-03-01T10:05:00Z'),
  } as Payment);

  it('totals requested vs received per network and lists exceptions', () => {
    const orders = [order('o1', 'confirmed', '10.00'), order('o2', 'underpaid', '20.00'), order('o3', 'expired', '30.00')];
    const p1 = payment(1, 'matched', '10.00', 'o1');
    const p2 = payment(2, 'matched', '15.00', 'o2');
    const p3 = payment(3, 'unmatched', '4.00', null);
    const p4 = payment(4, 'wrong_token', '9.00', null);
    const map = new Map([['o1', [p1]], ['o2', [p2]], ['o3', []]]);
    const { from, to } = periodRange('day', new Date('2026-03-01T15:00:00Z'));
    const r = buildReconciliationReport(from, to, orders, map, [p1, p2, p3, p4], new Date('2026-03-02T00:00:00Z'));

    expect(r.from).toBe('2026-03-01T00:00:00.000Z');
    expect(r.to).toBe('2026-03-02T00:00:00.000Z');
    expect(r.networks[0]).toMatchObject({
      ordersCreated: 3,
      requestedTotal: '30.000000', // the expired order is not counted as requested
      confirmedReceivedTotal: '10.000000',
      depositsCount: 3, // matched + unmatched (wrong token is not a USDT deposit)
      depositsTotal: '29.000000',
      unmatchedCount: 1,
      unmatchedTotal: '4.000000',
      wrongTokenCount: 1,
    });
    expect(r.exceptions.map((e) => e.kind).sort()).toEqual(['underpaid', 'unmatched_payment', 'wrong_token']);
  });

  it('computes UTC day and week ranges', () => {
    const week = periodRange('week', new Date('2026-03-10T23:59:00Z'));
    expect(week.from.toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(week.to.toISOString()).toBe('2026-03-11T00:00:00.000Z');
  });
});

describe('simulated chain after a restart', () => {
  it('treats unknown (pre-restart) transfers as canonical, but reorged ones as removed', async () => {
    const chain = new SimulatedChainAdapter({ startBlock: 10 });
    expect(await chain.isTransferCanonical('0xfrom-before-restart', 0)).toBe(true);
    const tx = chain.sendTransfer({ toAddress: 'A', amount: 1n });
    chain.mine(1);
    expect(await chain.isTransferCanonical(tx, 0)).toBe(true);
    chain.reorg(1);
    expect(await chain.isTransferCanonical(tx, 0)).toBe(false);
  });

  it('never reuses a tx hash across chain instances (restart / demo seed)', () => {
    const a = new SimulatedChainAdapter().sendTransfer({ toAddress: 'A', amount: 1n });
    const b = new SimulatedChainAdapter().sendTransfer({ toAddress: 'A', amount: 1n });
    expect(a).not.toBe(b);
  });

  it('fast-forwards to a saved block number', async () => {
    const chain = new SimulatedChainAdapter({ startBlock: 10 });
    chain.fastForwardTo(500);
    expect(await chain.getLatestBlockNumber()).toBe(500);
    chain.fastForwardTo(100); // never goes backwards
    expect(await chain.getLatestBlockNumber()).toBe(500);
  });
});

describe('demo seed', () => {
  it('creates a week of varied history once, never in the future', async () => {
    const h = createHarness({ addresses: ['SIM-DEMO-ADDRESS-1', 'SIM-DEMO-ADDRESS-2'] });
    const now = new Date('2026-06-15T12:00:00Z');
    // One simulated network only (the harness also has a TRON entry).
    const config = { ...h.config, networks: new Map([['simulated' as const, h.config.networks.get('simulated')!]]) };
    const result = await seedDemo(h.store, config, now);
    expect(result.seeded).toBe(true);
    expect(result.latestBlocks.get('simulated')).toBeGreaterThan(1000);

    const { items, total } = await h.store.listOrders({ limit: 500, offset: 0 });
    expect(total).toBe(result.orders);
    const statuses = new Set(items.map((o) => o.status));
    for (const s of ['confirmed', 'underpaid', 'overpaid', 'expired', 'late_payment', 'pending'] as const) {
      expect(statuses.has(s), `missing ${s}`).toBe(true);
    }
    expect(items.every((o) => o.createdAt.getTime() <= now.getTime())).toBe(true);
    expect(items.some((o) => o.manuallyResolved)).toBe(true);

    const odd = await h.store.listPaymentsByStatus(['unmatched', 'wrong_token', 'dismissed']);
    expect(new Set(odd.map((p) => p.status))).toEqual(new Set(['unmatched', 'wrong_token', 'dismissed']));

    const again = await seedDemo(h.store, config, now);
    expect(again.seeded).toBe(false);
    expect((await h.store.listOrders({ limit: 1, offset: 0 })).total).toBe(total);
  });

  it('spreads the demo over TRON, BSC, Ethereum and Arbitrum, each on its own simulated chain', async () => {
    const runtime = buildRuntime(loadEnv({ APP_MODE: 'demo', DATABASE_URL: 'file::memory:' } as NodeJS.ProcessEnv));
    try {
      expect(runtime.networks.map((n) => n.settings.network)).toEqual(['tron', 'bsc', 'ethereum', 'arbitrum']);
      // Every demo network is fake and says so: simulated adapter, simulated contract, "(simulated)" label.
      for (const n of runtime.networks) {
        expect(runtime.simulatedChains.get(n.settings.network)).toBe(n.adapter);
        expect(n.settings.usdtContract).toBe(SIMULATED_USDT_CONTRACT);
        expect(n.label).toMatch(/\(simulated\)$/);
      }
      const result = await seedDemo(runtime.store, runtime.config, new Date('2026-06-15T12:00:00Z'));
      const { items } = await runtime.store.listOrders({ limit: 500, offset: 0 });
      const perNetwork = new Set(items.map((o) => o.network));
      expect(perNetwork).toEqual(new Set(['tron', 'bsc', 'ethereum', 'arbitrum']));
      expect(items.filter((o) => o.status === 'confirmed').map((o) => o.network)).toEqual(expect.arrayContaining(['tron', 'bsc', 'ethereum', 'arbitrum']));
      expect(items.filter((o) => o.status === 'pending').length).toBe(4); // one open order per network for the "pay" buttons
      for (const net of ['tron', 'bsc', 'ethereum', 'arbitrum'] as const) {
        expect(result.latestBlocks.get(net)).toBeGreaterThan(1000);
      }
    } finally {
      runtime.store.close();
    }
  });
});
