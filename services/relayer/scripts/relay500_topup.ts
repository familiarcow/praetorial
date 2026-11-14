// RELAY500 testnet-only top-up (D-TNEAR1): sweep spare NEAR from our own leftover throwaway testnet accounts (keys in
// ~/.near-credentials/testnet) into praetorial-dev-1101.testnet. Never prints keys. usage (from services/): tsx relayer/scripts/relay500_topup.ts
import { KeyPair, connect, keyStores } from "near-api-js";
import fs from "node:fs";
import { DEFAULT_TESTNET_RPC_URL } from "@praetorial/common/rpc.js";
const DEV = "praetorial-dev-1101.testnet", RPC = process.env.NEAR_RPC_URL ?? DEFAULT_TESTNET_RPC_URL;
const dir = `${process.env.HOME}/.near-credentials/testnet`;
const KEEP = 10n ** 24n / 5n; // leave 0.2 NEAR behind
const SKIP = /^(praetorial-dev-1101|relayer|escrow|intents|fee|keeper|arbiter|attest|maker|outlayer|praetorial-frz|praetorial-e2e)/;
const ks = new keyStores.InMemoryKeyStore();
const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks });
const bal = async (id: string) => BigInt((await (await near.account(id)).getAccountBalance()).available);
console.log("dev before", (await bal(DEV)).toString());
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
  const id = f.replace(/\.json$/, "");
  if (SKIP.test(id)) continue;
  try {
    const k = JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")).private_key;
    await ks.setKey("testnet", id, KeyPair.fromString(k));
    const acct: any = await near.account(id);
    const b = await bal(id);
    if (b <= KEEP + 10n ** 23n) continue;
    const amt = b - KEEP;
    const r = await acct.sendMoney(DEV, amt);
    console.log("swept", id, amt.toString(), "tx", r.transaction.hash);
  } catch (e: any) { console.log("skip", id, String(e?.message ?? e).slice(0, 80)); }
}
console.log("dev after", (await bal(DEV)).toString());
