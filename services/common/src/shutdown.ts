// D-UPGRADE1: models a future "this escrow contract version has been
// shut down" signal as a mockable view call -- `is_shutdown()` --
// rather than inventing real contract behaviour. contracts/escrow/src/
// lib.rs on main has no such view today (checked 2026-11-04), so this
// is deliberately an interface a keeper can call against ANY client
// (mock in tests, a real NearClient once/if the contract ever grows
// this view) and treat a missing/erroring view as "not shut down" --
// never the reverse, so a contract that simply predates this feature
// is never mistaken for a shut-down one.
import type { NearClient } from "./nearClient.js";

export interface ChainViewClient {
  view<T>(contractId: string, methodName: string, args?: Record<string, unknown>): Promise<T>;
}

export async function checkContractShutdown(client: NearClient | ChainViewClient, contractId: string): Promise<boolean> {
  try {
    const result = await client.view<boolean>(contractId, "is_shutdown", {});
    return result === true;
  } catch {
    // No is_shutdown view (older contract version, or a mock that
    // doesn't implement it) -- treat as still live.
    return false;
  }
}
