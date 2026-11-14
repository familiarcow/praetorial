// RFRZ2: finish the Human-mode bet opened by human_bet.mjs (it was cut off by a tool timeout while waiting for funding_deadline).
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { connect, keyStores, KeyPair } = require("near-api-js");
const DIR = new URL(".", import.meta.url).pathname, RPC = process.env.NEAR_RPC_URL;
const res = JSON.parse(fs.readFileSync(DIR + "human_bet_results.json", "utf8"));
const ESCROW = res.escrow, betId = res.bet_id, INTENTS = "intents-mock.praetorial-dev-1101.testnet", USDC = "nep141:usdc.testnet";
const REFEREE = "keeper.praetorial-dev-1101.testnet", MAKER = "maker1.praetorial-dev-1101.testnet", TAKER = "praetorial-dev-1101.testnet", FEE = "fee.praetorial-dev-1101.testnet";
const save = () => fs.writeFileSync(DIR + "human_bet_results.json", JSON.stringify(res, null, 2));
const ks = new keyStores.InMemoryKeyStore();
await ks.setKey("testnet", REFEREE, KeyPair.fromString(JSON.parse(fs.readFileSync(`${process.env.HOME}/.near-credentials/testnet/${REFEREE}.json`, "utf8")).private_key));
const referee = await (await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks })).account(REFEREE);
const view = (m, a = {}) => referee.viewFunction({ contractId: ESCROW, methodName: m, args: a });
const bal = async (id) => (await referee.viewFunction({ contractId: INTENTS, methodName: "mt_balance_of", args: { account_id: id, token_id: USDC } })).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let b = await view("get_bet", { bet_id: betId });
if (b.status === "Taken") {
  const fd = BigInt(b.envelope.funding_deadline);
  while (BigInt(Date.now()) * 1_000_000n < fd + 15_000_000_000n) await sleep(5000);
  const t = await referee.functionCall({ contractId: ESCROW, methodName: "referee_rule", args: { bet_id: betId, outcome: "YES" }, gas: 100_000_000_000_000n });
  res.txs.push({ step: "referee_rule_yes", hash: t.transaction.hash, url: `https://testnet.nearblocks.io/txns/${t.transaction.hash}` }); save(); console.log("tx referee_rule_yes", t.transaction.hash);
}
for (let i = 0; i < 30; i++) { await sleep(5000); const p = await view("pending_payouts", { from: 0, limit: 50 }).catch(() => null); if (p && p.length === 0) break; }
b = await view("get_bet", { bet_id: betId });
res.final_status = b.status; res.final_outcome = b.outcome;
res.balances_after = { maker: await bal(MAKER), taker: await bal(TAKER), fee: await bal(FEE), escrow: await bal(ESCROW) };
res.pending_payouts_after = (await view("pending_payouts", { from: 0, limit: 50 }).catch(() => ["?"])).length;
save(); console.log(JSON.stringify({ status: b.status, outcome: b.outcome, balances_after: res.balances_after, pending: res.pending_payouts_after }));
