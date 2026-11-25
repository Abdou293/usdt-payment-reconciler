// Record real, public chain responses into tests/fixtures/*.json (read-only).
// Usage: npm run record:fixtures
// The tests then replay these files offline, so they are fast and deterministic.

import { mkdirSync, writeFileSync } from 'node:fs';
import { EvmRpcAdapter } from '../src/chains/evm/EvmRpcAdapter.js';
import { requireUsdtContract } from '../src/chains/tokens.js';
import { TronGridAdapter } from '../src/chains/tron/TronGridAdapter.js';
import { formatAmount } from '../src/core/money.js';
import { recordingFetch, type FixtureResponses } from '../tests/fixtureFetch.js';
import { findEvmSample, findTronSample } from './lib/samples.js';

mkdirSync('tests/fixtures', { recursive: true });

async function recordTron(): Promise<void> {
  const api = 'https://api.trongrid.io';
  const token = requireUsdtContract('tron-mainnet');
  const sample = await findTronSample(api, token.address, 25);
  const responses: FixtureResponses = {};
  const adapter = new TronGridAdapter({
    apiUrl: api,
    tokenContract: token.address,
    explorerUrl: 'https://tronscan.org',
    http: { fetch: recordingFetch(responses), retries: 5, backoffMs: 1500 },
  });
  const query = { fromBlock: sample.blockNumber, toBlock: sample.blockNumber, tokenContract: token.address, toAddresses: [sample.toAddress] };
  const events = await adapter.getTransfers(query);
  const canonical = await adapter.isTransferCanonical(sample.txHash, sample.logIndex);
  save('tron-mainnet', sample, query, events.length, canonical, responses);
}

async function recordArbitrum(): Promise<void> {
  const rpc = 'https://arb1.arbitrum.io/rpc';
  const token = requireUsdtContract('arbitrum-one');
  const sample = await findEvmSample(rpc, token.address, 100);
  const responses: FixtureResponses = {};
  const adapter = new EvmRpcAdapter({
    network: 'arbitrum',
    rpcUrl: rpc,
    expectedChainId: token.chainId!,
    tokenContract: token.address,
    explorerUrl: 'https://arbiscan.io',
    http: { fetch: recordingFetch(responses) },
  });
  const query = { fromBlock: sample.blockNumber, toBlock: sample.blockNumber, tokenContract: token.address, toAddresses: [sample.toAddress] };
  const events = await adapter.getTransfers(query);
  const canonical = await adapter.isTransferCanonical(sample.txHash, sample.logIndex);
  save('arbitrum-one', sample, query, events.length, canonical, responses);
}

async function recordEvm(name: 'ethereum-mainnet' | 'bsc-mainnet', network: 'ethereum' | 'bsc', rpc: string, explorer: string, depth: number, span: number): Promise<void> {
  const token = requireUsdtContract(name);
  const sample = await findEvmSample(rpc, token.address, depth, span);
  const responses: FixtureResponses = {};
  const adapter = new EvmRpcAdapter({
    network,
    rpcUrl: rpc,
    expectedChainId: token.chainId!,
    tokenContract: token.address,
    tokenDecimals: token.decimals,
    explorerUrl: explorer,
    http: { fetch: recordingFetch(responses) },
  });
  const query = { fromBlock: sample.blockNumber, toBlock: sample.blockNumber, tokenContract: token.address, toAddresses: [sample.toAddress] };
  const events = await adapter.getTransfers(query);
  const canonical = await adapter.isTransferCanonical(sample.txHash, sample.logIndex);
  save(name, sample, query, events.length, canonical, responses, token.decimals);
}

function save(
  name: string,
  sample: Awaited<ReturnType<typeof findTronSample>>,
  query: object,
  eventCount: number,
  canonical: boolean,
  responses: FixtureResponses,
  tokenDecimals = 6,
): void {
  // Keep fixtures small: the adapter only reads TRON block headers.
  for (const [key, value] of Object.entries(responses)) {
    if (/\/wallet\/(getblockbynum|getnowblock)/.test(key) && value && typeof value === 'object') {
      responses[key] = { block_header: (value as { block_header?: unknown }).block_header };
    }
  }
  const file = `tests/fixtures/${name}.json`;
  const fixture = {
    note: 'Public on-chain data recorded read-only for offline adapter tests. No keys, no funds.',
    recordedAt: new Date().toISOString(),
    sample: { ...sample, tokenDecimals, amountUnits: sample.amountUnits.toString(), amount: formatAmount(sample.amountUnits, tokenDecimals) },
    query,
    expected: { eventCount, canonical },
    responses,
  };
  writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${name}: tx ${sample.txHash} block ${sample.blockNumber} -> ${eventCount} transfer(s), canonical=${canonical} -> ${file}`);
}

const only = process.argv[2];
if (!only || only === 'tron') await recordTron();
if (!only || only === 'arbitrum') await recordArbitrum();
if (!only || only === 'ethereum') {
  await recordEvm('ethereum-mainnet', 'ethereum', process.env.ETHEREUM_RPC ?? 'https://ethereum-rpc.publicnode.com', 'https://etherscan.io', 20, 2);
}
if (!only || only === 'bsc') {
  await recordEvm('bsc-mainnet', 'bsc', process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com', 'https://bscscan.com', 40, 10);
}
