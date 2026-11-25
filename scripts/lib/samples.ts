// Find a recent, real, already-confirmed USDT transfer on a public chain.
// Read-only: used by fixture recording and the read-only end-to-end check.

import { JsonHttpClient } from '../../src/chains/http.js';
import { tronHexToBase58 } from '../../src/chains/tron/address.js';

const http = new JsonHttpClient({ timeoutMs: 20_000, retries: 5, backoffMs: 1500 });

export interface SampleTransfer {
  txHash: string;
  blockNumber: number;
  toAddress: string;
  amountUnits: bigint;
  logIndex: number;
}

/** A recent TRON USDT transfer at least `depth` blocks deep. */
export async function findTronSample(apiUrl: string, contract: string, depth: number): Promise<SampleTransfer> {
  const now = await http.post<{ block_header: { raw_data: { number: number } } }>(`${apiUrl}/wallet/getnowblock`, {});
  const maxBlock = now.block_header.raw_data.number - depth;
  const res = await http.get<{ data: Array<{ block_number: number; transaction_id: string; event_index: number; result: { to: string; value: string } }> }>(
    `${apiUrl}/v1/contracts/${contract}/events?event_name=Transfer&only_confirmed=true&limit=50&order_by=block_timestamp,desc`,
  );
  const pick = res.data.find((e) => e.block_number <= maxBlock && BigInt(e.result.value) > 0n) ?? res.data.at(-1);
  if (!pick) throw new Error('No TRON sample transfer found');
  return {
    txHash: pick.transaction_id,
    blockNumber: pick.block_number,
    toAddress: tronHexToBase58(pick.result.to),
    amountUnits: BigInt(pick.result.value),
    logIndex: pick.event_index,
  };
}

/** A recent EVM token transfer at least `depth` blocks deep. */
export async function findEvmSample(rpcUrl: string, contract: string, depth: number): Promise<SampleTransfer> {
  const rpc = async <T>(method: string, params: unknown[]) =>
    (await http.post<{ result: T }>(rpcUrl, { jsonrpc: '2.0', id: 1, method, params })).result;
  const latest = Number.parseInt(await rpc<string>('eth_blockNumber', []), 16);
  const to = latest - depth;
  const logs = await rpc<Array<{ blockNumber: string; transactionHash: string; logIndex: string; topics: string[]; data: string }>>('eth_getLogs', [
    {
      fromBlock: `0x${(to - 200).toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
      address: contract,
      topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
    },
  ]);
  // Prefer a recipient that received exactly ONE transfer in that block, so the
  // sample order's expected amount is unambiguous.
  const perRecipientBlock = new Map<string, number>();
  for (const l of logs) {
    const k = `${l.topics[2]}:${l.blockNumber}`;
    perRecipientBlock.set(k, (perRecipientBlock.get(k) ?? 0) + 1);
  }
  const pick = logs.find((l) => BigInt(l.data) > 0n && perRecipientBlock.get(`${l.topics[2]}:${l.blockNumber}`) === 1);
  if (!pick) throw new Error('No EVM sample transfer found');
  return {
    txHash: pick.transactionHash.toLowerCase(),
    blockNumber: Number.parseInt(pick.blockNumber, 16),
    toAddress: `0x${pick.topics[2]!.slice(-40)}`,
    amountUnits: BigInt(pick.data),
    logIndex: Number.parseInt(pick.logIndex, 16),
  };
}
