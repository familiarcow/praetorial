// R3h (D-E2E1b) step 1: read-only precheck of the R3c escrow. No keys used.
import crypto from "node:crypto";
import { connect, keyStores, mk } from "../live-run16a/lib.mjs";
import * as C from "./config.mjs";
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
const a = await near.account(C.ESCROW);
const v = async (m, args = {}) => { try { return await a.viewFunction({ contractId: C.ESCROW, methodName: m, args }); } catch (e) { return { error: String(e.message).slice(0, 200) }; } };
const st = await a.state();
const bets = [];
for (let i = 1; i < 200; i++) { const b = await v("get_bet", { bet_id: i }); if (!b || b.error) { if (b?.error) bets.push({ id: i, error: b.error }); break; } bets.push({ id: i, status: b.status, outcome: b.outcome }); }
const out = { ts: new Date().toISOString(), account: C.ESCROW, balance_yocto: st.amount, storage_usage: st.storage_usage, bets,
  open_offers: await v("open_offers", { from: 0, limit: 200 }), pending_payouts_view: await v("pending_payouts_view", { from: 0, limit: 200 }), keeper_credit_balance: await v("keeper_credit_balance") };
out.mt = {}; for (const t of [C.USDC, C.BTC]) { try { out.mt[t] = await a.viewFunction({ contractId: C.INTENTS, methodName: "mt_balance_of", args: { account_id: C.ESCROW, token_id: t } }); } catch (e) { out.mt[t] = "err " + String(e.message).slice(0, 80); } }
out.dev_balance_yocto = (await (await near.account(C.OPERATOR)).state()).amount;
console.log(JSON.stringify(out));
