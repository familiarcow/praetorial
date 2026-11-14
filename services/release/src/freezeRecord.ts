// FRZ1: build the freeze-candidate record. Refuses (FreezeError) unless both release records verify
// (resolver/release/verify_release_record.py exits 0) and a fresh escrow build hash equals the escrow record's hash.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export class FreezeError extends Error {
  constructor(msg: string) { super(msg); this.name = "FreezeError"; }
}
const VERIFIER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "resolver", "release", "verify_release_record.py");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const HEX64 = /^[0-9a-f]{64}$/;

export interface FreezeOptions {
  commit: string; escrowRecord: string; resolverRecord: string; freshEscrowHashFile: string;
  testnetArgs: string; mainnetArgs: string; testSummaryFile: string;
  testnetEscrow?: string; deployTx?: string; verifyOutput?: string;
  expectResolverHash?: string; // RFRZ2: the record's resolver wasm hash must equal this (and both args' resolver_wasm_hash)
  pendingFrz1b?: boolean; // D-FRZ1: draft with explicit 'pending FRZ1b' deploy/E1-E4/tag fields
}

function verifyRecord(label: string, path: string): { hash: string } {
  const r = spawnSync("python3", ["-I", VERIFIER, path], { encoding: "utf8" });
  if (r.status !== 0) throw new FreezeError(`${label} record ${path} does not verify: ${(r.stderr || r.stdout || "").trim()}`);
  return { hash: JSON.parse(readFileSync(path, "utf8")).hash as string };
}

export function buildFreezeRecord(o: FreezeOptions): Record<string, unknown> {
  const PENDING = "pending FRZ1b";
  if (o.pendingFrz1b && (o.testnetEscrow !== undefined || o.deployTx !== undefined || o.verifyOutput !== undefined))
    throw new FreezeError("--pending-frz1b cannot be combined with --testnet-escrow/--deploy-tx/--verify-output");
  if ((o.deployTx !== undefined || o.testnetEscrow !== undefined) && !o.verifyOutput)
    throw new FreezeError("a deployed testnet escrow requires --verify-output (verify-escrow output); refusing to claim a deploy without it");
  if (!/^[0-9a-f]{40}$/.test(o.commit)) throw new FreezeError("--commit must be 40 lowercase hex");
  const esc = verifyRecord("escrow", o.escrowRecord);
  const res = verifyRecord("resolver", o.resolverRecord);
  for (const [label, f] of [["testnet", o.testnetArgs], ["mainnet", o.mainnetArgs]] as const) {
    const pinned = (JSON.parse(readFileSync(f, "utf8")) as { resolver_wasm_hash?: string }).resolver_wasm_hash;
    if (pinned !== res.hash) throw new FreezeError(`resolver wasm hash mismatch: ${label} args pin ${pinned} but resolver record ${o.resolverRecord} has ${res.hash}`);
  }
  if (o.expectResolverHash !== undefined && o.expectResolverHash !== res.hash)
    throw new FreezeError(`resolver wasm hash mismatch: resolver record ${o.resolverRecord} has ${res.hash}, expected ${o.expectResolverHash}`);
  const fresh = readFileSync(o.freshEscrowHashFile, "utf8").trim().split(/\s+/)[0] ?? "";
  if (!HEX64.test(fresh)) throw new FreezeError(`fresh build hash file ${o.freshEscrowHashFile} does not hold a sha256`);
  if (fresh !== esc.hash) throw new FreezeError(`fresh build hash ${fresh} != escrow record hash ${esc.hash}`);
  const out: Record<string, unknown> = {
    commit: o.commit,
    escrow: { wasm_sha256: esc.hash, record: o.escrowRecord, fresh_build_sha256: fresh },
    resolver: { hash: res.hash, record: o.resolverRecord },
    gen_new_args: { testnet_sha256: sha(readFileSync(o.testnetArgs)), mainnet_sha256: sha(readFileSync(o.mainnetArgs)) },
    test_summary: readFileSync(o.testSummaryFile, "utf8").trim(),
  };
  if (o.testnetEscrow !== undefined) {
    out.testnet_escrow = {
      account: o.testnetEscrow, deploy_tx: o.deployTx ?? null,
      verify_output_sha256: o.verifyOutput ? sha(readFileSync(o.verifyOutput)) : null,
    };
  }
  if (o.pendingFrz1b) {
    out.status = "draft";
    out.testnet_escrow = { account: PENDING, deploy_tx: PENDING, verify_output_sha256: PENDING };
    out.verify_escrow = { E1: PENDING, E2: PENDING, E3: PENDING, E4: PENDING };
    out.tag = PENDING;
  }
  return out;
}

export function writeFreezeRecord(o: FreezeOptions, out: string): void {
  writeFileSync(out, JSON.stringify(buildFreezeRecord(o), null, 2) + "\n");
}
