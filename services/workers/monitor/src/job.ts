// The monitor's periodic work, registered in the shared dispatcher (keeper/src/index.ts JOBS): a tick poke to the
// monitor Worker over a service binding. No cron trigger of its own (the account allows 5 in total).
import { pokeService, type Job } from "../../common/src/dispatcher.js";

export interface MonitorServiceEnv { MONITOR_SERVICE?: { fetch(url: string, init?: any): Promise<Response> }; [k: string]: unknown }

export const monitorTickJob: Job<MonitorServiceEnv> = {
  name: "monitor-tick", everyMinutes: 1,
  async run(env) {
    if (!env.MONITOR_SERVICE) return; // monitor Worker not bound in this deployment: nothing to poke
    await pokeService(env.MONITOR_SERVICE, "https://monitor.internal/tick", "monitor tick");
  },
};
