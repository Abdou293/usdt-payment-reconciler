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
```
