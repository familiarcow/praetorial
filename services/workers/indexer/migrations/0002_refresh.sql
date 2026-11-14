-- IDX2: POST /refresh (the web nudges one bet after an Open/Take). One statement per line.
-- read_ms: when the chain read behind this row started (ms). A row is only replaced by a read that started at or after it, so a tick
-- that read the chain before a refresh cannot overwrite the refresh's newer row (and vice versa). Old rows: 0 (any read replaces them).
ALTER TABLE indexer_bets ADD COLUMN read_ms INTEGER NOT NULL DEFAULT 0;
-- Fixed one-minute windows: "ip:<addr>" (per address) and "global"; bucket = floor(ms / 60000). Rows of past minutes are swept on use.
CREATE TABLE IF NOT EXISTS indexer_refresh_limit (k TEXT PRIMARY KEY, bucket INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS indexer_refresh_limit_bucket ON indexer_refresh_limit (bucket);
