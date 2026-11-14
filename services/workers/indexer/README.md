# Indexer Worker (CF1d, D-HOST3)

The node indexer (`services/indexer`) as a Cloudflare Worker with **D1** storage. It serves the same read API as
`indexer/src/server.ts` (`/offers`, `/history[?account=]`, `/bet?bet_id=[&contract_id=]`, `/governance[?contract_id=&kind=]`,
`/health`; same JSON, same status codes, no CORS headers like the node server; IDX2 adds `POST /refresh`, below) and refreshes its board in **bounded ticks**.

## Design
- **Shared logic, no fork**: board builders (`indexer/src/board.ts`), governance indexer, the terminal-lock / redeploy rules and the
  D-DSY1 second-RPC confirmation (`indexer/src/refreshCore.ts`), tx history paging (`common/src/txHistoryCore.ts`). The node files re-export them.
- **D1 schema** (`migrations/0001_init.sql`): `indexer_bets` (one row per `<contract>:<bet_id>`, JSON bet + confirmed flag; rowid order = node Map insertion order),
  `indexer_state` (sweep cursors, frontier, alert cooldowns), `indexer_governance` (events per contract), `indexer_lock` (single-flight + min interval via atomic conditional UPDATE).
- **Tick** (`POST /tick`, from the dispatcher): reads `INDEXER_BATCH_BETS` (default 12, CF1e3) bets across contracts from a per-contract sweep cursor,
  merges, confirms at most `INDEXER_MAX_CONFIRMS_PER_TICK` (default 3, CF1e3) terminal bets against the second RPC (unconfirmed ones stay "settling, confirming"), writes one D1 batch.
  Subrequest budget: bet reads + confirms + one `contract_version` per contract <= 45 (hard cap derived in `src/env.ts`); D1 statements per tick are a handful (batch of multi-row upserts).
  `POST /tick/governance` refreshes tx-indexer governance events (every 5 min), INCREMENTALLY (IDX1, see below).
- **No cron of its own** (the account allows 5): the keeper's dispatcher registers `indexer-tick` (1 min) and `indexer-governance` (5 min) and pokes this Worker through the `INDEXER_SERVICE` binding in `workers/keeper/wrangler.toml`.
- CPU budget: p99 <= 5 ms per invocation, measured by `npm run test:budget` (`test-budget/`).

## Deploy (testnet; done in CF1e, not by this item)
Token via the environment only (never in a file): `export CLOUDFLARE_API_TOKEN=...` (set outside the repo).
```
cd services/workers/indexer
npx wrangler d1 create praetorial-indexer-testnet      # put the printed id in wrangler.toml (replaces REPLACE_WITH_D1_DATABASE_ID)
npx wrangler d1 migrations apply praetorial-indexer-testnet --remote
npx wrangler deploy                                    # then deploy the keeper so INDEXER_SERVICE resolves
```
Set `ESCROW_CONTRACT_ID`/`ESCROW_CONTRACTS`, `INTENTS_CONTRACT_ID` and `NEAR_RPC_FALLBACKS` (second RPC, required for terminal outcomes) in `[vars]`. Confirm real billed CPU with `wrangler tail` after the first deploy.

## `POST /refresh {"bet_id": N[, "contract_id": "<served escrow>"]}` (IDX2)
The web's nudge right after a successful Open or Take, so Explore shows the change in seconds instead of after the next minute sweep.
The caller only names the bet: the Worker reads `bet_count()` (`bet_id` must be <= bet_count + 1, else 400) and `get_bet(N)` from the
chain itself (absent -> 404, nothing written) and merges it with the tick's own code (`src/merge.ts`: terminal lock / sameBet identity,
unchanged re-read = no write, D-DSY1 second-RPC confirmation). Any bet data in the body is ignored. Configured escrow only (`contract_id`
outside the served set -> 400). Never takes the tick lease, never writes the sweep state. Concurrent tick/refresh writes are safe in SQL
(`migrations/0002_refresh.sql`): a row is only replaced by a read that started at or after it (`read_ms`), and a terminal row never by a
non-terminal read of the same bet. Limits (`indexer_refresh_limit`, fixed one-minute windows): 30/min per client address
(`cf-connecting-ip`; the web proxy's `x-client-ip` only when absent) + 300/min overall -> 429 + `retry-after`. CORS: the web origin(s)
of the network only (`src/refresh.ts` REFRESH_ORIGINS); a foreign `Origin` -> 403. The web calls it through `/_proxy/indexer/refresh`
(same origin, no CORS needed). **Deploy: apply migration 0002 before the code** (`deploy-mainnet.sh` already applies migrations first).

## `GET /bet/txs?bet_id=<n>[&contract_id=<acct>]` (V1)
Every on-chain action of one bet, in block order: `[{bet_id, hash, at_ns, kind, method, signer, actor, ok, moved_in[], moved_out[], outcome?, run_no?, round?, signed?, program?}]`
(`kind`: create, take, cancel, expire, reclaim, referee-change, request-result, ruling, challenge, objection, evidence, concede, referee-rule,
finalize, payout, refund, amend, extend-window, prune). Built by `common/src/betTxIndex.ts` from the SAME escrow tx history the governance
tick already fetches (no extra subrequests; incremental since IDX1), stored as one `indexer_state` row per bet (`bettxs:<contract>:<bet_id>`, no migration).
A failed history fetch keeps the last rows. `contract_id` defaults to the served escrow; any other contract -> `[]`; a bad `bet_id` -> 400.
Served by this Worker only (the node `indexer/src/server.ts` does not have it). The web's Verify sheets read it; without it they say the
tx hashes are not indexed yet and link to the escrow's explorer page.

## `GET /history?referee=<acct>` (IDXREF1, D-FE14a)
Returns exactly the bets whose *current* referee account (`envelope.referee.account`, rewritten by `referee_amended`) equals `<acct>`: AI-mode bets (no referee) never match, an amended referee X->Y lists for Y only, a referee who is also the maker is still listed, open untaken human-mode bets are included. Same entry shape and `redactUnconfirmed` as `?account=`. `?account=` + `?referee=` together -> 400; a `referee` that is not a valid NEAR account id (or empty) -> 400. One shared `historyHttp` in `services/indexer/src/board.ts` serves both the node indexer and this Worker.

Live evidence (testnet, deployed from main 98d8da9, Worker version `33ac63f3-2ac7-4367-b070-f9ff7dfc5bdc`, https://praetorial-indexer-testnet.familiarcow.workers.dev):
- `/history?referee=keeper.praetorial-dev-1101.testnet` -> 200, bets [22, 23] (cf-ray a57e7b9ab81549aa-EWR; bet 23 is the amend_referee bet)
- `/history?referee=arbiter1.praetorial-dev-1101.testnet` -> 200, bets [24, 25, 26] (cf-ray a57e7b9cd87c0f73-EWR)
- `/history?referee=nobody.testnet` -> 200, [] (cf-ray a57e7b9f5883fd66-EWR)
- `/history?account=x.testnet&referee=keeper.praetorial-dev-1101.testnet` -> 400 `{"error":"account and referee are mutually exclusive"}` (cf-ray a57e7ba19a49c45e-EWR)
- `/history?referee=BAD..id` -> 400; unfiltered `/history` still 26 bets.

## Incremental escrow history (IDX1, D-PM3)
Before IDX1 every governance run re-fetched the whole escrow history (1 tx-indexer request per 200 txs listed + 1 per 5 txs
fetched), so at ~240 escrow txs a run hit the Workers Free cap of 50 subrequests and `/governance` + `/bet/txs` stopped updating.
Now (`src/historyCursor.ts`) a cursor per contract in `indexer_state` (`histcursor:<contract>`, no migration) resumes across runs:
- each run lists the newest page(s) down to the previous head minus 300 blocks (late-listed txs), then fetches queued txs 5 at a
  time and continues the older listing (backfill, or a gap left by a burst) only when the queue runs short;
- at most `HISTORY_BUDGET` = 30 tx-indexer requests per run (all contracts together); a 2,000-tx history backfills in ~15 runs
  (~75 min), each at 30; afterwards a quiet run is 1 request, a run with k new txs about 1 + k/5;
- a tx younger than 10 min when fetched is fetched again later (receipts still executing); fetched txs replace their previous
  `/governance` events and `/bet/txs` entries by tx hash (idempotent), so a re-fetch never duplicates;
- a failing request ends the run keeping the progress made; the old rows are never wiped.
**Reset / re-backfill**: `DELETE FROM indexer_state WHERE k = 'histcursor:<contract>'` (a corrupt cursor is treated the same).
The served rows are kept and the next runs re-list and re-merge the whole history. Each run's `POST /tick/governance` answer
reports `history.<contract>` = `{ used, fetched, pending, segments, synced }`.
