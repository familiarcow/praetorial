// STG1b (D-STORAGE1): client-side copy of the contract's per-side storage charge.
// Contract: Envelope::storage_for(rate) = max(1, ceil(estimated_storage_bytes * storage_per_kib / 1024 / 2)), paid by
// each side in its OWN asset. The envelope's storage_charge_per_side is always "0". (PM suggestion: a contract quote
// view would remove this duplicated formula; until then parity is pinned by tests/storageCharge.unit.test.ts.)
import { viewFunction } from "./rpc";
import { ESCROW_CONTRACT_ID } from "./config";

// contracts/escrow: MAX_HASH_LEN 128, MAX_ACCOUNT_ID_LEN 64, STORAGE_EVENT_OVERHEAD_BYTES 256.
const MAX_HASH_LEN = 128, MAX_ACCOUNT_ID_LEN = 64, STORAGE_EVENT_OVERHEAD_BYTES = 256;

/** Mirrors Envelope::estimated_storage_bytes. */
export function estimatedStorageBytes(terms: string | null | undefined, termsHashHex: string | null | undefined, modelsHash: string | null | undefined): number {
  return new TextEncoder().encode(terms ?? "").length + (termsHashHex ?? "").length + (modelsHash ?? "").length
    + 3 * 5 * (MAX_HASH_LEN + MAX_ACCOUNT_ID_LEN) + STORAGE_EVENT_OVERHEAD_BYTES;
}

export function storageForRate(bytes: number, ratePerKib: string | bigint): bigint {
  const n = BigInt(bytes) * BigInt(ratePerKib);
  const c = (n + 2047n) / 2048n;
  return c < 1n ? 1n : c;
}

/** asset id -> storage_per_kib (raw units per 1,024 bytes) */
export type StorageRates = Record<string, string>;

export async function fetchStorageRates(
  assets: string[],
  read: (asset: string) => Promise<{ storage_per_kib: string } | null> = (a) => viewFunction(ESCROW_CONTRACT_ID, "asset_limit", { asset_id: a }),
): Promise<StorageRates> {
  const out: StorageRates = {};
  for (const a of Array.from(new Set(assets))) {
    const l = await read(a);
    if (l && l.storage_per_kib != null) out[a] = String(l.storage_per_kib);
  }
  return out;
}

export function humanUnits(units: bigint, decimals: number): string {
  if (decimals === 0) return units.toString();
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export interface ReviewSide { symbol: string; decimals: number; ratePerKib: string }
export function reviewStorage(a: { terms: string; termsHash: string; modelsHash: string; maker: ReviewSide; taker: ReviewSide }) {
  const bytes = estimatedStorageBytes(a.terms, a.termsHash, a.modelsHash);
  const side = (s: ReviewSide) => {
    const units = storageForRate(bytes, s.ratePerKib);
    return { units, text: `${humanUnits(units, s.decimals)} ${s.symbol}` };
  };
  return { maker: side(a.maker), taker: side(a.taker) };
}

/** Assets whose rate could not be read (contract has no asset_limit for them). */
export function unavailableStorageAssets(ids: string[], rates: StorageRates): string[] {
  return Array.from(new Set(ids)).filter((a) => rates[a] == null);
}
