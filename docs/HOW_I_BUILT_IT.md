# How I built it

This project was built with **AI-assisted development**: I worked with an AI coding assistant
(Claude, by Anthropic) acting as a pair programmer, while I owned the requirements, the rules and
every approval. This page explains how, because I think the process matters as much as the code.

## My role

- **Wrote the specification:** features, order states, edge cases (duplicates, tolerances, late
  payments, wrong token or network, reorgs), the stack and the hosting constraints.
- **Set non-negotiable security rules before any code was written,** for example:
  - no private keys, seed phrases or signing code anywhere; watch-only addresses only;
  - never hardcode secrets; `.env` git-ignored from the first commit;
  - secret scanning (gitleaks) as a pre-commit hook, full history scan before every push, and my
    explicit confirmation before the first push;
  - integer-safe money arithmetic, no floating point;
  - token contract addresses taken from official sources and **verified on-chain by a script**, never
    guessed;
  - no fake metrics: only report what tests actually produced;
  - no real money: mainnet is read-only, end-to-end tests use testnets or a simulator.
- **Ran the project in 7 phases** and reviewed and approved each one before the next started:
  1. repository and security tooling, 2. core logic and tests, 3. chain adapters,
  4. notifications and Telegram bot, 5. API and dashboard, 6. deployment, 7. documentation.

## The AI's role

The assistant proposed designs, wrote most of the code and tests, ran them, and explained each
decision to me in plain language so I could follow and question it.

## Verification, not trust

Nothing was accepted because the AI said it worked. Problems found along the way, and how:

| Problem | How it was caught |
| --- | --- |
| An admin could "accept" an expired order that had **no payment at all** | Unit test written for the review rules |
| The live end-to-end check reported *overpaid* for a correct payment | Live read-only run on real chain data: the sample address had received several transfers in the same block; the test sample selection was fixed |
| TronGrid rate-limited requests without an API key (HTTP 429) | Live run; retries with backoff were added |
| gitleaks flagged public contract addresses as secrets | The pre-commit hook blocked the commit; an exact allowlist was added and the hook was re-tested with a realistic fake key to prove it still blocks |
| Demo payments were ignored after a restart (simulated tx hashes repeated, so they looked like duplicates) | Clicking through the dashboard in a real browser; fixed and covered by a regression test |
| The order page crashed when showing audit details | Browser check; fixed |

## What I learned

- Writing the **rules first** (security, money, honesty) shaped every later decision.
- Testing against **recorded real API responses** and a **simulated chain** makes blockchain code
  testable without spending money.
- Idempotency, an append-only audit log and a transactional outbox are what make a payment system
  trustworthy after crashes and restarts.

## Limits

This is a portfolio project: not audited and not production-hardened. See the limitations list in the
[README](../README.md#limitations-honest-list).
