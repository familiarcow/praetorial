// INTENTS1: redeploy contracts/mock-intents (adds mt_transfer_call / mt_resolve_transfer / mt_batch_balance_of, real
// 1-yocto + amount/self checks on mt_transfer, real DepositMessage parsing in ft_on_transfer; state layout unchanged) to
// the TESTNET mock, then prove the real-shape stake path against the frozen frz3 escrow:
//   1. mt_balance_of probes before/after deploy (state still readable, unchanged)
//   2. mt_transfer_call with 0 deposit -> refused (assert_one_yocto)
//   3. mt_transfer_call {kind:"Nope"} + 1 yocto -> escrow mt_on_transfer refuses -> mt_resolve_transfer refunds in full
//   4. mt_batch_balance_of answers in request order
// Testnet only; never prints keys. usage (from services/): [NEAR_RPC_URL=<testnet rpc>] tsx e2e/live-INTENTS1/deploy_mock_and_prove.ts
import fs from "node:fs";
import { KeyPair, connect, keyStores } from "near-api-js";
import { DEFAULT_TESTNET_RPC_URL } from "../../common/src/rpc.js";

const CRED = `${process.env.HOME}/.near-credentials/testnet`;
const INTENTS = "intents-mock.praetorial-dev-1101.testnet";
const ESCROW = "praetorial-frz3-2611100414.praetorial-dev-1101.testnet";
const USER = "maker1.praetorial-dev-1101.testnet";
const TOKEN = "nep141:usdc.testnet";
const WASM = new URL("../../../contracts/target/wasm32-unknown-unknown/release/mock_intents.wasm", import.meta.url).pathname;
const OUT = new URL("./results.json", import.meta.url).pathname;
const RPC = process.env.NEAR_RPC_URL ?? DEFAULT_TESTNET_RPC_URL;
const TGAS = 10n ** 12n;

const ks = new keyStores.InMemoryKeyStore();
for (const a of [INTENTS, USER]) await ks.setKey("testnet", a, KeyPair.fromString(JSON.parse(fs.readFileSync(`${CRED}/${a}.json`, "utf8")).private_key));
const near = await connect({ networkId: "testnet", nodeUrl: RPC, keyStore: ks });
const mock: any = await near.account(INTENTS);
const user: any = await near.account(USER);
const view = (methodName: string, args: object) => mock.viewFunction({ contractId: INTENTS, methodName, args });
const bal = async (a: string, t = TOKEN) => BigInt(await view("mt_balance_of", { account_id: a, token_id: t }));
const out: Record<string, unknown> = { started: new Date().toISOString(), account: INTENTS, escrow: ESCROW };
const save = () => fs.writeFileSync(OUT, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

const probes: [string, string][] = [[ESCROW, "nep141:wrap.testnet"], [ESCROW, TOKEN], ["praetorial-frz2-2611091914.praetorial-dev-1101.testnet", "nep141:wrap.testnet"], [USER, TOKEN]];
const read = async () => Object.fromEntries(await Promise.all(probes.map(async ([a, t]) => [`${a}|${t}`, (await bal(a, t)).toString()])));
out.before = await read();
const wasm = fs.readFileSync(WASM);
const dep: any = await mock.deployContract(wasm);
out.deploy = { wasmBytes: wasm.length, tx: dep.transaction.hash };
out.after = await read();
out.stateUnchanged = JSON.stringify(out.before) === JSON.stringify(out.after);
save();

try {
  await user.functionCall({ contractId: INTENTS, methodName: "mt_transfer_call", args: { receiver_id: ESCROW, token_id: TOKEN, amount: "1000", msg: "{}" }, gas: 150n * TGAS, attachedDeposit: 0n });
  out.zeroYocto = { ok: false, note: "unexpectedly accepted" };
} catch (e: any) {
  out.zeroYocto = { ok: /exactly 1 yoctoNEAR/.test(String(e?.message ?? e)), observed: String(e?.message ?? e).slice(0, 200) };
}
save();

const mint: any = await user.functionCall({ contractId: INTENTS, methodName: "mint", args: { account_id: USER, token_id: TOKEN, amount: "1000" }, gas: 30n * TGAS });
const u0 = await bal(USER), e0 = await bal(ESCROW);
const r: any = await user.functionCall({ contractId: INTENTS, methodName: "mt_transfer_call", args: { receiver_id: ESCROW, token_id: TOKEN, amount: "1000", msg: JSON.stringify({ kind: "Nope" }) }, gas: 150n * TGAS, attachedDeposit: 1n });
const u1 = await bal(USER), e1 = await bal(ESCROW);
const logs = r.receipts_outcome.flatMap((x: any) => x.outcome.logs);
out.refusedStake = {
  ok: u1 === u0 && e1 === e0 && logs.some((l: string) => l.startsWith("open_rejected")),
  mintTx: mint.transaction.hash, tx: r.transaction.hash, user: [u0, u1], escrow: [e0, e1],
  receipts: r.receipts_outcome.map((x: any) => ({ executor: x.outcome.executor_id, tgas: Number(x.outcome.gas_burnt) / 1e12, status: Object.keys(x.outcome.status)[0], logs: x.outcome.logs.map((l: string) => l.slice(0, 160)) })),
};
const batch = await view("mt_batch_balance_of", { account_id: USER, token_ids: ["nep141:wrap.testnet", TOKEN] });
out.batch = { ok: Array.isArray(batch) && batch.length === 2 && BigInt(batch[1]) === u1, value: batch };
out.finished = new Date().toISOString();
out.ok = out.stateUnchanged === true && (out.zeroYocto as any).ok && (out.refusedStake as any).ok && (out.batch as any).ok;
save();
console.log(JSON.stringify({ ok: out.ok, deploy: out.deploy, stateUnchanged: out.stateUnchanged, zeroYocto: (out.zeroYocto as any).ok, refusedStake: { ok: (out.refusedStake as any).ok, tx: (out.refusedStake as any).tx }, batch: out.batch }, null, 2));
