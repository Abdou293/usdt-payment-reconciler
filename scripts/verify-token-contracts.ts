// Verify every USDT contract in src/chains/tokens.ts ON-CHAIN (read-only calls):
// the contract exists, and its name / symbol / decimals are what we expect.
// Usage: npm run verify:contracts
// Optional env: TRON_MAINNET_API, TRON_NILE_API, ARBITRUM_ONE_RPC

import { USDT_CONTRACTS, type TokenContractInfo } from '../src/chains/tokens.js';
import { JsonHttpClient } from '../src/chains/http.js';

const http = new JsonHttpClient({ timeoutMs: 20_000, retries: 5, backoffMs: 1500 });

const ENDPOINTS = {
  'tron-mainnet': process.env.TRON_MAINNET_API ?? 'https://api.trongrid.io',
  'tron-nile': process.env.TRON_NILE_API ?? 'https://nile.trongrid.io',
  'arbitrum-one': process.env.ARBITRUM_ONE_RPC ?? 'https://arb1.arbitrum.io/rpc',
} as const;

interface Result {
  environment: string;
  address: string;
  name: string;
  symbol: string;
  decimals: number | null;
  ok: boolean;
  problems: string[];
}

/** Decode an ABI-encoded `string` return value. */
function decodeAbiString(hex: string): string {
  const clean = hex.replace(/^0x/, '');
  if (clean.length < 128) return '';
  const length = Number.parseInt(clean.slice(64, 128), 16);
  return Buffer.from(clean.slice(128, 128 + length * 2), 'hex').toString('utf8');
}

async function tronCall(api: string, contract: string, selector: string): Promise<string> {
  const res = await http.post<{ constant_result?: string[]; result?: { result?: boolean; message?: string } }>(
    `${api}/wallet/triggerconstantcontract`,
    { owner_address: contract, contract_address: contract, function_selector: selector, parameter: '', visible: true },
  );
  const out = res.constant_result?.[0];
  if (!out) throw new Error(`no result for ${selector}`);
  return out;
}

async function verifyTron(info: TokenContractInfo, api: string): Promise<Result> {
  const problems: string[] = [];
  const contract = await http.post<{ bytecode?: string }>(`${api}/wallet/getcontract`, { value: info.address, visible: true });
  if (!contract.bytecode) problems.push('no contract code at this address');
  const name = decodeAbiString(await tronCall(api, info.address, 'name()'));
  const symbol = decodeAbiString(await tronCall(api, info.address, 'symbol()'));
  const decimals = Number.parseInt(await tronCall(api, info.address, 'decimals()'), 16);
  return finish(info, name, symbol, decimals, problems);
}

async function evmRpc<T>(rpc: string, method: string, params: unknown[]): Promise<T> {
  const res = await http.post<{ result?: T; error?: { message: string } }>(rpc, { jsonrpc: '2.0', id: 1, method, params });
  if (res.error) throw new Error(`${method}: ${res.error.message}`);
  return res.result as T;
}

async function verifyEvm(info: TokenContractInfo, rpc: string): Promise<Result> {
  const problems: string[] = [];
  const chainId = Number.parseInt(await evmRpc<string>(rpc, 'eth_chainId', []), 16);
  if (chainId !== info.chainId) problems.push(`RPC chain id ${chainId}, expected ${info.chainId}`);
  const code = await evmRpc<string>(rpc, 'eth_getCode', [info.address, 'latest']);
  if (!code || code === '0x') problems.push('no contract code at this address');
  const call = (data: string) => evmRpc<string>(rpc, 'eth_call', [{ to: info.address, data }, 'latest']);
  const name = decodeAbiString(await call('0x06fdde03'));
  const symbol = decodeAbiString(await call('0x95d89b41'));
  const decimals = Number.parseInt(await call('0x313ce567'), 16);
  return finish(info, name, symbol, decimals, problems);
}

function finish(info: TokenContractInfo, name: string, symbol: string, decimals: number, problems: string[]): Result {
  if (symbol !== info.expectedSymbol) problems.push(`symbol "${symbol}", expected "${info.expectedSymbol}"`);
  if (decimals !== info.decimals) problems.push(`decimals ${decimals}, expected ${info.decimals}`);
  return { environment: info.environment, address: info.address, name, symbol, decimals, ok: problems.length === 0, problems };
}

async function main(): Promise<void> {
  const results: Result[] = [];
  for (const info of Object.values(USDT_CONTRACTS)) {
    if (!info) continue;
    try {
      const result = info.environment.startsWith('tron')
        ? await verifyTron(info, ENDPOINTS[info.environment as 'tron-mainnet' | 'tron-nile'])
        : await verifyEvm(info, ENDPOINTS[info.environment as 'arbitrum-one']);
      results.push(result);
    } catch (error) {
      results.push({
        environment: info.environment, address: info.address, name: '', symbol: '', decimals: null,
        ok: false, problems: [`could not verify: ${(error as Error).message}`],
      });
    }
  }

  console.log('\nUSDT contract verification (on-chain, read-only)\n');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.environment.padEnd(15)} ${r.address}`);
    console.log(`      name="${r.name}" symbol="${r.symbol}" decimals=${r.decimals}`);
    for (const p of r.problems) console.log(`      problem: ${p}`);
  }
  console.log('\narbitrum-sepolia: SKIPPED - no official USDT deployment exists to verify.\n');
  if (results.some((r) => !r.ok)) process.exit(1);
}

await main();
