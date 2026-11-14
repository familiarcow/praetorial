// RCB1: the escrow's storage constants and the per-side storage formula, PARSED from contracts/escrow/src/lib.rs
// (not copied). If the source shape changes so that anything below cannot be found, parsing throws: the release
// generator then refuses to run rather than checking against stale numbers.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface ContractConstants {
  maxTermsLen: bigint;
  maxHashLen: bigint;
  maxAccountIdLen: bigint;
  eventOverheadBytes: bigint;
  /** hashes always written per bet (terms_hash + models_snapshot_hash) */
  alwaysWrittenHashes: bigint;
  /** filers x exhibits-per-filer in `estimated_storage_bytes` (3 * 5) */
  exhibitSlots: bigint;
}

export const LIB_RS_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "contracts", "escrow", "src", "lib.rs");
/** "typical" bet used for the table: ~4 KB of estimated storage. */
export const TYPICAL_ENVELOPE_BYTES = 4096n;

/** Evaluates `8 * 1024` / `256` (integer products only). */
function evalProduct(expr: string, what: string): bigint {
  const parts = expr.split("*").map((s) => s.trim().replace(/_/g, ""));
  if (parts.length === 0 || !parts.every((p) => /^[0-9]+$/.test(p))) throw new Error(`${what}: cannot evaluate "${expr}" (only integer products are supported)`);
  return parts.reduce((a, p) => a * BigInt(p), 1n);
}

function constant(src: string, name: string): bigint {
  const m = new RegExp(`pub const ${name}\\s*:\\s*(?:usize|u64|u32|u128)\\s*=\\s*([0-9_ *]+);`).exec(src);
  if (!m) throw new Error(`lib.rs: constant ${name} not found (or not an integer product); refusing to guess`);
  return evalProduct(m[1], name);
}

export function parseContractConstants(src: string): ContractConstants {
  const maxTermsLen = constant(src, "MAX_TERMS_LEN");
  const maxHashLen = constant(src, "MAX_HASH_LEN");
  const maxAccountIdLen = constant(src, "MAX_ACCOUNT_ID_LEN");
  const eventOverheadBytes = constant(src, "STORAGE_EVENT_OVERHEAD_BYTES");

  const ex = /let max_exhibit_bytes\s*=\s*([0-9 *]+?)\s*\*\s*\(\s*MAX_HASH_LEN as u64\s*\+\s*MAX_ACCOUNT_ID_LEN as u64\s*\)\s*;/.exec(src);
  if (!ex) throw new Error("lib.rs: max_exhibit_bytes formula in estimated_storage_bytes not found (exhibit limits); refusing to guess");
  const exhibitSlots = evalProduct(ex[1], "max_exhibit_bytes");

  if (!/self\.terms_hash\.len\(\) as u64\s*\+\s*self\.models_snapshot_hash\.len\(\) as u64/.test(src)) {
    throw new Error("lib.rs: always_written_hash_bytes (terms_hash + models_snapshot_hash) not found in estimated_storage_bytes");
  }
  if (!/estimated_storage_bytes\(\) as u128 \* storage_per_kib/.test(src) || !/\(num \+ 2047\) \/ 2048/.test(src) || !/std::cmp::max\(1,/.test(src)) {
    throw new Error("lib.rs: storage_for rate formula max(1, ceil(bytes*rate/2048)) not found; the 2048 divisor changed?");
  }
  if (!/terms_bytes\s*\+\s*always_written_hash_bytes\s*\+\s*max_exhibit_bytes\s*\+\s*STORAGE_EVENT_OVERHEAD_BYTES/.test(src)) {
    throw new Error("lib.rs: estimated_storage_bytes sum (terms + hashes + exhibits + overhead) not found");
  }
  return { maxTermsLen, maxHashLen, maxAccountIdLen, eventOverheadBytes, alwaysWrittenHashes: 2n, exhibitSlots };
}

export function loadContractConstants(path: string = LIB_RS_PATH): ContractConstants {
  return parseContractConstants(readFileSync(path, "utf8"));
}

/** `estimated_storage_bytes` of the maximum envelope: MAX_TERMS_LEN terms, max-length hashes, all exhibit slots full. */
export function maxEnvelopeBytes(c: ContractConstants): bigint {
  return c.maxTermsLen + c.alwaysWrittenHashes * c.maxHashLen + c.exhibitSlots * (c.maxHashLen + c.maxAccountIdLen) + c.eventOverheadBytes;
}

/** Contract `Envelope::storage_for`: max(1, ceil(bytes * rate / 2048)) per side. Unbounded BigInt (overflow is checked by callers). */
export function storageCharge(bytes: bigint, rate: bigint, _c?: ContractConstants): bigint {
  const v = (bytes * rate + 2047n) / 2048n;
  return v < 1n ? 1n : v;
}
