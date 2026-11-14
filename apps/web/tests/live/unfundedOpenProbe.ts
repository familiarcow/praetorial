// FUND2 live probe (testnet): a user whose betting balance exists on intents but whose implicit NEAR account was never created on
// chain (the mainnet "deposited USDC through a deposit address, holds 0 NEAR" user). Before FUND2: the web crashed reading the
// nonce and the relayer answered 500 (spikes/fund2/NOTES.md). Now: POST /activate creates the account, then the open goes through.
// Run: cd apps/web && npx tsx tests/live/unfundedOpenProbe.ts   (mints mock USDC to a FRESH key; never touches a real user)
import { KeyPair } from "near-api-js";
import { mintIntents, intentsBalance, USDC, ONE_USDC, openBet, log, type LiveAccount } from "./liveDriver";
import { nonceOrActivate, requestActivation } from "../../lib/accountActivation";
import { viewAccessKeyNonceOrNull } from "../../lib/rpc";

const kp = KeyPair.fromRandom("ed25519");
const id = Buffer.from((kp.getPublicKey() as any).data).toString("hex");
const acct: LiveAccount = { id, label: "fund2-unfunded", keyPair: kp };
const out: Record<string, unknown> = { at: new Date().toISOString(), account: id };
out.mintTx = await mintIntents(acct, USDC, 20n * ONE_USDC);
out.balanceBefore = (await intentsBalance(id, USDC)).toString();
out.keyBefore = String(await viewAccessKeyNonceOrNull(id, id));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
try {
  out.nonceAfterActivation = String(await nonceOrActivate({ read: () => viewAccessKeyNonceOrNull(id, id), activate: () => requestActivation(id), sleep }));
  const r = await openBet({ maker: acct, asset: "USDC", stakeMaker: 10n * ONE_USDC, stakeTaker: 10n * ONE_USDC, referee: null, takerAccount: null, label: "fund2-unfunded" });
  out.open = { betId: r.betId, tx: r.txHash, http: r.httpStatus, receiptFailure: r.receiptFailure, rejected: r.openRejected };
} catch (e) { out.error = String((e as any)?.message ?? e).slice(0, 300) + ((e as any)?.detail ? ` | ${(e as any).detail}` : ""); }
out.balanceAfter = (await intentsBalance(id, USDC)).toString();
out.pass = !!(out.open as any)?.betId;
log(JSON.stringify(out));
console.log(JSON.stringify(out));
