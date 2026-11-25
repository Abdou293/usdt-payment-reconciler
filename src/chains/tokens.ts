// USDT contract registry. Every address here was copied from an OFFICIAL source
// (listed next to it) and is checked on-chain by `npm run verify:contracts`.
// Never add an address from a blog, forum or AI answer without that check.

export type ChainEnvironment =
  | 'tron-mainnet'
  | 'tron-nile'
  | 'arbitrum-one'
  | 'arbitrum-sepolia'
  | 'ethereum-mainnet'
  | 'bsc-mainnet';

export interface TokenContractInfo {
  environment: ChainEnvironment;
  address: string;
  decimals: number;
  expectedSymbol: string;
  /** EVM only: the chain id the RPC must report. */
  chainId?: number;
  source: string;
  /** Who issues the token, when it is not Tether itself. */
  issuerNote?: string;
  isTestnet: boolean;
}

export const USDT_CONTRACTS: Partial<Record<ChainEnvironment, TokenContractInfo>> = {
  'tron-mainnet': {
    environment: 'tron-mainnet',
    address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    expectedSymbol: 'USDT',
    source: 'https://tether.to/en/supported-protocols/ (Tether, TRC20 section)',
    isTestnet: false,
  },
  'tron-nile': {
    environment: 'tron-nile',
    address: 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf',
    decimals: 6,
    expectedSymbol: 'USDT',
    source:
      'https://nileex.io/join/getJoinPage (official Nile faucet, linked from developers.tron.network). Test token, no value.',
    isTestnet: true,
  },
  'arbitrum-one': {
    environment: 'arbitrum-one',
    address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
    decimals: 6,
    expectedSymbol: 'USD₮0',
    chainId: 42161,
    source: 'https://docs.usdt0.to/technical-documentation/deployments (USDT0 "Token" entry for Arbitrum One)',
    isTestnet: false,
  },
  'ethereum-mainnet': {
    environment: 'ethereum-mainnet',
    address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    decimals: 6,
    expectedSymbol: 'USDT',
    chainId: 1,
    source: 'https://tether.to/en/supported-protocols/ (Tether, "Ethereum Network" USD₮ contract address)',
    isTestnet: false,
  },
  'bsc-mainnet': {
    environment: 'bsc-mainnet',
    address: '0x55d398326f99059fF775485246999027B3197955',
    // NOTE: 18 decimals, not 6. Amounts are converted to the internal 6-decimal
    // unit by the adapter (see toCanonicalUnits in src/core/money.ts).
    decimals: 18,
    expectedSymbol: 'USDT',
    chainId: 56,
    source:
      'https://www.binance.com/en/proof-of-collateral (Binance, USDT "Wrapped Token" BEP20 contract). ' +
      'Tether lists BNB Smart Chain as a supported protocol but publishes no USDT address for it.',
    issuerNote: 'Binance-Peg token, issued and backed by Binance (not by Tether).',
    isTestnet: false,
  },
  // No official USDT on Ethereum Sepolia or BSC testnet either: testnet runs
  // use the simulated adapter or a self-deployed token marked UNVERIFIED.
  // 'arbitrum-sepolia': intentionally absent. Tether/USDT0 publish NO official
  // USDT on Arbitrum Sepolia, so there is nothing we can verify. EVM testnet
  // runs use the simulated adapter or a test token you deploy yourself and
  // configure explicitly as UNVERIFIED (see .env.example).
};

export function requireUsdtContract(environment: ChainEnvironment): TokenContractInfo {
  const info = USDT_CONTRACTS[environment];
  if (!info) {
    throw new Error(`No verified USDT contract for ${environment}. See src/chains/tokens.ts.`);
  }
  return info;
}
