// WT1c diagnostic: resend the web-built Open msg with ONE field changed to find what the deployed escrow's parser rejects.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const { connect, keyStores, KeyPair } = require("near-api-js");
const [variant] = process.argv.slice(2);
const m = JSON.parse(fs.readFileSync(new URL("open_msg.json", import.meta.url).pathname, "utf8"));
const raw = fs.readFileSync(new URL("open_msg.json", import.meta.url).pathname, "utf8");
let msg = raw;
if (variant === "takerallow") msg = raw.replace('"taker_allow":"Any"', '"taker_allow":{"Any":{}}');
if (variant === "noreferee") msg = raw.replace('"referee":null,', "");
if (variant === "runs2") msg = raw.replace('"max_paid_runs":3', '"max_paid_runs":2');
if (variant === "combo") msg = raw.replace('"taker_allow":"Any"', '"taker_allow":{"Any":{}}').replace('"referee":null,', "").replace('"taker_options":[],', "").replace('"max_paid_runs":3', '"max_paid_runs":2');
if (variant === "notakeropt") msg = raw.replace('"taker_options":[],', "");
if (variant === "s8000") { msg = raw.replace(/"storage_charge_per_side":"\d+"/, '"storage_charge_per_side":"8000"'); }
if (msg === raw && variant !== "orig") throw new Error("variant did not change msg");
const id = "maker1.praetorial-dev-1101.testnet";
const ks = new keyStores.InMemoryKeyStore();
await ks.setKey("testnet", id, KeyPair.fromString(JSON.parse(fs.readFileSync(`${process.env.HOME}/.near-credentials/testnet/${id}.json`, "utf8")).private_key));
const a = await (await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL, keyStore: ks })).account(id);
const envSt = (msg.match(/"storage_charge_per_side":"(\d+)"/)||[])[1]; const amt = m.envelope.stake_maker; const dep = (BigInt(m.envelope.stake_maker) + BigInt(envSt)).toString();
const r = await a.functionCall({ contractId: "intents-mock.praetorial-dev-1101.testnet", methodName: "transfer_with_msg", args: { receiver_id: "praetorial-l1b20-11080132.praetorial-dev-1101.testnet", token_id: "nep141:usdc.testnet", amount: dep, msg }, gas: 80_000_000_000_000n });
const outs = r.receipts_outcome.filter(o => o.outcome.executor_id.startsWith("praetorial-l1b20"));
console.log(variant, r.transaction.hash, JSON.stringify(outs.map(o => [o.outcome.logs, o.outcome.status])).slice(0, 400));
