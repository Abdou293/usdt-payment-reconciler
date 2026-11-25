// A fake blockchain for tests and demo mode. No wallet, API key or money.
// You "send" transfers, "mine" blocks, and can even trigger a reorganization.

import { createHash } from 'node:crypto';
import { sameAddress } from '../../core/matcher.js';
import type { Network, TransferEvent } from '../../core/types.js';
import type { ChainAdapter, TransferQuery } from '../ChainAdapter.js';

export const SIMULATED_USDT_CONTRACT = 'SIM-USDT-CONTRACT';

interface PendingTransfer {
  toAddress: string;
  amount: bigint;
  fromAddress: string;
  tokenContract: string;
  txHash: string;
}

interface Block {
  number: number;
  timestamp: Date;
  transfers: TransferEvent[];
}

export interface SimulatedChainOptions {
  network?: Network;
  startBlock?: number;
  now?: () => Date;
}

export class SimulatedChainAdapter implements ChainAdapter {
  readonly network: Network;
  private readonly blocks: Block[] = [];
  private mempool: PendingTransfer[] = [];
  private readonly now: () => Date;
  private txCounter = 0;

  constructor(options: SimulatedChainOptions = {}) {
    this.network = options.network ?? 'simulated';
    this.now = options.now ?? (() => new Date());
    this.blocks.push({ number: options.startBlock ?? 100, timestamp: this.now(), transfers: [] });
  }

  /** Queue a transfer; it lands on-chain at the next `mine()`. Returns its tx hash. */
  sendTransfer(params: { toAddress: string; amount: bigint; fromAddress?: string; tokenContract?: string; txHash?: string }): string {
    this.txCounter += 1;
    const txHash = params.txHash ?? fakeHash(`tx-${this.txCounter}`);
    this.mempool.push({
      toAddress: params.toAddress,
      amount: params.amount,
      fromAddress: params.fromAddress ?? 'SIM-PAYER',
      tokenContract: params.tokenContract ?? SIMULATED_USDT_CONTRACT,
      txHash,
    });
    return txHash;
  }

  /** Mine `count` blocks. The first one includes everything in the mempool. */
  mine(count = 1): void {
    for (let i = 0; i < count; i++) {
      const number = this.tip().number + 1;
      const timestamp = this.now();
      const transfers = this.mempool.map(
        (t, logIndex): TransferEvent => ({
          network: this.network,
          txHash: t.txHash,
          logIndex,
          tokenContract: t.tokenContract,
          fromAddress: t.fromAddress,
          toAddress: t.toAddress,
          amount: t.amount,
          blockNumber: number,
          blockTimestamp: timestamp,
        }),
      );
      this.mempool = [];
      this.blocks.push({ number, timestamp, transfers });
    }
  }

  /**
   * Chain reorganization: drop the last `depth` blocks and replace them with
   * empty ones. Dropped transfers go back to the mempool only if `reinclude`.
   */
  reorg(depth: number, reinclude = false): void {
    if (depth >= this.blocks.length) throw new Error('Reorg deeper than simulated chain');
    const removed = this.blocks.splice(this.blocks.length - depth, depth);
    if (reinclude) {
      for (const block of removed) {
        for (const t of block.transfers) {
          this.mempool.push({ toAddress: t.toAddress, amount: t.amount, fromAddress: t.fromAddress, tokenContract: t.tokenContract, txHash: t.txHash });
        }
      }
    }
    this.mine(depth);
  }

  async getLatestBlockNumber(): Promise<number> {
    return this.tip().number;
  }

  async getTransfers(query: TransferQuery): Promise<TransferEvent[]> {
    return this.blocks
      .filter((b) => b.number >= query.fromBlock && b.number <= query.toBlock)
      .flatMap((b) => b.transfers)
      .filter((t) => query.toAddresses.some((a) => sameAddress(a, t.toAddress)))
      .map((t) => ({ ...t }));
  }

  async isTransferCanonical(txHash: string, logIndex: number): Promise<boolean> {
    return this.blocks.some((b) => b.transfers.some((t) => t.txHash === txHash && t.logIndex === logIndex));
  }

  explorerTxUrl(txHash: string): string {
    return `#simulated-tx-${txHash}`;
  }

  private tip(): Block {
    return this.blocks[this.blocks.length - 1]!;
  }
}

function fakeHash(seed: string): string {
  return `0x${createHash('sha256').update(seed).digest('hex')}`;
}
