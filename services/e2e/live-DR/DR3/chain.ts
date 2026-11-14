// DR3 chain helpers: DR1's, but the escrow is the one the DEPLOYED web bundle targets (apps/web/lib/network.ts), not DR1's pinned frz2.
import { loadWebTestnetConfig } from "../DR1/webConfig.js";
process.env.DR1_ESCROW = (await loadWebTestnetConfig()).escrow;
const c = await import("../DR1/chain.js");
export const { SERVICES_PACKAGE_JSON, acct, ESCROW, WEB_ESCROW, INTENTS, STAKE_TOKEN, FEE, RPC, sleep, view, bal, nearBal, fundUsdc, fundNear, escrowMethods } = c;
