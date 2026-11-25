# USDT Payment Verification & Reconciliation System

> 🚧 Work in progress — portfolio project. Full documentation arrives in Phase 7.

Automatically detects incoming USDT deposits (TRON TRC20 and an EVM network), matches each one to an order, waits for safe confirmations, notifies the merchant and payer, and produces reconciliation reports.

## ⚠️ Security model: non-custodial and watch-only

- This system **only reads public blockchain data**.
- It **never** holds, requests or stores a private key or seed phrase, and contains no signing code.
- You configure **public receiving addresses only**.

## Disclaimer

This is a portfolio project. It is **not audited** and **not production-hardened**. Nothing here is financial or legal advice. Do not use it with real funds without your own independent review.

**Live demo (simulated chain, no real funds):** https://usdt-payment-reconciler-demo.onrender.com
(free host: the first visit after a quiet period can take up to a minute to wake up)

## Run the demo locally (no wallet, no API keys)

```bash
npm install
npm run dashboard:install
npm run dashboard:build
npm run dev                # APP_MODE=demo by default -> http://localhost:3000
```

Log in with the demo account shown on the login page. Demo mode seeds one week of
simulated orders and payments and adds simulator buttons (pay, underpay, overpay,
wrong token, mine blocks, reorg). Nothing touches a real blockchain.

Deploying (free demo on Render, or a real merchant install): see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## HTTP API (summary)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `POST /api/v1/orders` | `Authorization: Bearer <MERCHANT_API_KEY>` | Create a payment request. Supports `Idempotency-Key`. |
| `GET /api/v1/orders/:id` | API key | Order status and matched payments. |
| `/admin/api/*` | Session cookie + `X-CSRF-Token` | Dashboard API: orders, review queue, reports, CSV export, health. |
| `GET /healthz` | none | Liveness check. |

Amounts are always decimal **strings** (for example `"49.99"`), never floating-point numbers.

## Development

```bash
npm install        # also enables the gitleaks pre-commit hook
npm run typecheck
npm test
npm run scan:all   # secret scan of the folder and the full git history

npm run dashboard:dev      # dashboard with hot reload on :5173 (API proxied to :3000)
npm run verify:contracts   # check USDT contract addresses on-chain (read-only)
npm run e2e:readonly       # live end-to-end check on public chain data, no funds
npm run record:fixtures    # re-record real chain responses used by adapter tests
```

## Verified USDT contracts

| Network | Contract | Official source |
|---|---|---|
| TRON mainnet | `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` | [tether.to](https://tether.to/en/supported-protocols/) |
| TRON Nile (testnet) | `TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf` | [Nile faucet](https://nileex.io/join/getJoinPage) |
| Arbitrum One (USD₮0) | `0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9` | [USDT0 docs](https://docs.usdt0.to/technical-documentation/deployments) |
| Arbitrum Sepolia | none — no official deployment exists | — |

All are checked on-chain (contract code, name, symbol, decimals) by `npm run verify:contracts`.
