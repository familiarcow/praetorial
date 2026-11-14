-- CF1f registry Worker (D-REGW1): D1 schema. One statement per line (wrangler d1 migrations apply and miniflare both accept this).
-- users: one row per account. username is stored normalized (lowercase); folded is the look-alike fold (rn->m, 0->o, 1/i->l, 5->s) and is UNIQUE,
-- so two names that fold alike can never coexist (the database itself enforces it, not only the handler). account_id is UNIQUE: one name per account.
CREATE TABLE IF NOT EXISTS users (username TEXT NOT NULL, folded TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, discoverable INTEGER NOT NULL DEFAULT 1, claimed_at INTEGER NOT NULL);
-- Single-use NEP-413 nonces (replay guard); pruned past the freshness window on each claim.
CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, ts INTEGER NOT NULL);
-- Per-IP token bucket (rate limit lives in D1: persists across isolates, no Durable Object needed). Stale rows are pruned on claim.
CREATE TABLE IF NOT EXISTS rate (ip TEXT PRIMARY KEY, tokens REAL NOT NULL, at INTEGER NOT NULL);
