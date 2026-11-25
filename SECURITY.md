# Security

## Model

- **Non-custodial and watch-only.** The system reads public blockchain data. It never holds, requests
  or stores a private key or seed phrase and contains no transaction-signing code. Configuration that
  looks like a private key or a seed phrase is rejected at start-up.
- **No secrets in the repository.** `.env` is git-ignored since the first commit; `.env.example`
  holds placeholders and harmless defaults only. The only credential in the code is the **public demo
  login**, which is shown on the demo's login page on purpose and can only reach simulated data.
- **Not audited and not production-hardened.** See the limitations in the [README](README.md).

## Controls in the code

| Area | Control |
| --- | --- |
| Secrets | gitleaks pre-commit hook (staged changes) and pre-push hook (whole folder + full git history) |
| Admin login | bcrypt (cost 12), same response and timing for unknown users, 5 attempts/min per IP, every attempt audited |
| Sessions | random 256-bit id, stored only as SHA-256, `HttpOnly` + `Secure` + `SameSite=Strict` cookie (`__Host-` prefix over HTTPS), 8 h lifetime |
| CSRF | per-session token required in `X-CSRF-Token` on every state-changing admin request |
| Merchant API | bearer key compared in constant time, 60 requests/min, `Idempotency-Key` |
| Input | zod validation on every route, 16 KB body limit, amounts as decimal strings only |
| Headers | helmet: CSP `default-src 'self'`, HSTS, `frame-ancestors 'none'`, `nosniff`, no referrer |
| Webhooks | HMAC-SHA256 over `timestamp.body`, constant-time verify, 5-minute replay window, unique event id |
| Payments | idempotent ingest keyed on `(network, tx_hash, log_index)`, validated state machine, append-only audit log enforced by database triggers |
| Exports | CSV formula injection neutralised |
| Money | `bigint` base units; no floating point anywhere in amount handling |

## Final checklist (run before publishing)

Results below are from the actual run on 2026-11-25.

| # | Check | Command / method | Result |
| --- | --- | --- | --- |
| 1 | Secret scan of the working folder | `npm run scan:secrets` | no leaks found |
| 2 | Secret scan of the full git history | `npm run scan:history` | 7 commits, no leaks found |
| 3 | No `.env` file ever committed | `git log --all --name-only` | only `.env.example` |
| 4 | `.env.example` has no real values | manual review | placeholders and defaults only |
| 5 | No signing or key-handling code | `git grep` for signing / wallet / mnemonic APIs | none found |
| 6 | Commit author emails | `git log --format=%ae` | GitHub no-reply address only |
| 7 | Dependency vulnerabilities | `npm audit` (backend and dashboard) | 0 found in both |
| 8 | Type safety and tests | `npm run typecheck`, `npm test` | 0 errors, 127/127 tests passed |
| 9 | USDT contracts verified on-chain | `npm run verify:contracts` | TRON mainnet, TRON Nile, Arbitrum One: PASS |
| 10 | Live demo headers | `curl -I` on the demo URL | CSP, HSTS, nosniff, frame protection present |
| 11 | Live demo access control | requests without a session | admin API 401; merchant API disabled (503) |
| 12 | Live demo cookie | inspect `Set-Cookie` | `__Host-sid`, `Secure`, `HttpOnly` |

## If a secret ever leaks

1. **Rotate it first** (new Telegram token via @BotFather, new `MERCHANT_API_KEY`, new
   `WEBHOOK_SECRET`, new admin password). Deleting it from git is not enough: assume it was copied.
2. Remove it from the history (`git filter-repo`), force-push, and ask collaborators to re-clone.
3. Re-run `npm run scan:all` and confirm it is clean.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** on this repository (Security tab → *Report a
vulnerability*) instead of a public issue. Do not include real keys or personal data in reports.
