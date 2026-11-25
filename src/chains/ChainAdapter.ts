// The one interface every blockchain "watcher" adapter implements.
// Adapters are READ-ONLY: they only query public chain data.
// There is deliberately no method that signs or sends anything.

import type { Network, TransferEvent } from '../core/types.js';

export interface TransferQuery {
  fromBlock: number;
  toBlock: number;
  tokenContract: string;
  toAddresses: readonly string[];
}

export interface ChainAdapter {
  readonly network: Network;

  /** Highest block number currently known to the chain. */
  getLatestBlockNumber(): Promise<number>;

  /** Incoming token transfers to the watched addresses in [fromBlock, toBlock]. */
  getTransfers(query: TransferQuery): Promise<TransferEvent[]>;

  /**
   * Is this transfer still part of the canonical chain?
   * Returns false if a chain reorganization removed it.
   */
  isTransferCanonical(txHash: string, logIndex: number): Promise<boolean>;

  /** Public block-explorer link for a transaction. */
  explorerTxUrl(txHash: string): string;
}
