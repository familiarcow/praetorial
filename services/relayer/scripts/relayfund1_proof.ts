// RELAYFUND1 live testnet proof (D-TNEAR1): fresh implicit account wraps 0.1 NEAR (near_deposit) and moves it to the
// testnet intents contract (ft_transfer_call, msg {"receiver_id": user}) -- BOTH as user-signed NEP-366 delegates relayed
// by relayer.praetorial-dev-1101.testnet through the real Relayer + policy. Testnet only. Never prints keys.
// usage (from services/): NEAR_NETWORK=testnet NEAR_RPC_URL=<testnet rpc> STEP_MSG=json|empty|plain tsx relayer/scripts/relayfund1_proof.ts
import fs from "node:fs";
import { KeyPair, connect, keyStores } from "near-api-js";
import { actionCreators, buildDelegateAction, Signature, SCHEMA, encodeDelegateAction } from "@near-js/transactions";
import * as borsh from "borsh";
import { createHash } from "node:crypto";
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig, loadKeyFile } from "@praetorial/common/config.js";
import { Relayer, chainPortFromClient } from "../src/relayer.js";
import { LAUNCH_TOKEN_CONTRACTS } from "../src/policy.js";

const CRED = `${process.env.HOME}/.near-credentials/testnet`;
const DEV = process.env.FUNDER ?? "praetorial-dev-1101.testnet", RELAYER = "relayer.praetorial-dev-1101.testnet";
const ESCROW = "escrow3.praetorial-dev-1101.testnet", INTENTS = "intents-mock.praetorial-dev-1101.testnet", WNEAR = "wrap.testnet";
const OUT = new URL("../../e2e/live-RELAYFUND2/results.json", import.meta.url).pathname;
const res: any = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : { txs: [] };
const save = () => fs.writeFileSync(OUT, JSON.stringify(res, null, 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cfg = loadServiceConfig();
const mkClient = async (id: string) => { const c = new NearClient(cfg, { accountId: id, privateKey: loadKeyFile(`${CRED}/${id}.json`).private_key }); await c.init(); return c; };
const devClient: any = await mkClient(DEV); // read-only provider/view use
const ks = new keyStores.InMemoryKeyStore(); // setup txs use a plain near-api-js account (own nonce handling)
await ks.setKey("testnet", DEV, KeyPair.fromString(loadKeyFile(`${CRED}/${DEV}.json`).private_key));
const devAcct: any = await (await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL!, keyStore: ks })).account(DEV);
const dev: any = { account: devAcct };
void devClient;
const provider = (devClient as any).account.connection.provider;
const view = async (contractId: string, method: string, args: any) => (dev as any).account.viewFunction({ contractId, methodName: method, args });

const userKey = KeyPair.fromRandom("ed25519");
const pub = userKey.getPublicKey();
const user = Buffer.from((pub as any).data).toString("hex");
res.user = user; res.msgFormat = process.env.STEP_MSG ?? "json"; res.network = "testnet";
const rec = (step: string, hash: string, extra: any = {}) => { res.txs.push({ step, hash, url: `https://testnet.nearblocks.io/txns/${hash}`, ...extra }); save(); console.log("tx", step, hash); };

// setup (direct, funded by the dev account, NOT relayed): fund the fresh user with 0.2 NEAR; register the intents contract on wrap.testnet storage.
const fund: any = await (dev as any).account.sendMoney(user, 200_000_000_000_000_000_000_000n);
rec("setup: fund fresh user 0.2 NEAR", fund.transaction.hash);
await sleep(2500);
const sb = await view(WNEAR, "storage_balance_of", { account_id: INTENTS });
res.intentsStorageOnWnearBefore = sb;
if (!sb) {
  await sleep(4000); // let the dev account's nonce settle after the fund tx
  const r: any = await (dev as any).account.functionCall({ contractId: WNEAR, methodName: "storage_deposit", args: { account_id: INTENTS, registration_only: true }, gas: 30_000_000_000_000n, attachedDeposit: 1_250_000_000_000_000_000_000n });
  rec("setup: storage_deposit(intents) on wrap.testnet (direct, dev account)", r.transaction.hash);
}
res.userStorageOnWnearBefore = await view(WNEAR, "storage_balance_of", { account_id: user });

// RELAYFUND2: ONE relayer-key client for both back-to-back relays (nonce race fixed in chainPortFromClient).
const relayer = new Relayer(chainPortFromClient(await mkClient(RELAYER)), {
  escrowContract: ESCROW, intentsContract: INTENTS, usdcTokenId: "usdc.fakes.testnet",
  fundTokenContracts: [...LAUNCH_TOKEN_CONTRACTS], wnearContract: WNEAR,
  maxTransferAmount: 1_000_000_000n, maxBlockHeightFuture: 1200n, perCallSponsorshipYocto: 5_000_000_000_000_000_000_000n,
  maxRequestsPerWindow: 20, windowMs: 60_000, dailyBudgetYocto: 100_000_000_000_000_000_000_000n,
} as any);

let nonceBase: bigint | undefined;
async function signAndRelay(step: string, receiverId: string, method: string, args: any, gas: bigint, deposit: bigint) {
  const ak: any = await provider.query({ request_type: "view_access_key", finality: "final", account_id: user, public_key: pub.toString() });
  nonceBase = BigInt(ak.nonce) + 1n;
  const blk: any = await provider.block({ finality: "final" });
  const da = buildDelegateAction({ senderId: user, receiverId, actions: [actionCreators.functionCall(method, args, gas, deposit)], nonce: nonceBase, maxBlockHeight: BigInt(blk.header.height) + 100n, publicKey: pub as any });
  const hash = createHash("sha256").update(Buffer.from(encodeDelegateAction(da))).digest();
  const signature = new Signature({ keyType: 0, data: userKey.sign(hash).signature });
  const b64 = Buffer.from(borsh.serialize(SCHEMA.SignedDelegate, { delegateAction: da, signature })).toString("base64");
  try {
    const r = await relayer.relay(b64);
    rec(step, r.txHash); return r.txHash;
  } catch (e: any) { res.txs.push({ step, error: String(e?.message ?? e) }); save(); console.log("RELAY ERROR", step, e?.message ?? e); throw e; }
}
const outcome = async (hash: string) => {
  const o: any = await provider.txStatus(hash, user, "FINAL");
  const failures = (o.receipts_outcome ?? []).filter((x: any) => x.outcome.status?.Failure).map((x: any) => x.outcome.status.Failure);
  const logs = (o.receipts_outcome ?? []).flatMap((x: any) => x.outcome.logs);
  const sv = o.status?.SuccessValue; return { failures, logs, successValue: sv === undefined ? null : Buffer.from(sv, "base64").toString() };
};

const AMOUNT = 100_000_000_000_000_000_000_000n; // 0.1 NEAR
const balIntents = async () => view(INTENTS, "mt_balance_of", { account_id: user, token_id: "nep141:wrap.testnet" });
res.mtBalanceBefore = await balIntents();

const h1 = await signAndRelay("1 relayed near_deposit 0.1 NEAR on wrap.testnet", WNEAR, "near_deposit", {}, 30_000_000_000_000n, AMOUNT);
res.nearDepositOutcome = await outcome(h1); save();
res.wnearBalanceAfterWrap = await view(WNEAR, "ft_balance_of", { account_id: user });
console.log("wNEAR balance after wrap", res.wnearBalanceAfterWrap);

const fmt = process.env.STEP_MSG ?? "json";
const msg = fmt === "empty" ? "" : fmt === "plain" ? user : JSON.stringify({ receiver_id: user });
const h2 = await signAndRelay(`2 relayed ft_transfer_call wrap.testnet -> intents (msg ${fmt}; actual wNEAR balance)`, WNEAR, "ft_transfer_call", { receiver_id: INTENTS, amount: res.wnearBalanceAfterWrap, msg }, 100_000_000_000_000n, 1n);
res.moveOutcome = await outcome(h2);
await sleep(3000);
res.wnearBalanceAfterMove = await view(WNEAR, "ft_balance_of", { account_id: user });
res.mtBalanceAfter = await balIntents();
save();
if (!(BigInt(res.mtBalanceAfter) > 0n)) { console.log("PROOF FAILED: mt_balance_of is 0"); process.exitCode = 1; }
console.log(JSON.stringify({ moveOutcome: res.moveOutcome, wnearAfterMove: res.wnearBalanceAfterMove, mtBefore: res.mtBalanceBefore, mtAfter: res.mtBalanceAfter }, null, 1));
