-- Migration 0010: admin-hidden tokens (D-AD1). A hidden token disappears from every public endpoint
-- (it is treated as unlisted) until an admin unhides it. On-chain state is untouched.
CREATE TABLE IF NOT EXISTS hidden_tokens (
  asset      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  hidden_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
