# Deployment

This project is **watch-only**: no deployment ever needs a private key or seed phrase.
If a guide, a hosting form or a person asks for one, stop: it is wrong.

There are two different things to deploy:

| | Public demo | Real merchant install |
| --- | --- | --- |
| `APP_MODE` | `demo` | `testnet` (or `mainnet`, read-only) |
| Chain | Simulated, in memory | TRON / Arbitrum public data |
| Data | Seeded, reset on every restart | Must be kept (persistent disk) |
| Secrets | None | Admin password, API key, Telegram token, webhook secret |
| Host | Render free plan is fine | Needs a persistent disk (see below) |

---

## 1. Public demo on Render (free)

The repository contains a Render Blueprint, `render.yaml`, that deploys **demo mode only**.

1. Give Render access to the repository (Render dashboard → *New* → *Blueprint*, or
   GitHub → *Settings → Applications → Render → Configure* → select the repo).
2. Create the service from `render.yaml`. It runs:
   - build: `npm run build:render` (backend + dashboard)
   - start: `npm start`
   - health check: `GET /healthz`
3. Open the `onrender.com` URL and log in with the demo account shown on the login page.

What to expect on the free plan (honest limits):

- The service **sleeps after about 15 minutes without traffic**. The first visit after that
  takes up to a minute while it wakes up.
- The disk is **temporary**: every deploy or restart wipes the database and the demo
  re-seeds a fresh week of simulated history. This is intended for a demo.
- The demo admin password is public on purpose. It can only reach simulated data.
  New demo orders are capped (2,000) and all endpoints are rate-limited.

Never switch the public demo to `testnet` or `mainnet`.

### Why not Vercel for the backend?

Vercel runs serverless functions: no long-running process (the chain watcher loop and the
Telegram bot need one) and no persistent filesystem (SQLite needs one). The backend serves
the dashboard itself from the same origin, which keeps the session cookie simple and safe
(`SameSite=Strict`, no CORS). Vercel is therefore not needed. If you still want the
dashboard on Vercel, deploy `dashboard/` as a static Vite site and add a rewrite of
`/admin/api/*`, `/api/*` and `/healthz` to the Render URL, so the browser still sees one origin.

---

## 2. Real merchant install (testnet first)

### 2.1 Choose a host with a persistent disk

The database (orders, payments, audit log, watcher cursors) must survive restarts.
SQLite needs a real disk:

- a small VPS (any provider) running `npm start` under a process manager (systemd, pm2), or
- Render with a paid instance and an attached persistent disk mounted at e.g. `/var/data`
  (`DATABASE_URL=file:/var/data/app.db`).

A Postgres store is **not implemented yet**. The data-access layer (`src/db/Store.ts`) is an
interface, so adding one is a contained change, but today only SQLite is supported.

Back up the database file regularly. Losing it loses the audit trail.

### 2.2 Environment variables

Set them in the host's secret settings (never in a committed file). See `.env.example`.

| Variable | Example / how to create | Notes |
| --- | --- | --- |
| `APP_MODE` | `testnet` | Use `mainnet` only for read-only watching of real payments. |
| `NODE_ENV` | `production` | |
| `TRUST_PROXY` | `true` behind Render/a reverse proxy | So rate limits see the real client IP. |
| `COOKIE_SECURE` | `true` | Requires HTTPS. |
| `ADMIN_USERNAME` | `admin` | |
| `ADMIN_INITIAL_PASSWORD` | 12+ characters, from a password manager | Used once to create the admin (stored as bcrypt). Remove it afterwards. |
| `ADMIN_RESET_PASSWORD` | leave empty | Only if the admin is locked out: set a new password, restart, log in, then delete it. Applied once per value. |
| `MERCHANT_API_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` | Leave empty to disable the merchant API. |
| `TRON_WATCH_ADDRESSES` | your **public** TRON address(es) | Comma-separated. |
| `TRONGRID_API_KEY` | free key from trongrid.io | Optional but avoids HTTP 429. |
| `EVM_WATCH_ADDRESSES`, `EVM_RPC_URL` | public address + RPC URL | Testnet needs `EVM_UNVERIFIED_TEST_TOKEN` (there is no official USDT on Arbitrum Sepolia). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_ADMIN_CHAT_ID` | from @BotFather / @userinfobot | Optional. Also enables "Forgot password?" (codes go to the admin chat). |
| `WEBHOOK_URL`, `WEBHOOK_SECRET` | your HTTPS endpoint + 32+ random characters | Optional. Verify signatures as in `examples/webhook-receiver.ts`. |

### Who sets what (handing over to a client)

| Item | Who enters it | Secret? |
| --- | --- | --- |
| Public receiving address(es) | developer or client | No: it is the address customers pay to |
| Telegram bot token | the client, in the host's settings | **Yes** |
| Telegram admin chat id | developer or client | No |
| Admin password (`ADMIN_INITIAL_PASSWORD`) | the client, then changed in **Account** | **Yes** |
| `MERCHANT_API_KEY`, `WEBHOOK_SECRET` | the client (generate with the command above) | **Yes** |
| Wallet private key / seed phrase | **nobody, never**: the system is watch-only | - |

### Lost admin password

1. If Telegram is configured: **Forgot password?** on the sign-in page sends a one-time code to the
   admin chat. Enter it with the new password. Every session is logged out.
2. Otherwise, whoever controls the server sets `ADMIN_RESET_PASSWORD` (12+ characters) and restarts.
   The password of `ADMIN_USERNAME` is replaced once and every session ends. Remove the variable after
   logging in; leaving it set does not re-apply the same value on later restarts.

The app validates all of this at start-up and refuses to run with a bad or placeholder value.
It also refuses anything that looks like a private key or seed phrase in an address field.

### 2.3 First start checklist

1. Start in `testnet` mode with a TRON Nile address you control.
2. Run `npm run verify:contracts` (checks the USDT contract addresses on-chain).
3. Log in to the dashboard, check **Health**: the watcher should be *Healthy* and the
   cursor should follow the chain tip.
4. Create an order, pay it from a Nile test wallet, and watch it go
   `pending → detected → confirming → confirmed`.
5. If Telegram is enabled, open the payer link and check the notifications.
6. Only then consider `mainnet` (read-only). This software is **not audited**; use it with
   real funds only after your own independent review.

### 2.4 Keeping it safe

- Run `npm run scan:all` before every push (the git hooks do this automatically).
- Rotate `MERCHANT_API_KEY`, `WEBHOOK_SECRET` and the Telegram token if they ever leak
  (a leaked value must be considered compromised even after it is deleted from git).
- Keep dependencies updated (`npm audit`).
