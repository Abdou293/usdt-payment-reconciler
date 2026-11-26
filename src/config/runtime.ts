// Build the running system (store, services, adapters, watchers) from the env.

import type { ChainAdapter } from '../chains/ChainAdapter.js';
import { EvmRpcAdapter } from '../chains/evm/EvmRpcAdapter.js';
import { SimulatedChainAdapter, SIMULATED_USDT_CONTRACT } from '../chains/simulated/SimulatedChainAdapter.js';
import { requireUsdtContract } from '../chains/tokens.js';
import { TronGridAdapter } from '../chains/tron/TronGridAdapter.js';
import type { Network } from '../core/types.js';
import { SqliteStore } from '../db/SqliteStore.js';
import type { ServiceConfig, WatchedNetwork } from '../services/config.js';
import { OrderService } from '../services/OrderService.js';
import { PaymentProcessor } from '../services/PaymentProcessor.js';
import { Api } from 'grammy';
import { BotHandlers } from '../bot/BotHandlers.js';
import { GrammyTelegramSender } from '../notifications/GrammyTelegramSender.js';
import type { ExplorerLink } from '../notifications/messages.js';
import { NotificationDispatcher } from '../notifications/NotificationDispatcher.js';
import { ChainWatcher } from '../workers/ChainWatcher.js';
import { AuthService } from '../http/auth.js';
import type { Env } from './env.js';

export interface NetworkRuntime {
  settings: WatchedNetwork;
  adapter: ChainAdapter;
  watcher: ChainWatcher;
  label: string; // human description, e.g. "TRON Nile testnet"
}

export interface Runtime {
  env: Env;
  store: SqliteStore;
  config: ServiceConfig;
  orders: OrderService;
  processor: PaymentProcessor;
  networks: NetworkRuntime[];
  dispatcher: NotificationDispatcher;
  botHandlers: BotHandlers;
  explorerLink: ExplorerLink;
  auth: AuthService;
  /** Only in demo mode: one in-memory simulated chain per demo network (empty otherwise). */
  simulatedChains: Map<Network, SimulatedChainAdapter>;
  warnings: string[];
}

interface EvmNetworkSpec {
  network: 'arbitrum' | 'ethereum' | 'bsc';
  name: string;
  /** Prefix of this network's settings in .env, e.g. BSC_WATCH_ADDRESSES. */
  prefix: 'EVM' | 'ETH' | 'BSC';
  addresses: string[];
  rpcUrl: string | undefined;
  confirmations: number;
  startBlock: number | undefined;
  maxBlocks: number;
  mainnetToken: 'arbitrum-one' | 'ethereum-mainnet' | 'bsc-mainnet';
  explorer: string;
  testnet: { name: string; chainId: number; explorer: string; token: string | undefined; decimals: number };
}

/**
 * The public demo shows every supported network, each on its OWN SIMULATED chain:
 * fake blocks, fake addresses, no real wallet, chain or money. The labels say so.
 */
export const DEMO_NETWORKS: ReadonlyArray<{ network: Network; label: string; addresses: string[] }> = [
  { network: 'tron', label: 'TRON · TRC20 (simulated)', addresses: ['SIM-TRON-ADDRESS-1', 'SIM-TRON-ADDRESS-2'] },
  { network: 'bsc', label: 'BNB Smart Chain · BEP20 (simulated)', addresses: ['SIM-BSC-ADDRESS-1'] },
  { network: 'ethereum', label: 'Ethereum · ERC20 (simulated)', addresses: ['SIM-ETH-ADDRESS-1'] },
  { network: 'arbitrum', label: 'Arbitrum (simulated)', addresses: ['SIM-ARB-ADDRESS-1'] },
];

export function buildRuntime(env: Env): Runtime {
  const store = new SqliteStore(env.DATABASE_URL);
  const warnings: string[] = [];
  const simulatedChains = new Map<Network, SimulatedChainAdapter>();
  const pending: Array<{ settings: WatchedNetwork; adapter: ChainAdapter; label: string; startBlock?: number | undefined; maxBlocks: number }> = [];

  if (env.APP_MODE === 'demo') {
    for (const d of DEMO_NETWORKS) {
      const chain = new SimulatedChainAdapter({ network: d.network });
      simulatedChains.set(d.network, chain);
      pending.push({
        settings: { network: d.network, usdtContract: SIMULATED_USDT_CONTRACT, requiredConfirmations: 3, watchAddresses: d.addresses },
        adapter: chain,
        label: d.label,
        maxBlocks: 1000,
      });
    }
  } else {
    const isMainnet = env.APP_MODE === 'mainnet';

    if (env.TRON_WATCH_ADDRESSES.length > 0) {
      const token = requireUsdtContract(isMainnet ? 'tron-mainnet' : 'tron-nile');
      pending.push({
        settings: { network: 'tron', usdtContract: token.address, requiredConfirmations: env.TRON_CONFIRMATIONS, watchAddresses: env.TRON_WATCH_ADDRESSES },
        adapter: new TronGridAdapter({
          apiUrl: env.TRONGRID_API_URL ?? (isMainnet ? 'https://api.trongrid.io' : 'https://nile.trongrid.io'),
          apiKey: env.TRONGRID_API_KEY,
          tokenContract: token.address,
          explorerUrl: isMainnet ? 'https://tronscan.org' : 'https://nile.tronscan.org',
          http: { retries: 4, backoffMs: 1000 },
        }),
        label: isMainnet ? 'TRON mainnet (READ-ONLY watch)' : 'TRON Nile testnet',
        startBlock: env.TRON_START_BLOCK,
        maxBlocks: 200, // ~10 minutes of TRON blocks per poll
      });
      if (!env.TRONGRID_API_KEY) warnings.push('TRONGRID_API_KEY not set: the free anonymous limit is low and may return HTTP 429.');
    }

    // EVM networks share one adapter; each has its own verified USDT contract.
    const evmNetworks: EvmNetworkSpec[] = [
      {
        network: 'arbitrum', name: 'Arbitrum One', prefix: 'EVM', addresses: env.EVM_WATCH_ADDRESSES, rpcUrl: env.EVM_RPC_URL,
        confirmations: env.EVM_CONFIRMATIONS, startBlock: env.EVM_START_BLOCK, maxBlocks: env.EVM_MAX_BLOCKS_PER_POLL,
        mainnetToken: 'arbitrum-one', explorer: 'https://arbiscan.io',
        testnet: { name: 'Arbitrum Sepolia', chainId: 421614, explorer: 'https://sepolia.arbiscan.io', token: env.EVM_UNVERIFIED_TEST_TOKEN, decimals: 6 },
      },
      {
        network: 'ethereum', name: 'Ethereum', prefix: 'ETH', addresses: env.ETH_WATCH_ADDRESSES, rpcUrl: env.ETH_RPC_URL,
        confirmations: env.ETH_CONFIRMATIONS, startBlock: env.ETH_START_BLOCK, maxBlocks: env.ETH_MAX_BLOCKS_PER_POLL,
        mainnetToken: 'ethereum-mainnet', explorer: 'https://etherscan.io',
        testnet: { name: 'Ethereum Sepolia', chainId: 11155111, explorer: 'https://sepolia.etherscan.io', token: env.ETH_UNVERIFIED_TEST_TOKEN, decimals: 6 },
      },
      {
        network: 'bsc', name: 'BNB Smart Chain', prefix: 'BSC', addresses: env.BSC_WATCH_ADDRESSES, rpcUrl: env.BSC_RPC_URL,
        confirmations: env.BSC_CONFIRMATIONS, startBlock: env.BSC_START_BLOCK, maxBlocks: env.BSC_MAX_BLOCKS_PER_POLL,
        mainnetToken: 'bsc-mainnet', explorer: 'https://bscscan.com',
        testnet: { name: 'BSC testnet', chainId: 97, explorer: 'https://testnet.bscscan.com', token: env.BSC_UNVERIFIED_TEST_TOKEN, decimals: env.BSC_UNVERIFIED_TEST_TOKEN_DECIMALS },
      },
    ];

    for (const n of evmNetworks) {
      if (n.addresses.length === 0) continue;
      if (!n.rpcUrl) throw new Error(`${n.prefix}_WATCH_ADDRESSES is set but ${n.prefix}_RPC_URL is missing`);
      let tokenAddress: string;
      let chainId: number;
      let decimals: number;
      let explorer: string;
      let label: string;
      if (isMainnet) {
        const token = requireUsdtContract(n.mainnetToken);
        tokenAddress = token.address;
        chainId = token.chainId!;
        decimals = token.decimals;
        explorer = n.explorer;
        label = `${n.name} (READ-ONLY watch)`;
        if (token.issuerNote) warnings.push(`${n.name}: ${token.issuerNote}`);
      } else {
        if (!n.testnet.token) {
          throw new Error(`${n.testnet.name} has no official USDT. Set ${n.prefix}_UNVERIFIED_TEST_TOKEN or remove ${n.prefix}_WATCH_ADDRESSES.`);
        }
        tokenAddress = n.testnet.token;
        chainId = n.testnet.chainId;
        decimals = n.testnet.decimals;
        explorer = n.testnet.explorer;
        label = `${n.testnet.name} testnet (unverified test token)`;
        warnings.push(`${n.name} token ${tokenAddress} is a self-deployed TEST token and is NOT verified USDT.`);
      }
      pending.push({
        settings: { network: n.network, usdtContract: tokenAddress, requiredConfirmations: n.confirmations, watchAddresses: n.addresses },
        adapter: new EvmRpcAdapter({
          network: n.network,
          rpcUrl: n.rpcUrl,
          expectedChainId: chainId,
          tokenContract: tokenAddress,
          tokenDecimals: decimals,
          explorerUrl: explorer,
        }),
        label,
        startBlock: n.startBlock,
        maxBlocks: n.maxBlocks,
      });
    }

    if (pending.length === 0) throw new Error(`APP_MODE=${env.APP_MODE} but no watch addresses are configured`);
  }

  const config: ServiceConfig = {
    networks: new Map<Network, WatchedNetwork>(pending.map((p) => [p.settings.network, p.settings])),
    payment: {
      underpayToleranceUnits: env.UNDERPAY_TOLERANCE_UNITS,
      overpayToleranceUnits: env.OVERPAY_TOLERANCE_UNITS,
      lateReservationMinutes: env.LATE_RESERVATION_MINUTES,
    },
    defaultExpiryMinutes: env.ORDER_EXPIRY_MINUTES,
  };
  const orders = new OrderService(store, config);
  const processor = new PaymentProcessor(store, config);
  const networks = pending.map((p) => ({
    settings: p.settings,
    adapter: p.adapter,
    label: p.label,
    watcher: new ChainWatcher(p.adapter, store, processor, {
      usdtContract: p.settings.usdtContract,
      watchAddresses: p.settings.watchAddresses,
      requiredConfirmations: p.settings.requiredConfirmations,
      startBlock: p.startBlock,
      maxBlocksPerPoll: p.maxBlocks,
    }),
  }));

  const adapters = new Map(networks.map((n) => [n.settings.network, n.adapter]));
  const explorerLink: ExplorerLink = (network, txHash) => adapters.get(network)?.explorerTxUrl(txHash) ?? null;

  const telegramEnabled = env.TELEGRAM_BOT_TOKEN !== undefined;
  if (telegramEnabled && !env.TELEGRAM_ADMIN_CHAT_ID) {
    warnings.push('TELEGRAM_ADMIN_CHAT_ID not set: admin alerts (problem payments) will not be sent.');
  }
  const telegramSender = telegramEnabled ? new GrammyTelegramSender(new Api(env.TELEGRAM_BOT_TOKEN!)) : undefined;
  const dispatcher = new NotificationDispatcher(store, {
    context: {
      telegramEnabled,
      adminChatId: env.TELEGRAM_ADMIN_CHAT_ID ?? null,
      webhookEnabled: env.WEBHOOK_URL !== undefined,
      explorer: explorerLink,
    },
    telegram: telegramSender,
    webhook: env.WEBHOOK_URL ? { url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET! } : undefined,
  });
  const botHandlers = new BotHandlers(store, orders, {
    adminChatId: env.TELEGRAM_ADMIN_CHAT_ID ?? null,
    botUsername: env.TELEGRAM_BOT_USERNAME ?? null,
  });

  // Forgot-password codes go to the admin's Telegram chat (never to the browser).
  const adminChatId = env.TELEGRAM_ADMIN_CHAT_ID;
  const resetChannel = telegramSender && adminChatId ? (html: string) => telegramSender.sendMessage(adminChatId, html) : undefined;
  const auth = new AuthService(store, () => new Date(), env.SESSION_TTL_HOURS * 60 * 60_000, resetChannel);
  if (env.APP_MODE !== 'demo' && !env.MERCHANT_API_KEY) warnings.push('MERCHANT_API_KEY not set: the merchant REST API is disabled.');

  return { env, store, config, orders, processor, networks, dispatcher, botHandlers, explorerLink, auth, simulatedChains, warnings };
}
