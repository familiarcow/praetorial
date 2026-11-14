// MAINPREP1 step (f): fund the escrow's keeper compute credit from keeper.praetorial.near (bot-held key, D-KEYS1).
// topup_keeper_credit accepts only the keeper or fee account (lib.rs topup_keeper_credit). Prints tx hash + new credit; never the key.
// Default is a DRY RUN (prints the call). Real: PRAETORIAL_MAINNET_GO=GO node scripts/mainnet-night/50-keeper-credit.mjs 0.5
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(REPO, "services/package.json"));
const { connect, keyStores, KeyPair, utils } = require("near-api-js");
const NEAR = process.argv[2] ?? "0.5";
const ESCROW = process.env.ESCROW ?? "bets.praetorial.near";
const KEEPER = "keeper.praetorial.near";
const RPC = process.env.MAINNET_RPC ?? "https://free.rpc.fastnear.com";
if (!(Number(NEAR) > 0 && Number(NEAR) <= 2)) { console.error("REFUSED: amount must be in (0, 2] NEAR"); process.exit(2); }
const yocto = utils.format.parseNearAmount(NEAR);
const call = { contractId: ESCROW, methodName: "topup_keeper_credit", args: {}, gas: 30_000_000_000_000n, attachedDeposit: BigInt(yocto) };
const near = await connect({ networkId: "mainnet", nodeUrl: RPC, keyStore: new keyStores.InMemoryKeyStore() });
const credit = async () => utils.format.formatNearAmount((await near.connection.provider.query({ request_type: "call_function", finality: "final", account_id: ESCROW, method_name: "keeper_credit_balance", args_base64: "e30=" }).then((r) => JSON.parse(Buffer.from(r.result).toString()))), 4);
if (process.env.PRAETORIAL_MAINNET_GO !== "GO") {
  console.log(`DRY: ${KEEPER} -> ${ESCROW}.topup_keeper_credit() deposit ${NEAR} NEAR gas 30 Tgas (set PRAETORIAL_MAINNET_GO=GO to send)`);
  process.exit(0);
}
const dir = path.join((process.env.PRAETORIAL_SECRETS_DIR ?? (() => { throw new Error("set PRAETORIAL_SECRETS_DIR (operator secrets dir)"); })()), "praetorial-mainnet-keys/keeper");
const k = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith(".json"))), "utf8"));
const ks = new keyStores.InMemoryKeyStore();
await ks.setKey("mainnet", KEEPER, KeyPair.fromString(k.private_key));
const signer = await (await connect({ networkId: "mainnet", nodeUrl: RPC, keyStore: ks })).account(KEEPER);
const r = await signer.functionCall(call);
console.log(`tx topup_keeper_credit ${r.transaction.hash} https://nearblocks.io/txns/${r.transaction.hash}`);
console.log(`keeper_credit_balance ${await credit()} NEAR`);
