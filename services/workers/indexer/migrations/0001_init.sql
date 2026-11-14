-- CF1d indexer Worker (D-HOST3): D1 schema. One statement per line (wrangler d1 migrations apply and miniflare both accept this).
-- Bets cache, keyed like the node indexer's Map ("<contractId>:<betId>"). ord = the contract's index in ESCROW_CONTRACTS; boards are served ordered by (ord, bet_id),
-- which equals the node Map's insertion order for a full scan (contract-major, ascending ids).
-- confirmed: NULL for non-terminal bets; 0 = Settled/Voided awaiting the second-RPC confirmation (D-DSY1, shown as "settling, confirming"); 1 = confirmed.
CREATE TABLE IF NOT EXISTS indexer_bets (key TEXT PRIMARY KEY, contract_id TEXT NOT NULL, bet_id INTEGER NOT NULL, ord INTEGER NOT NULL DEFAULT 0, version TEXT NOT NULL, confirmed INTEGER, bet TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS indexer_bets_order ON indexer_bets (ord, bet_id);
CREATE INDEX IF NOT EXISTS indexer_bets_unconfirmed ON indexer_bets (confirmed);
-- JSON key/value: "state" = per-contract sweep cursors, frontier (maxIds) and alert cooldowns.
CREATE TABLE IF NOT EXISTS indexer_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
-- Governance events (JC1y) per contract; a contract whose history fetch fails keeps its previous row.
CREATE TABLE IF NOT EXISTS indexer_governance (contract_id TEXT PRIMARY KEY, events TEXT NOT NULL);
-- Single-flight + min-interval gate per job (D1 has no Durable Object serialisation): an atomic conditional UPDATE acquires it.
CREATE TABLE IF NOT EXISTS indexer_lock (name TEXT PRIMARY KEY, until_ms INTEGER NOT NULL DEFAULT 0, last_ms INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO indexer_lock (name) VALUES ('tick');
INSERT OR IGNORE INTO indexer_lock (name) VALUES ('governance');
