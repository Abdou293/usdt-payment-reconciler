// Ethereum (ERC20) and BNB Smart Chain (BEP20) support.
// Replays REAL public responses recorded by `npm run record:fixtures ethereum|bsc`.
// BSC USDT has 18 decimals: the adapter converts it to the internal 6-decimal
// unit, rounding DOWN, and keeps the exact on-chain value for the audit log.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EvmRpcAdapter } from '../../src/chains/evm/EvmRpcAdapter.js';
import { requireUsdtContract } from '../../src/chains/tokens.js';
import { loadEnv } from '../../src/config/env.js';
import { buildRuntime } from '../../src/config/runtime.js';
import { formatAmount, toCanonicalUnits } from '../../src/core/money.js';
import type { Network } from '../../src/core/types.js';
import { SqliteStore } from '../../src/db/SqliteStore.js';
import { PaymentProcessor } from '../../src/services/PaymentProcessor.js';
import { ChainWatcher } from '../../src/workers/ChainWatcher.js';
import { replayFetch, type FixtureResponses } from '../fixtureFetch.js';

interface Fixture {
  sample: { txHash: string; blockNumber: number; toAddress: string; amountUnits: string; logIndex: number; tokenDecimals: number };
  query: { fromBlock: number; toBlock: number; tokenContract: string; toAddresses: string[] };
  expected: { eventCount: number; canonical: boolean };
  responses: FixtureResponses;
}

const load = (name: string) => JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8')) as Fixture;
const ETH = requireUsdtContract('ethereum-mainnet');
const BSC = requireUsdtContract('bsc-mainnet');
const CASES = [
  { name: 'ethereum-mainnet', network: 'ethereum' as Network, token: ETH, rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io', confirmations: 12 },
  { name: 'bsc-mainnet', network: 'bsc' as Network, token: BSC, rpc: 'https://bsc-rpc.publicnode.com', explorer: 'https://bscscan.com', confirmations: 20 },
];

function adapterFor(c: (typeof CASES)[number], responses: FixtureResponses, overrides: FixtureResponses = {}) {
  return new EvmRpcAdapter({
    network: c.network,
    rpcUrl: c.rpc,
    expectedChainId: c.token.chainId!,
    tokenContract: c.token.address,
    tokenDecimals: c.token.decimals,
    explorerUrl: c.explorer,
    http: { retries: 0, backoffMs: 1, fetch: replayFetch(responses, overrides) },
  });
}

describe('toCanonicalUnits (decimal-safe conversion to the internal 6-decimal unit)', () => {
  it('keeps 6-decimal amounts unchanged', () => {
    expect(toCanonicalUnits(18_390_000n, 6)).toEqual({ units: 18_390_000n, dust: 0n });
  });

  it('converts 18-decimal amounts exactly when there is no dust', () => {
    expect(toCanonicalUnits(49_990_347n * 10n ** 12n, 18)).toEqual({ units: 49_990_347n, dust: 0n });
  });

  it('rounds DOWN below 0.000001 and reports the dust (never credits more than arrived)', () => {
    const raw = 254_292_060_054_072_910_930n; // 254.292060054072910930 on BSC
    expect(toCanonicalUnits(raw, 18)).toEqual({ units: 254_292_060n, dust: 54_072_910_930n });
    // 0.0000009999 USDT is less than one internal unit: it counts as 0, not 0.000001.
    expect(toCanonicalUnits(999_999_999_999n, 18)).toEqual({ units: 0n, dust: 999_999_999_999n });
  });

  it('scales up tokens with fewer decimals and rejects nonsense', () => {
    expect(toCanonicalUnits(12_345n, 2)).toEqual({ units: 123_450_000n, dust: 0n });
    expect(() => toCanonicalUnits(1n, -1)).toThrow();
    expect(() => toCanonicalUnits(-1n, 18)).toThrow();
  });
});

describe('verified contract registry', () => {
  it('has the official Ethereum USDT (6 decimals) and BSC USDT (18 decimals, Binance-issued)', () => {
    expect(ETH).toMatchObject({ address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, chainId: 1 });
    expect(BSC).toMatchObject({ address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, chainId: 56 });
    expect(BSC.issuerNote).toMatch(/Binance/);
  });
});

for (const c of CASES) {
  describe(`EvmRpcAdapter (recorded ${c.name} data)`, () => {
    const fx = load(c.name);
    const expectedUnits = toCanonicalUnits(BigInt(fx.sample.amountUnits), c.token.decimals);

    it('parses the real USDT transfer into the internal unit', async () => {
      const events = await adapterFor(c, fx.responses).getTransfers(fx.query);
      expect(events).toHaveLength(fx.expected.eventCount);
      const event = events.find((e) => e.txHash === fx.sample.txHash && e.logIndex === fx.sample.logIndex)!;
      expect(event).toMatchObject({
        network: c.network,
        toAddress: fx.sample.toAddress.toLowerCase(),
        amount: expectedUnits.units,
        blockNumber: fx.sample.blockNumber,
      });
      if (c.token.decimals === 6) {
        expect(event.raw).toBeUndefined();
      } else {
        expect(event.raw).toEqual({ amount: fx.sample.amountUnits, decimals: 18, dustIgnored: expectedUnits.dust.toString() });
      }
    });

    it('confirms the transfer via its receipt and refuses the wrong chain', async () => {
      expect(await adapterFor(c, fx.responses).isTransferCanonical(fx.sample.txHash, fx.sample.logIndex)).toBe(true);
      const wrongChain = new EvmRpcAdapter({
        network: c.network, rpcUrl: c.rpc, expectedChainId: 999, tokenContract: c.token.address,
        tokenDecimals: c.token.decimals, explorerUrl: c.explorer, http: { retries: 0, backoffMs: 1, fetch: replayFetch(fx.responses) },
      });
      await expect(wrongChain.getLatestBlockNumber()).rejects.toThrow(/chain id/);
    });

    it('drives a full watcher -> processor run to "confirmed" offline, with the raw value in the audit log', async () => {
      const store = new SqliteStore(':memory:');
      try {
        const events = await adapterFor(c, fx.responses).getTransfers(fx.query);
        const blockTime = events[0]!.blockTimestamp;
        const latest = `0x${(fx.sample.blockNumber + c.confirmations + 5).toString(16)}`;
        // The recording has no chain tip; pretend the chain is a few blocks past the confirmations.
        const blockKey = `POST ${c.rpc} ${JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [] })}`;
        const overrides: FixtureResponses = { [blockKey]: { jsonrpc: '2.0', id: 1, result: latest } };
        const adapter = adapterFor(c, fx.responses, overrides);
        const clock = () => new Date(blockTime.getTime() + 60_000);
        const config = {
          networks: new Map([[c.network, { network: c.network, usdtContract: c.token.address, requiredConfirmations: c.confirmations, watchAddresses: [fx.sample.toAddress] }]]),
          payment: { underpayToleranceUnits: 0n, overpayToleranceUnits: 0n, lateReservationMinutes: 60 },
          defaultExpiryMinutes: 30,
        };
        await store.insertOrder({
          id: 'ord_fixture', externalRef: null, network: c.network, token: 'USDT', receivingAddress: fx.sample.toAddress,
          baseAmount: expectedUnits.units, payableAmount: expectedUnits.units, status: 'pending',
          createdAt: new Date(blockTime.getTime() - 60_000), expiresAt: new Date(blockTime.getTime() + 30 * 60_000),
          payerTelegramChatId: null, manuallyResolved: false,
        });
        const processor = new PaymentProcessor(store, config, clock);
        const watcher = new ChainWatcher(adapter, store, processor, {
          usdtContract: c.token.address, watchAddresses: [fx.sample.toAddress], requiredConfirmations: c.confirmations,
          startBlock: fx.sample.blockNumber, maxBlocksPerPoll: 1, now: clock,
        });
        const result = await watcher.pollOnce();
        expect(result.ok).toBe(true);
        expect((await store.getOrder('ord_fixture'))!.status).toBe('confirmed');

        const [payment] = await store.listPaymentsForOrder('ord_fixture');
        expect(formatAmount(payment!.amount)).toBe(formatAmount(expectedUnits.units));
        const detected = (await store.listAudit('payment', String(payment!.id))).find((a) => a.action === 'payment_detected')!;
        if (c.token.decimals === 18) {
          expect(detected.details).toMatchObject({ rawAmount: fx.sample.amountUnits, rawDecimals: 18 });
        }
      } finally {
        store.close();
      }
    });
  });
}

describe('configuration for the new networks', () => {
  it('rejects a private key pasted into BSC_WATCH_ADDRESSES or ETH_WATCH_ADDRESSES', () => {
    const fakeKey = 'cd'.repeat(32);
    expect(() => loadEnv({ BSC_WATCH_ADDRESSES: fakeKey } as NodeJS.ProcessEnv)).toThrow(/PRIVATE KEY/);
    expect(() => loadEnv({ ETH_WATCH_ADDRESSES: fakeKey } as NodeJS.ProcessEnv)).toThrow(/PRIVATE KEY/);
  });

  it('needs an RPC URL, and refuses testnet mode without an explicitly configured test token', () => {
    const addr = '0x2222222222222222222222222222222222222222';
    expect(() => buildRuntime(loadEnv({ APP_MODE: 'mainnet', DATABASE_URL: 'file::memory:', BSC_WATCH_ADDRESSES: addr } as NodeJS.ProcessEnv))).toThrow(/BSC_RPC_URL/);
    expect(() =>
      buildRuntime(loadEnv({ APP_MODE: 'testnet', DATABASE_URL: 'file::memory:', ETH_WATCH_ADDRESSES: addr, ETH_RPC_URL: 'https://example.invalid' } as NodeJS.ProcessEnv)),
    ).toThrow(/no official USDT/);
  });

  it('mainnet mode wires the verified contracts with the right decimals and labels', () => {
    const addr = '0x3333333333333333333333333333333333333333';
    const runtime = buildRuntime(
      loadEnv({
        APP_MODE: 'mainnet', DATABASE_URL: 'file::memory:',
        ETH_WATCH_ADDRESSES: addr, ETH_RPC_URL: 'https://example.invalid',
        BSC_WATCH_ADDRESSES: addr, BSC_RPC_URL: 'https://example.invalid',
      } as NodeJS.ProcessEnv),
    );
    try {
      const byNet = new Map(runtime.networks.map((n) => [n.settings.network, n]));
      expect(byNet.get('ethereum')!.settings.usdtContract).toBe(ETH.address);
      expect(byNet.get('bsc')!.settings.usdtContract).toBe(BSC.address);
      expect(byNet.get('bsc')!.label).toMatch(/BNB Smart Chain/);
      expect(runtime.warnings.some((w) => /Binance-Peg/.test(w))).toBe(true);
    } finally {
      runtime.store.close();
    }
  });
});
