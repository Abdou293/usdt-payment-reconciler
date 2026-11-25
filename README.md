# USDT Payment Verification & Reconciliation System

> 🚧 Work in progress — portfolio project. Full documentation arrives in Phase 7.

Automatically detects incoming USDT deposits (TRON TRC20 and an EVM network), matches each one to an order, waits for safe confirmations, notifies the merchant and payer, and produces reconciliation reports.

## ⚠️ Security model: non-custodial and watch-only

- This system **only reads public blockchain data**.
- It **never** holds, requests or stores a private key or seed phrase, and contains no signing code.
- You configure **public receiving addresses only**.

## Disclaimer

This is a portfolio project. It is **not audited** and **not production-hardened**. Nothing here is financial or legal advice. Do not use it with real funds without your own independent review.

## Development

```bash
npm install        # also enables the gitleaks pre-commit hook
npm run typecheck
npm test
npm run scan:all   # secret scan of the folder and the full git history

npm run verify:contracts   # check USDT contract addresses on-chain (read-only)
npm run e2e:readonly       # live end-to-end check on public chain data, no funds
npm run record:fixtures    # re-record real chain responses used by adapter tests
npm run watch              # run the chain watchers using your .env
```

## Verified USDT contracts

| Network | Contract | Official source |
|---|---|---|
| TRON mainnet | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | [tether.to](https://tether.to/en/supported-protocols/) |
| TRON Nile (testnet) | `TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf` | [Nile faucet](https://nileex.io/join/getJoinPage) |
| Arbitrum One (USD₮0) | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | [USDT0 docs](https://docs.usdt0.to/technical-documentation/deployments) |
| Arbitrum Sepolia | none — no official deployment exists | — |

All are checked on-chain (contract code, name, symbol, decimals) by `npm run verify:contracts`.
