// The relayer's periodic work, registered in the shared dispatcher (keeper/src/index.ts JOBS): a heartbeat
// poke to the relayer Worker over a service binding. No cron trigger of its own (account limit is 5).
import { pokeService, type Job } from "../../common/src/dispatcher.js";
import type { RelayerEnv } from "./env.js";

export const relayerHeartbeatJob: Job<RelayerEnv> = {
  name: "relayer-heartbeat", everyMinutes: 5,
  async run(env) {
    if (!env.RELAYER_SERVICE) return; // relayer Worker not bound in this deployment: nothing to poke
    await pokeService(env.RELAYER_SERVICE, "https://relayer.internal/heartbeat", "relayer heartbeat");
  },
};
