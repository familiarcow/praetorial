// LIVE2: one signed function call from a testnet account whose key is in ~/.near-credentials/testnet (testnet only; never prints keys).
// usage (from services/): tsx relayer/scripts/live2_call.ts <signer> <contract> <method> '<json args>' <deposit yocto> [gasTgas]
import fs from "node:fs";
import { KeyPair, connect, keyStores } from "near-api-js";
import { DEFAULT_TESTNET_RPC_URL } from "../../common/src/rpc.js";
const [signer, contract, method, args, deposit, gas] = process.argv.slice(2);
if (!signer.endsWith(".testnet") && !/^[0-9a-f]{64}$/.test(signer)) throw new Error("testnet only");
const ks = new keyStores.InMemoryKeyStore();
await ks.setKey("testnet", signer, KeyPair.fromString(JSON.parse(fs.readFileSync([`${process.env.HOME}/.near-credentials/testnet/${signer}.json`, `${process.env.HOME}/.near-credentials/testnet/live1/${signer}.json`].find((f) => fs.existsSync(f))!, "utf8")).private_key));
const acct: any = await (await connect({ networkId: "testnet", nodeUrl: process.env.NEAR_RPC_URL ?? DEFAULT_TESTNET_RPC_URL, keyStore: ks })).account(signer);
try {
  const r: any = await acct.functionCall({ contractId: contract, methodName: method, args: JSON.parse(args), attachedDeposit: BigInt(deposit), gas: BigInt(gas ?? "100") * 10n ** 12n });
  const fails = (r.receipts_outcome ?? []).filter((o: any) => o.outcome.status.Failure).map((o: any) => o.outcome.status.Failure);
  console.log(JSON.stringify({ tx: r.transaction.hash, status: r.status, receiptFailures: fails, logs: (r.receipts_outcome ?? []).flatMap((o: any) => o.outcome.logs) }));
} catch (e: any) { console.log(JSON.stringify({ error: String(e?.message ?? e).slice(0, 500), tx: e?.transaction_outcome?.id })); process.exit(1); }
