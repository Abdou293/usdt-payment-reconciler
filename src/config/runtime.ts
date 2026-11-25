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
  /** Only in demo mode: the in-memory simulated chain. */
  simulatedChain: SimulatedChainAdapter | null;
  warnings: string[];
}

export const DEMO_ADDRESSES = ['SIM-DEMO-ADDRESS-1', 'SIM-DEMO-ADDRESS-2'];

export function buildRuntime(env: Env): Runtime {
  const store = new SqliteStore(env.DATABASE_URL);
  const warnings: string[] = [];
  let simulatedChain: SimulatedChainAdapter | null = null;
  const pending: Array<{ settings: WatchedNetwork; adapter: ChainAdapter; label: string; startBlock?: number | undefined; maxBlocks: number }> = [];

  if (env.APP_MODE === 'demo') {
    simulatedChain = new SimulatedChainAdapter();
    pending.push({
      settings: { network: 'simulated', usdtContract: SIMULATED_USDT_CONTRACT, requiredConfirmations: 3, watchAddresses: DEMO_ADDRESSES },
      adapter: simulatedChain,
      label: 'Simulated chain (demo mode, no real funds)',
      maxBlocks: 1000,
    });
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

    if (env.EVM_WATCH_ADDRESSES.length > 0) {
      if (!env.EVM_RPC_URL) throw new Error('EVM_WATCH_ADDRESSES is set but EVM_RPC_URL is missing');
      let tokenAddress: string;
      let chainId: number;
      if (isMainnet) {
        const token = requireUsdtContract('arbitrum-one');
        tokenAddress = token.address;
        chainId = token.chainId!;
      } else {
        if (!env.EVM_UNVERIFIED_TEST_TOKEN) {
          throw new Error('Arbitrum Sepolia has no official USDT. Set EVM_UNVERIFIED_TEST_TOKEN or remove EVM_WATCH_ADDRESSES.');
        }
        tokenAddress = env.EVM_UNVERIFIED_TEST_TOKEN;
        chainId = 421614; // Arbitrum Sepolia
        warnings.push(`EVM token ${tokenAddress} is a self-deployed TEST token and is NOT verified USDT.`);
      }
      pending.push({
        settings: { network: 'arbitrum', usdtContract: tokenAddress, requiredConfirmations: env.EVM_CONFIRMATIONS, watchAddresses: env.EVM_WATCH_ADDRESSES },
        adapter: new EvmRpcAdapter({
          network: 'arbitrum',
          rpcUrl: env.EVM_RPC_URL,
          expectedChainId: chainId,
          tokenContract: tokenAddress,
          explorerUrl: isMainnet ? 'https://arbiscan.io' : 'https://sepolia.arbiscan.io',
        }),
        label: isMainnet ? 'Arbitrum One (READ-ONLY watch)' : 'Arbitrum Sepolia testnet (unverified test token)',
        startBlock: env.EVM_START_BLOCK,
        maxBlocks: env.EVM_MAX_BLOCKS_PER_POLL,
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
  const dispatcher = new NotificationDispatcher(store, {
    context: {
      telegramEnabled,
      adminChatId: env.TELEGRAM_ADMIN_CHAT_ID ?? null,
      webhookEnabled: env.WEBHOOK_URL !== undefined,
      explorer: explorerLink,
    },
    telegram: telegramEnabled ? new GrammyTelegramSender(new Api(env.TELEGRAM_BOT_TOKEN!)) : undefined,
    webhook: env.WEBHOOK_URL ? { url: env.WEBHOOK_URL, secret: env.WEBHOOK_SECRET! } : undefined,
  });
  const botHandlers = new BotHandlers(store, orders, {
    adminChatId: env.TELEGRAM_ADMIN_CHAT_ID ?? null,
    botUsername: env.TELEGRAM_BOT_USERNAME ?? null,
  });

  const auth = new AuthService(store, () => new Date(), env.SESSION_TTL_HOURS * 60 * 60_000);
  if (env.APP_MODE !== 'demo' && !env.MERCHANT_API_KEY) warnings.push('MERCHANT_API_KEY not set: the merchant REST API is disabled.');

  return { env, store, config, orders, processor, networks, dispatcher, botHandlers, explorerLink, auth, simulatedChain, warnings };
}
