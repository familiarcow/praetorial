// The indexer's periodic work, registered in the shared dispatcher (keeper/src/index.ts JOBS): tick pokes to the indexer
// Worker over a service binding. No cron trigger of its own (the account allows 5 in total).
import { pokeService, type Job } from "../../common/src/dispatcher.js";

export interface IndexerServiceEnv { INDEXER_SERVICE?: { fetch(url: string, init?: any): Promise<Response> }; [k: string]: unknown }

const poke = (path: string) => async (env: IndexerServiceEnv): Promise<void> => {
  if (!env.INDEXER_SERVICE) return; // indexer Worker not bound in this deployment: nothing to poke
  await pokeService(env.INDEXER_SERVICE, `https://indexer.internal${path}`, `indexer ${path}`);
};

/** Bounded bet sweep step (every minute). */
export const indexerTickJob: Job<IndexerServiceEnv> = { name: "indexer-tick", everyMinutes: 1, run: poke("/tick") };
/** Governance event refresh (JC1y); the node indexer refreshes it every 60 s, the Worker every 5 min (tx-indexer history is subrequest-heavy). */
export const indexerGovernanceJob: Job<IndexerServiceEnv> = { name: "indexer-governance", everyMinutes: 5, run: poke("/tick/governance") };
