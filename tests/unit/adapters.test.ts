// Adapter tests replaying REAL public chain responses recorded by
// `npm run record:fixtures`. Tests marked "synthetic" modify a recorded
// response to simulate a case we could not capture live (e.g. a reverted tx).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EvmRpcAdapter } from '../../src/chains/evm/EvmRpcAdapter.js';
import { requireUsdtContract } from '../../src/chains/tokens.js';
import { isValidTronAddress, tronBase58ToHex, tronHexToBase58 } from '../../src/chains/tron/address.js';
import { TronGridAdapter } from '../../src/chains/tron/TronGridAdapter.js';
import { loadEnv } from '../../src/config/env.js';
import { buildRuntime } from '../../src/config/runtime.js';
import { SqliteStore } from '../../src/db/SqliteStore.js';
import { PaymentProcessor } from '../../src/services/PaymentProcessor.js';
import { ChainWatcher } from '../../src/workers/ChainWatcher.js';
import { replayFetch, type FixtureResponses } from '../fixtureFetch.js';

interface Fixture {
  sample: { txHash: string; blockNumber: number; toAddress: string; amountUnits: string; logIndex: number };
  query: { fromBlock: number; toBlock: number; tokenContract: string; toAddresses: string[] };
  expected: { eventCount: number; canonical: boolean };
  responses: FixtureResponses;
}

const load = (name: string) => JSON.parse(readFileSync(`tests/fixtures/${name}.json`, 'utf8')) as Fixture;
const keyContaining = (responses: FixtureResponses, ...parts: string[]) => {
  const key = Object.keys(responses).find((k) => parts.every((p) => k.includes(p)));
  if (!key) throw new Error(`fixture key not found: ${parts.join(' ')}`);
  return key;
};

const TRON = requireUsdtContract('tron-mainnet');
const ARB = requireUsdtContract('arbitrum-one');
const FAST = { retries: 0, backoffMs: 1 };

function tronAdapter(responses: FixtureResponses, overrides: FixtureResponses = {}) {
  return new TronGridAdapter({
    apiUrl: 'https://api.trongrid.io',
    tokenContract: TRON.address,
    explorerUrl: 'https://tronscan.org',
    http: { ...FAST, fetch: replayFetch(responses, overrides) },
  });
}

function evmAdapter(responses: FixtureResponses, overrides: FixtureResponses = {}, expectedChainId = 42161) {
  return new EvmRpcAdapter({
    network: 'arbitrum',
    rpcUrl: 'https://arb1.arbitrum.io/rpc',
    expectedChainId,
    tokenContract: ARB.address,
    explorerUrl: 'https://arbiscan.io',
    http: { ...FAST, fetch: replayFetch(responses, overrides) },
  });
}

describe('TRON address encoding', () => {
  it('converts between hex and base58 (USDT contract as known pair)', () => {
    expect(tronHexToBase58('41a614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(tronBase58ToHex('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe('41a614f803b6fd780986a42c78ec9c7f77e6ded13c');
  });

  it('rejects a mistyped address (bad checksum)', () => {
    expect(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(true);
    expect(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toBe(false);
  });
});

describe('TronGridAdapter (recorded mainnet data)', () => {
  const fx = load('tron-mainnet');

  it('parses the real USDT transfer exactly', async () => {
    const events = await tronAdapter(fx.responses).getTransfers(fx.query);
    expect(events).toHaveLength(fx.expected.eventCount);
    expect(events[0]).toMatchObject({
      network: 'tron',
      txHash: fx.sample.txHash,
      logIndex: fx.sample.logIndex,
      toAddress: fx.sample.toAddress,
      amount: BigInt(fx.sample.amountUnits),
      blockNumber: fx.sample.blockNumber,
      tokenContract: TRON.address,
    });
    expect(events[0]!.blockTimestamp.getTime()).toBeGreaterThan(Date.UTC(2020, 0, 1));
  });

  it('confirms the transfer is on the canonical chain', async () => {
    expect(await tronAdapter(fx.responses).isTransferCanonical(fx.sample.txHash, fx.sample.logIndex)).toBe(true);
  });

  it('ignores a reverted transaction (synthetic: receipt changed to REVERT)', async () => {
    const key = keyContaining(fx.responses, 'gettransactioninfobyid');
    const reverted = { ...(fx.responses[key] as object), receipt: { result: 'REVERT' }, result: 'FAILED' };
    const adapter = tronAdapter(fx.responses, { [key]: reverted });
    expect(await adapter.getTransfers(fx.query)).toHaveLength(0);
    expect(await adapter.isTransferCanonical(fx.sample.txHash, fx.sample.logIndex)).toBe(false);
  });

  it('reports a transaction that disappeared as not canonical (synthetic: empty tx info)', async () => {
    const key = keyContaining(fx.responses, 'gettransactioninfobyid');
    expect(await tronAdapter(fx.responses, { [key]: {} }).isTransferCanonical(fx.sample.txHash, fx.sample.logIndex)).toBe(false);
  });

  it('ignores Transfer logs from a different token contract (synthetic)', async () => {
    const key = keyContaining(fx.responses, 'gettransactioninfobyid');
    const info = fx.responses[key] as { log: Array<{ address: string }> };
    const fake = { ...info, log: info.log.map((l) => ({ ...l, address: '1111111111111111111111111111111111111111' })) };
    expect(await tronAdapter(fx.responses, { [key]: fake }).getTransfers(fx.query)).toHaveLength(0);
  });

  it('builds a Tronscan link', () => {
    expect(tronAdapter(fx.responses).explorerTxUrl('abc')).toBe('https://tronscan.org/#/transaction/abc');
  });

  it('retries after HTTP 429 (rate limit) and then succeeds', async () => {
    let calls = 0;
    const flaky = async (url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 429 });
      return replayFetch(fx.responses)(url, init);
    };
    const adapter = new TronGridAdapter({
      apiUrl: 'https://api.trongrid.io',
      tokenContract: TRON.address,
      explorerUrl: 'https://tronscan.org',
      http: { retries: 2, backoffMs: 1, fetch: flaky },
    });
    expect(await adapter.getTransfers(fx.query)).toHaveLength(1);
    expect(calls).toBeGreaterThan(1);
  });

  it('drives a full watcher -> processor run to "confirmed" offline', async () => {
    const store = new SqliteStore(':memory:');
    try {
      const nowKey = 'POST https://api.trongrid.io/wallet/getnowblock {}';
      const adapter = tronAdapter(fx.responses, { [nowKey]: { block_header: { raw_data: { number: fx.sample.blockNumber + 30 } } } });
      const events = await tronAdapter(fx.responses).getTransfers(fx.query);
      const blockTime = events[0]!.blockTimestamp;
      const config = {
        networks: new Map([['tron' as const, { network: 'tron' as const, usdtContract: TRON.address, requiredConfirmations: 19, watchAddresses: [fx.sample.toAddress] }]]),
        payment: { underpayToleranceUnits: 0n, overpayToleranceUnits: 0n, lateReservationMinutes: 60 },
        defaultExpiryMinutes: 30,
      };
      const clock = () => new Date(blockTime.getTime() + 60_000);
      await store.insertOrder({
        id: 'ord_fixture', externalRef: null, network: 'tron', token: 'USDT', receivingAddress: fx.sample.toAddress,
        baseAmount: BigInt(fx.sample.amountUnits), payableAmount: BigInt(fx.sample.amountUnits), status: 'pending',
        createdAt: new Date(blockTime.getTime() - 60_000), expiresAt: new Date(blockTime.getTime() + 30 * 60_000),
        payerTelegramChatId: null, manuallyResolved: false,
      });
      const processor = new PaymentProcessor(store, config, clock);
      const watcher = new ChainWatcher(adapter, store, processor, {
        usdtContract: TRON.address, watchAddresses: [fx.sample.toAddress], requiredConfirmations: 19,
        startBlock: fx.sample.blockNumber, maxBlocksPerPoll: 1, now: clock,
      });
      const result = await watcher.pollOnce();
      expect(result.ok).toBe(true);
      expect((await store.getOrder('ord_fixture'))!.status).toBe('confirmed');
    } finally {
      store.close();
    }
  });
});

describe('EvmRpcAdapter (recorded Arbitrum One data)', () => {
  const fx = load('arbitrum-one');

  it('parses the real USDT0 transfer and reads the time from the block header', async () => {
    const events = await evmAdapter(fx.responses).getTransfers(fx.query);
    expect(events).toHaveLength(fx.expected.eventCount);
    const event = events.find((e) => e.txHash === fx.sample.txHash && e.logIndex === fx.sample.logIndex)!;
    expect(event).toMatchObject({
      network: 'arbitrum',
      toAddress: fx.sample.toAddress.toLowerCase(),
      amount: BigInt(fx.sample.amountUnits),
      blockNumber: fx.sample.blockNumber,
    });
    expect(event.blockTimestamp.getTime()).toBeGreaterThan(Date.UTC(2020, 0, 1)); // not the bogus 0x0
  });

  it('confirms the transfer via its receipt', async () => {
    expect(await evmAdapter(fx.responses).isTransferCanonical(fx.sample.txHash, fx.sample.logIndex)).toBe(true);
  });

  it('refuses to run against the wrong chain id', async () => {
    await expect(evmAdapter(fx.responses, {}, 421614).getLatestBlockNumber()).rejects.toThrow(/chain id/);
  });

  it('skips logs the node marks as removed by a reorg (synthetic)', async () => {
    const key = keyContaining(fx.responses, 'eth_getLogs');
    const logs = (fx.responses[key] as { result: object[] }).result.map((l) => ({ ...l, removed: true }));
    expect(await evmAdapter(fx.responses, { [key]: { jsonrpc: '2.0', result: logs } }).getTransfers(fx.query)).toHaveLength(0);
  });

  it('treats a failed or missing receipt as not canonical (synthetic)', async () => {
    const key = keyContaining(fx.responses, 'eth_getTransactionReceipt');
    const receipt = (fx.responses[key] as { result: object }).result;
    const failed = { jsonrpc: '2.0', result: { ...receipt, status: '0x0' } };
    expect(await evmAdapter(fx.responses, { [key]: failed }).isTransferCanonical(fx.sample.txHash, fx.sample.logIndex)).toBe(false);
    expect(await evmAdapter(fx.responses, { [key]: { jsonrpc: '2.0', result: null } }).isTransferCanonical(fx.sample.txHash, fx.sample.logIndex)).toBe(false);
  });
});

describe('configuration safety', () => {
  it('starts in demo mode with no configuration at all', () => {
    const runtime = buildRuntime(loadEnv({ DATABASE_URL: 'file::memory:' } as NodeJS.ProcessEnv));
    try {
      expect(runtime.env.APP_MODE).toBe('demo');
      expect(runtime.networks.map((n) => n.settings.network)).toEqual(['simulated']);
    } finally {
      runtime.store.close();
    }
  });

  it('rejects a private key pasted into a watch-address field', () => {
    const fakeKey = 'ab'.repeat(32);
    expect(() => loadEnv({ APP_MODE: 'testnet', EVM_WATCH_ADDRESSES: fakeKey } as NodeJS.ProcessEnv)).toThrow(/PRIVATE KEY/);
  });

  it('rejects a seed phrase pasted into a watch-address field', () => {
    const words = Array.from({ length: 12 }, () => 'word').join(' ');
    expect(() => loadEnv({ TRON_WATCH_ADDRESSES: words } as NodeJS.ProcessEnv)).toThrow(/SEED PHRASE/);
  });

  it('rejects a mistyped TRON address', () => {
    expect(() => loadEnv({ TRON_WATCH_ADDRESSES: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u' } as NodeJS.ProcessEnv)).toThrow(/invalid address/);
  });

  it('refuses EVM testnet mode without an explicitly configured test token', () => {
    const env = loadEnv({
      APP_MODE: 'testnet', DATABASE_URL: 'file::memory:',
      EVM_WATCH_ADDRESSES: '0x1111111111111111111111111111111111111111', EVM_RPC_URL: 'https://example.invalid',
    } as NodeJS.ProcessEnv);
    expect(() => buildRuntime(env)).toThrow(/no official USDT/);
  });
});
