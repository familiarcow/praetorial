// The notifier's periodic work, registered in the shared dispatcher (keeper/src/index.ts JOBS): a tick poke to the
// notifier Worker over a service binding. No cron trigger of its own (the account allows 5 in total).
import { pokeService, type Job } from "../../common/src/dispatcher.js";

export interface NotifierServiceEnv { NOTIFIER_SERVICE?: { fetch(url: string, init?: any): Promise<Response> }; [k: string]: unknown }

export const notifierTickJob: Job<NotifierServiceEnv> = {
  name: "notifier-tick", everyMinutes: 1,
  async run(env) {
    if (!env.NOTIFIER_SERVICE) return; // notifier Worker not bound in this deployment: nothing to poke
    await pokeService(env.NOTIFIER_SERVICE, "https://notifier.internal/tick", "notifier tick");
  },
};
