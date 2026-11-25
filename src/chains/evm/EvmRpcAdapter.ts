// EVM (Arbitrum, Ethereum, BNB Smart Chain) USDT watcher using standard JSON-RPC. READ-ONLY:
// only eth_chainId, eth_blockNumber, eth_getLogs, eth_getBlockByNumber and
// eth_getTransactionReceipt are used. Nothing is ever signed or sent.

import { toCanonicalUnits } from '../../core/money.js';
import type { Network, TransferEvent } from '../../core/types.js';
import type { ChainAdapter, TransferQuery } from '../ChainAdapter.js';
import { JsonHttpClient, redact, type HttpOptions } from '../http.js';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface EvmRpcOptions {
  network: Network; //          'arbitrum' | 'ethereum' | 'bsc'
  rpcUrl: string;
  /** Decimals of the token contract (6 for most USDT, 18 on BSC). Default 6. */
  tokenDecimals?: number;
  expectedChainId: number;
  tokenContract: string;
  explorerUrl: string; //       e.g. https://arbiscan.io
  http?: HttpOptions;
}

interface RpcResponse<T> {
  result?: T;
  error?: { code: number; message: string };
}
interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
}
interface RpcReceipt {
  status: string;
  blockNumber: string;
  logs: RpcLog[];
}

export class EvmRpcAdapter implements ChainAdapter {
  readonly network: Network;
  private readonly http: JsonHttpClient;
  private readonly contract: string;
  private chainIdChecked = false;
  private requestId = 0;
  private readonly blockTimeCache = new Map<number, number>();

  constructor(private readonly options: EvmRpcOptions) {
    if (!EVM_ADDRESS.test(options.tokenContract)) throw new Error('Invalid EVM token contract address');
    this.network = options.network;
    this.contract = options.tokenContract.toLowerCase();
    this.http = new JsonHttpClient(options.http);
  }

  async getLatestBlockNumber(): Promise<number> {
    await this.assertChainId();
    return hexToNumber(await this.rpc<string>('eth_blockNumber', []));
  }

  async getTransfers(query: TransferQuery): Promise<TransferEvent[]> {
    await this.assertChainId();
    if (query.tokenContract.toLowerCase() !== this.contract) {
      throw new Error('EVM adapter was configured for a different token contract');
    }
    if (query.toAddresses.length === 0) return [];
    for (const a of query.toAddresses) {
      if (!EVM_ADDRESS.test(a)) throw new Error(`Invalid EVM watch address: ${a}`);
    }
    const toTopics = query.toAddresses.map(addressToTopic);
    const logs = await this.rpc<RpcLog[]>('eth_getLogs', [
      {
        fromBlock: numberToHex(query.fromBlock),
        toBlock: numberToHex(query.toBlock),
        address: this.contract,
        topics: [TRANSFER_TOPIC, null, toTopics],
      },
    ]);

    const events: TransferEvent[] = [];
    for (const log of logs) {
      if (log.removed) continue; // the node already knows this log was reorged out
      if (log.address.toLowerCase() !== this.contract || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
      const blockNumber = hexToNumber(log.blockNumber);
      events.push({
        network: this.network,
        txHash: log.transactionHash.toLowerCase(),
        logIndex: hexToNumber(log.logIndex),
        tokenContract: this.contract,
        fromAddress: topicToAddress(log.topics[1]!),
        toAddress: topicToAddress(log.topics[2]!),
        ...this.amountOf(BigInt(log.data === '0x' ? '0' : log.data)),
        blockNumber,
        // The log's own blockTimestamp field is unreliable on some RPCs ("0x0"),
        // so the time is read from the block header.
        blockTimestamp: new Date((await this.blockTimestamp(blockNumber)) * 1000),
      });
    }
    return events.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }

  async isTransferCanonical(txHash: string, logIndex: number): Promise<boolean> {
    const receipt = await this.rpc<RpcReceipt | null>('eth_getTransactionReceipt', [txHash]);
    if (!receipt || receipt.status !== '0x1') return false;
    return receipt.logs.some(
      (l) =>
        hexToNumber(l.logIndex) === logIndex &&
        l.address.toLowerCase() === this.contract &&
        l.topics[0]?.toLowerCase() === TRANSFER_TOPIC,
    );
  }

  /** Raw on-chain value -> internal 6-decimal unit (rounded down), plus the raw value for the audit log. */
  private amountOf(rawValue: bigint): Pick<TransferEvent, 'amount' | 'raw'> {
    const decimals = this.options.tokenDecimals ?? 6;
    const { units, dust } = toCanonicalUnits(rawValue, decimals);
    if (decimals === 6) return { amount: units };
    return { amount: units, raw: { amount: rawValue.toString(), decimals, dustIgnored: dust.toString() } };
  }

  explorerTxUrl(txHash: string): string {
    return `${this.options.explorerUrl.replace(/\/+$/, '')}/tx/${txHash}`;
  }

  // ---------------------------------------------------------------

  /** Refuse to run against the wrong chain (e.g. a mainnet RPC in testnet mode). */
  private async assertChainId(): Promise<void> {
    if (this.chainIdChecked) return;
    const chainId = hexToNumber(await this.rpc<string>('eth_chainId', []));
    if (chainId !== this.options.expectedChainId) {
      throw new Error(`RPC chain id ${chainId} does not match expected ${this.options.expectedChainId}`);
    }
    this.chainIdChecked = true;
  }

  private async blockTimestamp(num: number): Promise<number> {
    const cached = this.blockTimeCache.get(num);
    if (cached !== undefined) return cached;
    const block = await this.rpc<{ timestamp: string } | null>('eth_getBlockByNumber', [numberToHex(num), false]);
    if (!block) throw new Error(`Block ${num} not found`);
    const ts = hexToNumber(block.timestamp);
    if (this.blockTimeCache.size > 1000) this.blockTimeCache.clear();
    this.blockTimeCache.set(num, ts);
    return ts;
  }

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    this.requestId += 1;
    const response = await this.http.post<RpcResponse<T>>(this.options.rpcUrl, {
      jsonrpc: '2.0',
      id: this.requestId,
      method,
      params,
    });
    if (response.error) {
      throw new Error(`RPC ${method} failed at ${redact(this.options.rpcUrl)}: ${response.error.message}`);
    }
    return response.result as T;
  }
}

export function hexToNumber(hex: string): number {
  const value = Number.parseInt(hex, 16);
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid hex number: ${hex}`);
  return value;
}

export function numberToHex(n: number): string {
  return `0x${n.toString(16)}`;
}

function addressToTopic(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
}

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40).toLowerCase()}`;
}
