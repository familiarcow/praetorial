// Phase 16a step 1+2: read-only precheck + pre-delete snapshot of the item-8 escrow. No keys used.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { connect, keyStores } = require("near-api-js");
const C = await import("../live-run8/config.mjs");
const near = await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: new keyStores.InMemoryKeyStore() });
const a = await near.account(C.ESCROW);
const v = (c, m, args = {}) => a.viewFunction({ contractId: c, methodName: m, args });
const snap = { ts: new Date().toISOString(), account: C.ESCROW };
const st = await a.state(); snap.balance_yocto = st.amount; snap.storage_usage = st.storage_usage; snap.code_hash_b58 = st.code_hash;
snap.code_hash_hex = Buffer.from(require("near-api-js").utils.serialize.base_decode(st.code_hash)).toString("hex");
const gets = async (m, args) => { try { return await v(C.ESCROW, m, args); } catch (e) { return { error: String(e.message).slice(0, 200) }; } };
snap.views = {
  resolver_keys: await gets("resolver_keys"), outlayer_config: await gets("outlayer_config"), keeper_credit_balance: await gets("keeper_credit_balance"),
  open_offers: await gets("open_offers", { from: 0, limit: 200 }), pending_payouts_view: await gets("pending_payouts_view", { from: 0, limit: 200 }),
};
const bets = [];
for (let i = 1; i < 12; i++) { try { const b = await v(C.ESCROW, "get_bet", { bet_id: i }); if (b) bets.push({ id: i, status: b.status, outcome: b.outcome }); else break; } catch { break; } }
snap.bets = bets;
snap.mt_balances = {};
const toks = [C.USDC, C.BTC, "nep141:usdt.testnet", "nep141:wrap.testnet", "nep141:eth.mock.testnet"];
for (const t of toks) snap.mt_balances[t] = await v(C.INTENTS, "mt_balance_of", { account_id: C.ESCROW, token_id: t });
snap.mt_balances_other = {};
// also anything else the escrow might hold via mt_tokens_for_owner if supported
try { snap.mt_tokens_for_owner = await v(C.INTENTS, "mt_tokens_for_owner", { account_id: C.ESCROW }); } catch (e) { snap.mt_tokens_for_owner = { error: String(e.message).slice(0, 120) }; }
snap.dev_balance_yocto = (await (await near.account(C.OPERATOR)).state()).amount;
snap.attest1_balance_yocto = (await (await near.account("attest1.praetorial-dev-1101.testnet")).state()).amount;
fs.writeFileSync("precheck.json", JSON.stringify(snap, null, 2));
console.log(JSON.stringify({ ...snap, views: { ...snap.views, open_offers: (snap.views.open_offers||[]).length, pending_payouts_view: Array.isArray(snap.views.pending_payouts_view) ? snap.views.pending_payouts_view.map(p=>({bet:p.bet_id,done:p.done,amt:p.amount})) : snap.views.pending_payouts_view } }, null, 1));
