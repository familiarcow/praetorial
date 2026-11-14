// LIVE1 3b live proof: a brand-new UNFUNDED implicit account (0 NEAR, not on chain) claims a username on the deployed
// registry through the web's own claimWithWallet (same code path as UsernameStep). Prints JSON; exits 1 on failure.
import { KeyPair } from "@near-js/crypto";
import { claimWithWallet, HttpUserRegistry } from "../../lib/refereeRegistry";
import { TESTNET_REGISTRY_URL } from "../../lib/networkSelect";
import { NETWORK } from "../../lib/network";

const kp = KeyPair.fromRandom("ed25519");
const account = Buffer.from(kp.getPublicKey().data).toString("hex");
const exists = await fetch(NETWORK.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "view_account", finality: "final", account_id: account } }) }).then((r) => r.json());
const username = `live1${Date.now().toString(36)}`;
const r = await claimWithWallet({
  registryUrl: TESTNET_REGISTRY_URL, registryId: NETWORK.registryId, username, account,
  signRawHash: async (_a, hashHex) => Buffer.from(kp.sign(Buffer.from(hashHex.replace(/^0x/, ""), "hex")).signature).toString("hex"),
});
const back = await new HttpUserRegistry(TESTNET_REGISTRY_URL).byAccount(account);
const out = { step: "fresh-user-username", account, accountExistsOnChain: !exists.error, username, claim: r, lookup: back };
console.log(JSON.stringify(out));
if (!r.ok || (back as any)?.username !== username || !exists.error) process.exit(1);
