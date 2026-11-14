// STACK1: the one GET /health body every Worker serves. Built from an explicit allow-list of public fields (service, network, the
// escrow/registry id, the deploy-injected git sha, the last scheduled() run time) and NOTHING else from env, so no secret/binding can leak.
// escrow_contract_id is the Worker's primary contract (ESCROW_CONTRACT_ID, else the first ESCROW_CONTRACTS entry).
import { str } from "./tickKit.js";

export interface HealthExtra { registryId?: string; /** epoch ms; undefined = field omitted (non-cron Worker), 0/null = no tick yet (field null) */ lastTickMs?: number | null }

export function healthBody(service: string, env: Record<string, unknown>, x: HealthExtra = {}): Record<string, unknown> {
  const body: Record<string, unknown> = { ok: true, service, network: str(env.NEAR_NETWORK_ID) ?? str(env.NEAR_NETWORK) ?? "unknown" };
  if (x.registryId !== undefined) body.registry_id = x.registryId;
  else {
    const multi = str(env.ESCROW_CONTRACTS)?.split(",")[0]?.trim().split("@")[0];
    body.escrow_contract_id = str(env.ESCROW_CONTRACT_ID) ?? (multi || null);
  }
  body.git_sha = str(env.GIT_SHA) ?? "unknown";
  if (x.lastTickMs !== undefined) body.last_tick_at = x.lastTickMs ? new Date(x.lastTickMs).toISOString() : null;
  return body;
}
export const healthResponse = (service: string, env: Record<string, unknown>, x: HealthExtra = {}): Response => Response.json(healthBody(service, env, x), { status: 200 });
