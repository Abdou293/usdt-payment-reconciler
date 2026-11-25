// Polls one chain adapter and feeds transfers to the PaymentProcessor.
//
// Designed for free hosts that SLEEP: nothing important lives only in memory.
// The last scanned block (the "cursor") is saved in the database after every
// poll, so after a restart the watcher resumes exactly where it stopped.
// Each poll also re-scans the last few blocks (overlap) to catch transfers that
// moved during a chain reorganization; duplicates are ignored by idempotency.

import type { ChainAdapter } from '../chains/ChainAdapter.js';
import type { Store } from '../db/Store.js';
import type { PaymentProcessor } from '../services/PaymentProcessor.js';
import type { Clock } from '../services/config.js';

export interface WatcherOptions {
  usdtContract: string;
  watchAddresses: readonly string[];
  requiredConfirmations: number;
  /** Where to begin on the very first run (default: the current chain tip). */
  startBlock?: number;
  /** Max blocks per poll, to respect free API limits. */
  maxBlocksPerPoll?: number;
  now?: Clock;
}

export interface PollResult {
  ok: boolean;
  fromBlock: number | null;
  toBlock: number | null;
  latestBlock: number | null;
  transfersSeen: number;
  orphaned: number;
  caughtUp: boolean;
  error?: string;
}

export class ChainWatcher {
  private readonly now: Clock;

  constructor(
    private readonly adapter: ChainAdapter,
    private readonly store: Store,
    private readonly processor: PaymentProcessor,
    private readonly options: WatcherOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async pollOnce(): Promise<PollResult> {
    const network = this.adapter.network;
    const state = await this.store.getChainState(network);
    const pollAt = this.now();
    try {
      const latest = await this.adapter.getLatestBlockNumber();
      const rescanDepth = Math.max(1, this.options.requiredConfirmations);
      const fromBlock =
        state.cursorBlock === null
          ? (this.options.startBlock ?? latest)
          : Math.max(0, state.cursorBlock + 1 - rescanDepth);
      const toBlock = Math.min(latest, fromBlock + (this.options.maxBlocksPerPoll ?? 1000) - 1);

      let transfersSeen = 0;
      if (fromBlock <= toBlock) {
        const transfers = await this.adapter.getTransfers({
          fromBlock,
          toBlock,
          tokenContract: this.options.usdtContract,
          toAddresses: this.options.watchAddresses,
        });
        transfersSeen = transfers.length;
        for (const transfer of transfers) await this.processor.ingestTransfer(transfer);
      }

      // Save progress BEFORE confirmation updates so a crash never loses the cursor.
      const cursorBlock = Math.max(state.cursorBlock ?? -1, toBlock);
      await this.store.saveChainState({
        network,
        cursorBlock,
        latestBlock: latest,
        lastPollAt: pollAt,
        lastSuccessAt: pollAt,
        lastError: null,
      });

      const orphaned = await this.detectReorgs(latest);
      await this.processor.refreshConfirmations(network);
      await this.processor.expireOrders();

      return { ok: true, fromBlock, toBlock, latestBlock: latest, transfersSeen, orphaned, caughtUp: cursorBlock >= latest };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.saveChainState({ ...state, lastPollAt: pollAt, lastError: message.slice(0, 500) });
      return { ok: false, fromBlock: null, toBlock: null, latestBlock: null, transfersSeen: 0, orphaned: 0, caughtUp: false, error: message };
    }
  }

  /** Poll repeatedly until the cursor reaches the chain tip (after a long sleep). */
  async catchUp(maxPolls = 100): Promise<PollResult[]> {
    const results: PollResult[] = [];
    for (let i = 0; i < maxPolls; i++) {
      const result = await this.pollOnce();
      results.push(result);
      if (!result.ok || result.caughtUp) break;
    }
    return results;
  }

  /** Check that recent, not-yet-final payments are still on the canonical chain. */
  private async detectReorgs(latest: number): Promise<number> {
    const window = this.options.requiredConfirmations * 2 + 1;
    const recent = await this.store.listRecentMatchedPayments(this.adapter.network, latest - window);
    let orphaned = 0;
    for (const payment of recent) {
      const canonical = await this.adapter.isTransferCanonical(payment.txHash, payment.logIndex);
      if (!canonical) {
        await this.processor.markOrphaned(payment.network, payment.txHash, payment.logIndex);
        orphaned += 1;
      }
    }
    return orphaned;
  }
}
