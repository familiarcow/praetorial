// E2S1 (D-STORAGE1): services port of the contract's per-side storage charge (same formula as
// apps/web/lib/storageCharge.ts; parity fixtures from contracts/escrow/src/stg1.rs in common/test/storageCharge.test.ts).
// Contract: Envelope::storage_for(rate) = max(1, ceil(estimated_storage_bytes * storage_per_kib / 1024 / 2)), paid by
// each side in its OWN asset. The envelope's storage_charge_per_side is always "0" (contract refuses nonzero).
const MAX_HASH_LEN = 128, MAX_ACCOUNT_ID_LEN = 64, STORAGE_EVENT_OVERHEAD_BYTES = 256;

/** Mirrors Envelope::estimated_storage_bytes. */
export function estimatedStorageBytes(terms: string | null | undefined, termsHash: string | null | undefined, modelsHash: string | null | undefined): number {
  return new TextEncoder().encode(terms ?? "").length + (termsHash ?? "").length + (modelsHash ?? "").length
    + 3 * 5 * (MAX_HASH_LEN + MAX_ACCOUNT_ID_LEN) + STORAGE_EVENT_OVERHEAD_BYTES;
}

export function storageForRate(bytes: number, ratePerKib: string | bigint): bigint {
  const c = (BigInt(bytes) * BigInt(ratePerKib) + 2047n) / 2048n;
  return c < 1n ? 1n : c;
}

/** What a side must deposit: its stake plus the storage charge in its own asset. */
export function sideDeposit(stake: bigint, bytes: number, ratePerKib: string | bigint): bigint {
  return stake + storageForRate(bytes, ratePerKib);
}

export type AssetLimitView = (assetId: string) => Promise<{ storage_per_kib: string | number | bigint } | null>;

export interface DepositEnvelope {
  terms?: string | null; terms_hash?: string | null; models_snapshot_hash?: string | null;
  stake_maker: string; stake_taker: string; maker_asset: string; taker_asset: string;
}

/** Per-side deposits for an envelope, reading each asset's storage_per_kib from the contract's `asset_limit` view. */
export async function envelopeDeposits(view: AssetLimitView, env: DepositEnvelope): Promise<{ maker: bigint; taker: bigint }> {
  const bytes = estimatedStorageBytes(env.terms, env.terms_hash, env.models_snapshot_hash);
  const rate = async (asset: string) => {
    const l = await view(asset);
    if (!l || l.storage_per_kib == null) throw new Error(`asset_limit missing for ${asset}`);
    return String(l.storage_per_kib);
  };
  return {
    maker: sideDeposit(BigInt(env.stake_maker), bytes, await rate(env.maker_asset)),
    taker: sideDeposit(BigInt(env.stake_taker), bytes, await rate(env.taker_asset)),
  };
}
