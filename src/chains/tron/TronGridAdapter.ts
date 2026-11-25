// TRON TRC20 USDT watcher using the free TronGrid HTTP API. READ-ONLY.
//
// How a poll works:
// 1. Convert the block range into a time range (TronGrid's account endpoint filters by time).
// 2. List incoming USDT transfers for each watched address in that time range.
// 3. For each transaction, fetch its receipt (gettransactioninfobyid) to get the exact
//    block number, success status and log index. Failed (reverted) transactions are ignored.

import type { Network, TransferEvent } from '../../core/types.js';
import type { ChainAdapter, TransferQuery } from '../ChainAdapter.js';
import { JsonHttpClient, type HttpOptions } from '../http.js';
import { tronBase58ToHex, tronHexToBase58 } from './address.js';

export const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface TronGridOptions {
  apiUrl: string; //            e.g. https://api.trongrid.io or https://nile.trongrid.io
  apiKey?: string | undefined;
  tokenContract: string; //     base58 USDT contract
  explorerUrl: string; //       e.g. https://tronscan.org
  http?: HttpOptions;
  pageLimit?: number;
  maxPages?: number;
}

interface NowBlock {
  block_header?: { raw_data?: { number?: number; timestamp?: number } };
}
interface Trc20ListResponse {
  data?: Array<{ transaction_id: string; to: string; token_info?: { address?: string } }>;
  meta?: { fingerprint?: string };
  success?: boolean;
}
interface TxInfo {
  id?: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  result?: string;
  receipt?: { result?: string };
  log?: Array<{ address?: string; topics?: string[]; data?: string }>;
}

export class TronGridAdapter implements ChainAdapter {
  readonly network: Network = 'tron';
  private readonly http: JsonHttpClient;
  private readonly baseUrl: string;
  private readonly contractHex: string; // 40 hex chars, no 41 prefix
  private readonly blockTimeCache = new Map<number, number>();

  constructor(private readonly options: TronGridOptions) {
    this.baseUrl = options.apiUrl.replace(/\/+$/, '');
    this.contractHex = tronBase58ToHex(options.tokenContract).slice(2);
    this.http = new JsonHttpClient({
      ...options.http,
      headers: options.apiKey ? { 'TRON-PRO-API-KEY': options.apiKey } : {},
    });
  }

  async getLatestBlockNumber(): Promise<number> {
    const block = await this.http.post<NowBlock>(`${this.baseUrl}/wallet/getnowblock`, {});
    const number = block.block_header?.raw_data?.number;
    if (typeof number !== 'number') throw new Error('TronGrid: unexpected getnowblock response');
    return number;
  }

  async getTransfers(query: TransferQuery): Promise<TransferEvent[]> {
    if (tronBase58ToHex(query.tokenContract).slice(2) !== this.contractHex) {
      throw new Error('TronGrid adapter was configured for a different token contract');
    }
    const minTs = await this.blockTimestamp(query.fromBlock);
    const maxTs = await this.blockTimestamp(query.toBlock);

    const txIds = new Set<string>();
    for (const address of query.toAddresses) {
      for (const id of await this.listIncomingTxIds(address, minTs, maxTs)) txIds.add(id);
    }

    const watched = new Set(query.toAddresses);
    const events: TransferEvent[] = [];
    for (const txId of txIds) {
      for (const event of await this.transfersInTransaction(txId, watched)) {
        if (event.blockNumber >= query.fromBlock && event.blockNumber <= query.toBlock) events.push(event);
      }
    }
    return events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }

  async isTransferCanonical(txHash: string, logIndex: number): Promise<boolean> {
    const info = await this.txInfo(txHash);
    if (!this.isSuccessful(info)) return false;
    const log = info.log?.[logIndex];
    return !!log && this.isUsdtTransferLog(log);
  }

  explorerTxUrl(txHash: string): string {
    return `${this.options.explorerUrl.replace(/\/+$/, '')}/#/transaction/${txHash}`;
  }

  // ---------------------------------------------------------------

  private async listIncomingTxIds(address: string, minTs: number, maxTs: number): Promise<string[]> {
    const ids: string[] = [];
    let fingerprint: string | undefined;
    const maxPages = this.options.maxPages ?? 20;
    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        only_to: 'true',
        contract_address: this.options.tokenContract,
        min_timestamp: String(minTs),
        max_timestamp: String(maxTs),
        limit: String(this.options.pageLimit ?? 200),
        order_by: 'block_timestamp,asc',
      });
      if (fingerprint) params.set('fingerprint', fingerprint);
      const response = await this.http.get<Trc20ListResponse>(
        `${this.baseUrl}/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${params.toString()}`,
      );
      if (response.success === false) throw new Error('TronGrid: trc20 list request failed');
      for (const item of response.data ?? []) {
        if (item.to === address) ids.push(item.transaction_id);
      }
      fingerprint = response.meta?.fingerprint;
      if (!fingerprint) return ids;
    }
    throw new Error(`TronGrid: more than ${maxPages} pages for ${address}; reduce maxBlocksPerPoll`);
  }

  private async transfersInTransaction(txId: string, watched: Set<string>): Promise<TransferEvent[]> {
    const info = await this.txInfo(txId);
    // Not yet in a block, or reverted: a failed transfer moved no money.
    if (typeof info.blockNumber !== 'number' || typeof info.blockTimeStamp !== 'number') return [];
    if (!this.isSuccessful(info)) return [];

    const events: TransferEvent[] = [];
    (info.log ?? []).forEach((log, logIndex) => {
      if (!this.isUsdtTransferLog(log)) return;
      const to = tronHexToBase58(log.topics![2]!.slice(-40));
      if (!watched.has(to)) return;
      events.push({
        network: 'tron',
        txHash: txId,
        logIndex,
        tokenContract: this.options.tokenContract,
        fromAddress: tronHexToBase58(log.topics![1]!.slice(-40)),
        toAddress: to,
        amount: BigInt(`0x${log.data || '0'}`),
        blockNumber: info.blockNumber!,
        blockTimestamp: new Date(info.blockTimeStamp!),
      });
    });
    return events;
  }

  private isUsdtTransferLog(log: { address?: string; topics?: string[] }): boolean {
    return (
      (log.address ?? '').toLowerCase().replace(/^41/, '').slice(-40) === this.contractHex &&
      log.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC &&
      log.topics.length >= 3
    );
  }

  private isSuccessful(info: TxInfo): boolean {
    return info.result !== 'FAILED' && info.receipt?.result === 'SUCCESS';
  }

  private txInfo(txId: string): Promise<TxInfo> {
    if (!/^[0-9a-fA-F]{64}$/.test(txId)) throw new Error(`Invalid TRON tx id: ${txId}`);
    return this.http.post<TxInfo>(`${this.baseUrl}/wallet/gettransactioninfobyid`, { value: txId });
  }

  private async blockTimestamp(num: number): Promise<number> {
    const cached = this.blockTimeCache.get(num);
    if (cached !== undefined) return cached;
    const block = await this.http.post<NowBlock>(`${this.baseUrl}/wallet/getblockbynum`, { num });
    const ts = block.block_header?.raw_data?.timestamp;
    if (typeof ts !== 'number') throw new Error(`TronGrid: block ${num} not found`);
    if (this.blockTimeCache.size > 1000) this.blockTimeCache.clear();
    this.blockTimeCache.set(num, ts);
    return ts;
  }
}
