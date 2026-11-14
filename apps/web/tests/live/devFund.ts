// LIVE1: `npx tsx tests/live/devFund.ts <account> <near>` -> transfers NEAR from the dev account, prints {"tx": "..."}.
// Used by the @live Playwright spec (Playwright's loader can't import lib/release.json, tsx can).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KeyPair } from "@near-js/crypto";
import { actionCreators } from "@near-js/transactions";
import { sendTx, DEV } from "./liveDriver";

const [to, near] = process.argv.slice(2);
if (!/^[0-9a-z._-]{2,64}$/.test(to ?? "") || !/^\d+(\.\d+)?$/.test(near ?? "")) throw new Error("usage: devFund.ts <account> <near>");
const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".near-credentials/testnet", `${DEV}.json`), "utf8"));
const yocto = BigInt(Math.round(Number(near) * 1e6)) * 10n ** 18n;
const r = await sendTx(DEV, KeyPair.fromString(cred.private_key), to, [actionCreators.transfer(yocto)]);
if (!r.ok) throw new Error(`dev transfer failed: ${r.error ?? r.receiptFailure}`);
console.log(JSON.stringify({ tx: r.txHash }));
