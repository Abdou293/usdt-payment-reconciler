// SQL schema. Amounts are stored as TEXT holding integer base units
// (never REAL/float). Dates are ISO-8601 TEXT in UTC.

export const SCHEMA_VERSION = 3;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id                      TEXT PRIMARY KEY,
  external_ref            TEXT,
  network                 TEXT NOT NULL,
  token                   TEXT NOT NULL,
  receiving_address       TEXT NOT NULL,
  base_amount             TEXT NOT NULL,
  payable_amount          TEXT NOT NULL,
  status                  TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  expires_at              TEXT NOT NULL,
  payer_telegram_chat_id  TEXT,
  manually_resolved       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_orders_destination
  ON orders (network, token, receiving_address, status);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);

CREATE TABLE IF NOT EXISTS payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  network          TEXT NOT NULL,
  tx_hash          TEXT NOT NULL,
  log_index        INTEGER NOT NULL,
  token_contract   TEXT NOT NULL,
  from_address     TEXT NOT NULL,
  to_address       TEXT NOT NULL,
  amount           TEXT NOT NULL,
  block_number     INTEGER NOT NULL,
  block_timestamp  TEXT NOT NULL,
  status           TEXT NOT NULL,
  order_id         TEXT REFERENCES orders(id),
  note             TEXT,
  first_seen_at    TEXT NOT NULL,
  -- Idempotency: the same on-chain transfer can only ever be stored once.
  UNIQUE (network, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments (order_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);

CREATE TABLE IF NOT EXISTS chain_state (
  network          TEXT PRIMARY KEY,
  cursor_block     INTEGER,
  latest_block     INTEGER,
  last_poll_at     TEXT,
  last_success_at  TEXT,
  last_error       TEXT
);

-- Append-only log of every state change (who, what, when, why).
CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  actor        TEXT NOT NULL,
  details      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log (entity_type, entity_id);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update
  BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
  BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- v2: transactional outbox. The processor writes an event in the SAME
-- transaction as the status change, so no notification is lost if the
-- process crashes or the free host goes to sleep right after a payment.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- One row per Telegram message / webhook call. dedupe_key makes fan-out idempotent.
CREATE TABLE IF NOT EXISTS deliveries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id         INTEGER NOT NULL REFERENCES events(id),
  channel          TEXT NOT NULL,
  target           TEXT NOT NULL,
  dedupe_key       TEXT NOT NULL UNIQUE,
  body             TEXT NOT NULL,
  status           TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT NOT NULL,
  last_error       TEXT,
  sent_at          TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS kv (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- v3: admin accounts and server-side sessions.
-- Passwords are stored ONLY as bcrypt hashes. Session ids are stored ONLY as
-- SHA-256 hashes, so a leaked database cannot be used to hijack a session.
CREATE TABLE IF NOT EXISTS admin_users (
  username       TEXT PRIMARY KEY,
  password_hash  TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash     TEXT PRIMARY KEY,
  username    TEXT NOT NULL REFERENCES admin_users(username),
  csrf_token  TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_payments_block_time ON payments (block_timestamp);
`;
