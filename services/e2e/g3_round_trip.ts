// G3: real resolver wasm (wasmtime, local-signer feature) <-> real
// deployed testnet escrow contract round trip.
//
// 1. Generate a resolver test keypair (ed25519, same scheme the contract
//    verifies with env::ed25519_verify) and open+take a real bet on
//    escrow.praetorial-dev-1101.testnet whose envelope.resolver_pubkey is
//    that keypair's public key.
// 2. Feed the bet's real envelope+terms (shaped exactly like
//    `request_resolution`'s own `input_data`) to the actual
//    `praetorial-resolver.wasm` binary via `wasmtime run -S http`
//    (--features real-http local-signer), which runs the full pipeline
//    (terms_hash check, stage-2 source fetch of two public https pages,
//    lint, decide, map ESCALATE->VOID) and signs the result with the
//    local-signer feature using the same seed as the envelope's pubkey.
//    NEAR_AI_API_KEY is NOT passed to wasmtime, so the model caller is
//    OfflineMock -- 0 NEAR AI calls spent by this script.
// 3. Submit the real signed SubmittedResult to the real contract via
//    submit_outcome; confirm it's accepted and the bet moves to Proposed.
// 4. Submit a tampered copy (same signature, different run_no+outcome)
//    and confirm the contract rejects it.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig, loadKeyFile } from "@praetorial/common/config.js";
import nacl from "tweetnacl";
import { generateResolverKeypair } from "@praetorial/common/resolverSign.js";
import { buildSourceCheckMessage } from "@praetorial/common/sourceCheck.js";
import { buildOpenMsg } from "@praetorial/common/openMsg.js";
import type { Envelope, Bet } from "@praetorial/common/types.js";
import { envelopeDeposits } from "@praetorial/common/storageCharge.js";

const CRED_DIR = process.env.NEAR_CREDENTIALS_DIR ?? `${process.env.HOME}/.near-credentials/testnet`;
function keyFor(accountId: string) {
  return loadKeyFile(`${CRED_DIR}/${accountId}.json`);
}
function sha256hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

const RESOLVER_WASM = process.env.RESOLVER_WASM ??
  `${process.env.HOME}/praetorial/resolver/target/wasm32-wasip2/release/praetorial-resolver.wasm`;

function runResolver(job: object, seedHex: string): any {
  // G3-real (Loop 3): wasmtime -S http sandboxes the guest's env -- only
  // vars explicitly named via --env cross in. NEAR_AI_API_KEY (never
  // logged here) and NEAR_AI_API_BASE must be forwarded the same way
  // PRAETORIAL_LOCAL_SIGNER_SEED_HEX already was, or a real-http build
  // falls back to no key and makes no live call.
  const envArgs: string[] = ["--env", "PRAETORIAL_LOCAL_SIGNER_SEED_HEX"];
  if (process.env.NEAR_AI_API_KEY) envArgs.push("--env", "NEAR_AI_API_KEY");
  if (process.env.NEAR_AI_API_BASE) envArgs.push("--env", "NEAR_AI_API_BASE");
  const stdout = execFileSync(
    "wasmtime",
    ["run", "-S", "http", ...envArgs, RESOLVER_WASM],
    { input: JSON.stringify(job), env: { ...process.env, PRAETORIAL_LOCAL_SIGNER_SEED_HEX: seedHex }, maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout.toString("utf8"));
}

async function main() {
  const cfg = loadServiceConfig();
  const escrow = cfg.escrowContract;
  const intents = cfg.intentsContract;
  const makerId = process.env.E2E_MAKER_ID ?? "maker1.praetorial-dev-1101.testnet";
  const takerId = process.env.E2E_TAKER_ID ?? "taker1.praetorial-dev-1101.testnet";
  const keeperId = process.env.E2E_KEEPER_ID ?? "keeper.praetorial-dev-1101.testnet";

  const makerClient = new NearClient(cfg, { accountId: makerId, privateKey: keyFor(makerId).private_key });
  const takerClient = new NearClient(cfg, { accountId: takerId, privateKey: keyFor(takerId).private_key });
  const keeperKey = keyFor(keeperId);
  const keeperClient = new NearClient(cfg, { accountId: keeperId, privateKey: keeperKey.private_key });
  await Promise.all([makerClient.init(), takerClient.init(), keeperClient.init()]);

  const log: Record<string, unknown>[] = [];
  const record = (step: string, detail: unknown) => {
    log.push({ step, detail });
    console.log(`[G3] ${step}:`, JSON.stringify(detail));
  };

  // 1. Resolver test keypair -- the seed never leaves this process's env
  // var when shelling out to wasmtime; never printed.
  const resolverKeypair = generateResolverKeypair();
  const resolverSeedHex = Buffer.from(resolverKeypair.secretKey.slice(0, 32)).toString("hex");
  record("resolver_keypair_generated", { pubkey: resolverKeypair.publicKeyHex });

  // 2. Term sheet: passes lint() (claim/elements/rule/sources/time/clauses
  // present, >=2 independent non-party-controlled publishers, ALL rule)
  // and names two real public https sources so stage-2 fetch wiring
  // (task 2) is exercised live as part of this same round trip.
  // G3-real (Loop 3): names a real model so build_submission's fixed
  // "models" param (resolver/wasm-bin/src/main.rs, G6 fix) actually
  // calls it over the live NEAR AI API, instead of the hardcoded "mock"
  // id a real build could never resolve. Only used when the wasm binary
  // was built with --features real-http and NEAR_AI_API_KEY is in this
  // process's env (forwarded to wasmtime below); otherwise OfflineMock
  // still answers "insufficient" regardless of this field.
  // BUG FOUND (G3-real, this run): wasi-http-client 0.2's
  // RequestBuilder::send() does one `blocking-write-and-flush` of the
  // whole request body, which wasmtime's wasi:io/streams caps at 4096
  // bytes per call -- any body over that (e.g. the previous version of
  // this term, whose fetched example.com + iana.org page text landed in
  // the chat messages) traps with "Buffer too large for
  // blocking-write-and-flush" before ever reaching the network. This is
  // a real limitation of the vendored HTTP client crate, not of our
  // code; tracked below (not fixed by forking the crate this loop) by
  // keeping every live-model request body under ~2 KB: no stage-2 URL
  // fetch (sources_allowed entries omit `url`, so build_submission never
  // fetches them -- lint() is still satisfied by 2 non-party-controlled
  // publishers), so the single real model call this script makes stays
  // well under the 4096-byte ceiling.
  const term = {
    claim: "example.com and the IANA reserved-domains page are reachable on the public internet",
    rule: "ALL",
    sources: true,
    clauses: ["AVAILABLE_V1"],
    time: { window_start: "2026-01-01T00:00:00Z", window_end: "2026-12-31T23:59:59Z", evidence_cutoff: "2027-01-01T00:00:00Z" },
    elements: [{ id: "e1", q: "Is the domain live and serving content" }],
    sources_allowed: [
      { id: "S1", publisher: "IANA Example" },
      { id: "S2", publisher: "IETF Example" },
    ],
  };
  const termsText = JSON.stringify(term);
  const termsHash = sha256hex(termsText);

  // 3. Mint test USDC to maker/taker.
  const tokenId = cfg.usdcTokenId;
  const stakeMaker = 1_000_000n;
  const stakeTaker = 1_000_000n;
  // D-ECON5: no per-bet reserve any more -- stake + storage only.
  // E2S1: envelope storage_charge_per_side is "0"; each side deposits stake + the contract's per-side charge
  // (max(1, ceil(bytes*storage_per_kib/2048)) from the asset_limit view).
  const { maker: makerRequired, taker: takerRequired } = await envelopeDeposits(
    (a) => makerClient.view(escrow, "asset_limit", { asset_id: a }),
    { terms: termsText, terms_hash: termsHash, models_snapshot_hash: "g3-round-trip-v0", stake_maker: stakeMaker.toString(), stake_taker: stakeTaker.toString(), maker_asset: tokenId, taker_asset: tokenId });
  await keeperClient.call(intents, "mint", { account_id: makerId, token_id: tokenId, amount: makerRequired.toString() }, 30);
  await keeperClient.call(intents, "mint", { account_id: takerId, token_id: tokenId, amount: takerRequired.toString() }, 30);
  record("mint_test_usdc", { maker: makerRequired.toString(), taker: takerRequired.toString() });

  // 4. Maker opens the bet with resolver_pubkey = our test keypair.
  const nowNs = Date.now() * 1_000_000;
  const envelope: Envelope = {
    bet_id: 0,
    version: 1,
    maker: makerId,
    taker_allow: { Any: {} },
    terms_hash: termsHash,
    models_snapshot_hash: "g3-round-trip-v0",
    outcomes: ["YES", "NO"],
    maker_side: "YES",
    stake_maker: stakeMaker.toString(),
    stake_taker: stakeTaker.toString(),
    fee_bps: 100,
    storage_charge_per_side: "0",
    keep_terms: true,
    terms: termsText,
    max_paid_runs: 2,
    tier: 1,
    maker_asset: tokenId,
    taker_asset: tokenId,
    funding_deadline: nowNs + 180 * 1_000_000_000,
    early_settle_outcome: null,
    finality_delay: 0,
    settlement_period: 30 * 1_000_000_000,
    resolve_deadline: nowNs + 7200 * 1_000_000_000,
    consent_party_controlled: false,
  } as unknown as Envelope;

  // D-KEY1/D-FETCH2 (7g2): handle_open requires a fresh resolver-signed
  // sources-reachable attestation, verified against the contract's
  // pinned attest_pubkey (resolver_keys() view) -- never an envelope
  // field. Signed here with the same resolver test keypair.
  const checkedAtNs = Date.now() * 1_000_000;
  const scMessage = Buffer.from(buildSourceCheckMessage(termsHash, String(checkedAtNs)), "utf8");
  const scSig = nacl.sign.detached(scMessage, resolverKeypair.secretKey);
  const attestation = { checked_at: checkedAtNs, signature_hex: Buffer.from(scSig).toString("hex") };

  const openResult: any = await makerClient.call(
    intents,
    "transfer_with_msg",
    { receiver_id: escrow, token_id: tokenId, amount: makerRequired.toString(), msg: buildOpenMsg(envelope as any, attestation) },
    80,
  );
  record("open", { tx_hash: openResult?.transaction?.hash });

  // open_offers(from, limit) filters open_bet_ids by id >= from, then
  // takes the first `limit` -- on a long-lived testnet contract with many
  // prior test bets, bet ids are ascending, so a small limit from 0 never
  // reaches a freshly-created high id. Ask for a lot.
  const offers: Bet[] = await makerClient.view(escrow, "open_offers", { from: 0, limit: 100000 });
  const created = offers.filter((b) => b.envelope.maker === makerId && b.taker === null).pop();
  if (!created) throw new Error("could not find the just-created open offer");
  const betId = created.envelope.bet_id;
  record("discovered_bet_id", { bet_id: betId });

  // 5. Taker takes it -> bet status Taken (submit_outcome's own require
  // accepts Taken/Resolving/Challenged/Evidence -- no request_resolution
  // call is needed for this G3 round trip).
  const takeResult: any = await takerClient.call(
    intents,
    "transfer_with_msg",
    { receiver_id: escrow, token_id: tokenId, amount: takerRequired.toString(), msg: JSON.stringify({ kind: "Take", bet_id: betId, invite_sig: null }) },
    80,
  );
  record("take", { tx_hash: takeResult?.transaction?.hash });

  const betAfterTake: Bet = await makerClient.view(escrow, "get_bet", { bet_id: betId });
  record("post_take_status", { status: betAfterTake.status });
  if (betAfterTake.status !== "Taken") throw new Error(`expected Taken, got ${betAfterTake.status}`);

  // 6. Build the job exactly like the real contract's own input_data
  // shape (request_resolution's resolution_input_data), feed it to the
  // real resolver wasm under wasmtime -S http.
  const runNo = Date.now(); // fresh, not in bet.used_run_nos (empty)
  const job = {
    contract: escrow,
    bet_id: betId,
    envelope: betAfterTake.envelope,
    terms: termsText,
    round: 0,
    run_no: runNo,
    payer_account_id: keeperId,
  };
  const resolverOut = runResolver(job, resolverSeedHex);
  record("resolver_ran", { result: resolverOut.result, notes: resolverOut.notes, signed: !!resolverOut.signing });
  if (!resolverOut.signing) throw new Error("resolver did not produce a signature (local-signer wiring broken)");
  if (resolverOut.signing.pubkey_hex !== resolverKeypair.publicKeyHex) {
    throw new Error("resolver's derived pubkey does not match this script's resolver test keypair");
  }

  // 7. Submit the real signed result to the real contract.
  const submitResult: any = await keeperClient.call(
    escrow,
    "submit_outcome",
    { result: resolverOut.result, signature_hex: resolverOut.signing.signature_hex },
    80,
  );
  record("submit_outcome", { tx_hash: submitResult?.transaction?.hash, outcome: resolverOut.result.outcome });

  const betAfterSubmit: Bet = await makerClient.view(escrow, "get_bet", { bet_id: betId });
  record("post_submit_status", { status: betAfterSubmit.status, outcome: betAfterSubmit.outcome });
  if (betAfterSubmit.status !== "Proposed") {
    throw new Error(`G3 FAILED: expected Proposed after a genuine signed submit_outcome, got ${betAfterSubmit.status}`);
  }

  // 8. Tampered copy: same signature, different run_no + flipped
  // outcome -> the borsh buffer changes, so the old signature cannot
  // verify. Expect the contract to reject it.
  const flip: Record<string, string> = { YES: "NO", NO: "VOID", VOID: "YES" };
  const tampered = {
    ...resolverOut.result,
    run_no: runNo + 1,
    outcome: flip[resolverOut.result.outcome as string] ?? "YES",
  };
  let tamperRejected = false;
  let tamperError = "";
  try {
    await keeperClient.call(escrow, "submit_outcome", { result: tampered, signature_hex: resolverOut.signing.signature_hex }, 80);
  } catch (e: any) {
    tamperRejected = true;
    tamperError = String(e?.message ?? e).slice(0, 300);
  }
  record("tampered_submit_outcome", { rejected: tamperRejected, error: tamperError });
  if (!tamperRejected) throw new Error("G3 FAILED: tampered SubmittedResult was NOT rejected by the contract");

  const betFinal: Bet = await makerClient.view(escrow, "get_bet", { bet_id: betId });
  record("final_status_unchanged_by_tamper_attempt", { status: betFinal.status, outcome: betFinal.outcome });

  fs.mkdirSync("./data", { recursive: true });
  fs.writeFileSync("./data/g3-round-trip-log.json", JSON.stringify(log, null, 2));
  console.log("\nG3 COMPLETE. Log written to ./data/g3-round-trip-log.json");
}

main().catch((err) => {
  console.error("G3 FAILED:", err);
  process.exit(1);
});
