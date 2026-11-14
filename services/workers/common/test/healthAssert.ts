// Shared assertions for the per-Worker GET /health tests (STACK1). Not a *.test.ts, so not collected on its own.
import assert from "node:assert/strict";

export const ALLOWED_KEYS = new Set(["ok", "service", "network", "escrow_contract_id", "registry_id", "git_sha", "last_tick_at", "bets_cached", "keyConfigured"]);

export interface HealthExpect {
  service: string; network: string; sha: string;
  escrow?: string; registryId?: string;
  /** every secret/key/token/env value that must NEVER appear anywhere in the body */
  secrets: string[];
  /** "absent": no last_tick_at field; null: field present and null (no tick yet); number: epoch ms of the last scheduled() run */
  tick: "absent" | null | number;
}

export async function assertHealth(res: Response, e: HealthExpect): Promise<Record<string, any>> {
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const text = await res.text();
  assert.ok(e.secrets.length > 0, "test must name at least one secret value to look for");
  for (const s of e.secrets) assert.ok(!text.includes(s), `/health body leaks a secret/env value: ${s.slice(0, 6)}...`);
  const body = JSON.parse(text);
  for (const k of Object.keys(body)) assert.ok(ALLOWED_KEYS.has(k), `unexpected field in /health: ${k}`);
  assert.equal(body.service, e.service);
  assert.equal(body.network, e.network);
  assert.equal(body.git_sha, e.sha);
  if (e.registryId !== undefined) { assert.equal(body.registry_id, e.registryId); assert.ok(!("escrow_contract_id" in body)); }
  else assert.equal(body.escrow_contract_id, e.escrow);
  if (e.tick === "absent") assert.ok(!("last_tick_at" in body));
  else if (e.tick === null) { assert.ok("last_tick_at" in body); assert.equal(body.last_tick_at, null); }
  else assert.equal(body.last_tick_at, new Date(e.tick).toISOString());
  return body;
}

/** A Durable Object namespace stub that routes every request to one in-process DO instance. */
export const nsOf = (obj: { fetch(r: Request): Promise<Response> }) => ({
  idFromName: (n: string) => n,
  get: () => ({ fetch: (u: string, i?: any) => obj.fetch(new Request(u, i)) }),
});
