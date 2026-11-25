// LIVE end-to-end check, read-only, no money involved.
// For each network it takes a real recent USDT transfer from the public chain,
// creates a matching order in a throw-away database, runs the REAL watcher +
// processor against the live API, and checks the order reaches "confirmed".
// Usage: npm run e2e:readonly

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChainAdapter } from '../src/chains/ChainAdapter.js';
import { EvmRpcAdapter } from '../src/chains/evm/EvmRpcAdapter.js';
import { requireUsdtContract } from '../src/chains/tokens.js';
import { TronGridAdapter } from '../src/chains/tron/TronGridAdapter.js';
import { formatAmount } from '../src/core/money.js';
import type { Network } from '../src/core/types.js';
import { SqliteStore } from '../src/db/SqliteStore.js';
import { PaymentProcessor } from '../src/services/PaymentProcessor.js';
import { ChainWatcher } from '../src/workers/ChainWatcher.js';
import { findEvmSample, findTronSample, type SampleTransfer } from './lib/samples.js';

interface Case {
  label: string;
  network: Network;
  contract: string;
  confirmations: number;
  sample: () => Promise<SampleTransfer>;
  adapter: () => ChainAdapter;
}

const tronMain = requireUsdtContract('tron-mainnet');
const tronNile = requireUsdtContract('tron-nile');
const arb = requireUsdtContract('arbitrum-one');
const eth = requireUsdtContract('ethereum-mainnet');
const bsc = requireUsdtContract('bsc-mainnet');
const ETH_RPC = process.env.ETHEREUM_RPC ?? 'https://ethereum-rpc.publicnode.com';
const BSC_RPC = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com';
const tronHttp = { retries: 5, backoffMs: 1500 };

const cases: Case[] = [
  {
    label: 'TRON Nile testnet',
    network: 'tron',
    contract: tronNile.address,
    confirmations: 19,
    sample: () => findTronSample('https://nile.trongrid.io', tronNile.address, 25),
    adapter: () => new TronGridAdapter({ apiUrl: 'https://nile.trongrid.io', tokenContract: tronNile.address, explorerUrl: 'https://nile.tronscan.org', http: tronHttp }),
  },
  {
    label: 'TRON mainnet (read-only)',
    network: 'tron',
    contract: tronMain.address,
    confirmations: 19,
    sample: () => findTronSample('https://api.trongrid.io', tronMain.address, 25),
    adapter: () => new TronGridAdapter({ apiUrl: 'https://api.trongrid.io', tokenContract: tronMain.address, explorerUrl: 'https://tronscan.org', http: tronHttp }),
  },
  {
    label: 'Arbitrum One (read-only)',
    network: 'arbitrum',
    contract: arb.address,
    confirmations: 20,
    sample: () => findEvmSample('https://arb1.arbitrum.io/rpc', arb.address, 100),
    adapter: () => new EvmRpcAdapter({ network: 'arbitrum', rpcUrl: 'https://arb1.arbitrum.io/rpc', expectedChainId: arb.chainId!, tokenContract: arb.address, explorerUrl: 'https://arbiscan.io' }),
  },
  {
    label: 'Ethereum mainnet (read-only)',
    network: 'ethereum',
    contract: eth.address,
    confirmations: 12,
    sample: () => findEvmSample(ETH_RPC, eth.address, 20, 2),
    adapter: () => new EvmRpcAdapter({ network: 'ethereum', rpcUrl: ETH_RPC, expectedChainId: eth.chainId!, tokenContract: eth.address, tokenDecimals: eth.decimals, explorerUrl: 'https://etherscan.io' }),
  },
  {
    label: 'BNB Smart Chain (read-only, 18-decimal USDT)',
    network: 'bsc',
    contract: bsc.address,
    confirmations: 20,
    sample: () => findEvmSample(BSC_RPC, bsc.address, 40, 10),
    adapter: () => new EvmRpcAdapter({ network: 'bsc', rpcUrl: BSC_RPC, expectedChainId: bsc.chainId!, tokenContract: bsc.address, tokenDecimals: bsc.decimals, explorerUrl: 'https://bscscan.com' }),
  },
];

async function runCase(c: Case): Promise<boolean> {
  const dir = mkdtempSync(join(tmpdir(), 'usdt-e2e-'));
  const store = new SqliteStore(join(dir, 'e2e.db'));
  try {
    const sample = await c.sample();
    const adapter = c.adapter();
    const inBlock = await adapter.getTransfers({ fromBlock: sample.blockNumber, toBlock: sample.blockNumber, tokenContract: c.contract, toAddresses: [sample.toAddress] });
    const event = inBlock.find((e) => e.txHash === sample.txHash);
    if (!event) throw new Error('adapter did not return the sampled transfer');
    if (inBlock.length > 1) {
      throw new Error(`sample address received ${inBlock.length} transfers in one block; rerun to pick another sample`);
    }

    const blockTime = event.blockTimestamp.getTime();
    await store.insertOrder({
      id: 'ord_e2e', externalRef: 'e2e-readonly', network: c.network, token: 'USDT', receivingAddress: sample.toAddress,
      baseAmount: event.amount, payableAmount: event.amount, status: 'pending',
      createdAt: new Date(blockTime - 60_000), expiresAt: new Date(blockTime + 60 * 60_000),
      payerTelegramChatId: null, manuallyResolved: false,
    });
    const config = {
      networks: new Map([[c.network, { network: c.network, usdtContract: c.contract, requiredConfirmations: c.confirmations, watchAddresses: [sample.toAddress] }]]),
      payment: { underpayToleranceUnits: 0n, overpayToleranceUnits: 0n, lateReservationMinutes: 60 },
      defaultExpiryMinutes: 30,
    };
    const processor = new PaymentProcessor(store, config);
    const watcher = new ChainWatcher(adapter, store, processor, {
      usdtContract: c.contract, watchAddresses: [sample.toAddress], requiredConfirmations: c.confirmations,
      startBlock: sample.blockNumber, maxBlocksPerPoll: 1,
    });
    const poll = await watcher.pollOnce();
    if (!poll.ok) throw new Error(poll.error);
    const order = (await store.getOrder('ord_e2e'))!;
    const ok = order.status === 'confirmed';
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.label}`);
    console.log(`      tx ${adapter.explorerTxUrl(sample.txHash)}`);
    console.log(`      amount ${formatAmount(event.amount)} USDT, block ${event.blockNumber}, latest ${poll.latestBlock}, order status: ${order.status}`);
    if (event.raw) {
      console.log(`      on-chain raw ${event.raw.amount} (${event.raw.decimals} decimals), dust below 0.000001 ignored: ${event.raw.dustIgnored}`);
    }
    return ok;
  } catch (error) {
    console.log(`FAIL  ${c.label}: ${(error as Error).message}`);
    return false;
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\nRead-only live end-to-end check (public data, no funds)\n');
let allOk = true;
for (const c of cases) allOk = (await runCase(c)) && allOk;
console.log('');
process.exit(allOk ? 0 : 1);
