// Single asset table for the whole app. Every other module (CreateOffer,
// escrowAdapter, config) reads asset ids/decimals from here instead of
// keeping its own copy.
//
// v1 whitelist per the Decision register D-ASSET1 (2026-11-04, six v1
// assets, mainnet ids from 1Click /v0/tokens 2026-11-04):
//   - USDC   nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1  (6 dp)
//   - USDT   nep141:usdt.tether-token.near                                            (6 dp)
//   - BTC    omni BTC, nep141:btc.omft.near                                           (8 dp)
//   - NEAR   shown as "NEAR", backed by wNEAR nep141:wrap.near                        (24 dp)
//   - ETH    omni ETH, nep141:eth.omft.near                                           (18 dp)
//   - ZEC    nep141:zec.omft.near                                                     (8 dp)
//
// Testnet: only USDC (usdc.testnet) and NEAR (wrap.testnet) are enabled.
// USDT/BTC/ETH/ZEC have no testnet id in v1 and are disabled with a
// plain "mainnet only" label rather than a guessed/placeholder id.
//
// Amounts are handled as bigint-safe decimal strings (lib/decimal.ts) --
// never float multiplication -- so 24-decimal NEAR amounts never lose
// precision.

import { resolveNetworkId, readBuildEnv, MAINNET_ONLY_BUILD } from "./networkSelect";
import { RELEASE_ASSET_LIMITS } from "./assetLimits.generated";

export type NetworkId = "testnet" | "mainnet";

export interface AssetDef {
  symbol: string;
  decimals: number;
  /** nep141 asset id per network; absent = not deployed/known on that network */
  ids: Partial<Record<NetworkId, string>>;
  /** Human reason an asset is disabled on a given network even if an id exists */
  disabledReason?: Partial<Record<NetworkId, string>>;
  /** Per-asset maximum stake per side, in the asset's own units. Unset = unlimited (D-CAP1: no beta cap by default). */
  maxStakePerSide?: string;
  /** D-CAP2: per-asset MINIMUM stake per side, native units -- mirrors
   * contracts/escrow/src/lib.rs's `AssetLimit.min_per_side` (per-asset
   * min, replacing the old flat USDC-only-no-min cap). */
  minStakePerSide?: string;
  /** D-FEEMIN1: minimum protocol fee per side, native units; mirrors `AssetLimit.min_fee_per_side`. */
  minFeePerSide?: string;
  /** D-ECON5: round-0 judge run cost in this asset's own native units,
   * mirrors `AssetLimit.run_price`. */
  runPrice?: string;
  /** D-BOND1: challenge-bond floor, native units, mirrors `AssetLimit.min_bond`. */
  minBond?: string;
  /** D-BOND1: objection/rebuttal deposit floor, native units, mirrors `AssetLimit.min_objection`. */
  minObjection?: string;
}

/** D-CAP3 (supersedes D-CAP2's ~$1,000/side): no stake cap at launch. Every asset's max_per_side is the largest overflow-safe
 * value, 10^34 raw units (largest power of ten <= u128::MAX / 4096). Mirrors services/release/src/stakeCap.ts::launchMaxPerSide
 * and contracts/escrow/src/cap3.rs::CAP3_MAX (crosschecked in tests). */
export const LAUNCH_MAX_PER_SIDE = "10000000000000000000000000000000000";

const BASE_ASSETS: AssetDef[] = [
  {
    symbol: "USDC",
    decimals: 6,
    ids: {
      ...(MAINNET_ONLY_BUILD ? {} : { testnet: "nep141:usdc.testnet" }), // MAINPREP: dropped from a mainnet bundle
      mainnet:
        "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    },
  },
  {
    symbol: "USDT",
    decimals: 6,
    ids: {
      mainnet: "nep141:usdt.tether-token.near",
    },
    disabledReason: {
      testnet: "mainnet only -- no testnet id in v1",
    },
  },
  {
    symbol: "BTC",
    decimals: 8,
    ids: {
      mainnet: "nep141:btc.omft.near", // omni BTC
    },
    disabledReason: {
      testnet: "mainnet only -- no testnet id in v1",
    },
  },
  {
    // Shown to users as "NEAR"; backed onchain by wNEAR (wrap.near/wrap.testnet).
    symbol: "NEAR",
    decimals: 24,
    ids: {
      ...(MAINNET_ONLY_BUILD ? {} : { testnet: "nep141:wrap.testnet" }), // MAINPREP: dropped from a mainnet bundle
      mainnet: "nep141:wrap.near",
    },
  },
  {
    symbol: "ETH",
    decimals: 18,
    ids: {
      mainnet: "nep141:eth.omft.near", // omni ETH
    },
    disabledReason: {
      testnet: "mainnet only -- no testnet id in v1",
    },
  },
  {
    symbol: "ZEC",
    decimals: 8,
    ids: {
      mainnet: "nep141:zec.omft.near",
    },
    disabledReason: {
      testnet: "mainnet only -- no testnet id in v1",
    },
  },
];

/** Limits come from the release args new() is deployed with (D-VA1 1): lib/assetLimits.generated.ts is generated from
 * release/draft-args.mainnet.json by scripts/genAssetLimits.ts and test-checked current. */
export const ASSET_TABLE: AssetDef[] = BASE_ASSETS.map((a) => {
  const id = a.ids.mainnet;
  const l = id ? RELEASE_ASSET_LIMITS[id] : undefined;
  if (!l) throw new Error(`no release-args limits for ${a.symbol}`);
  return { ...a, ...l };
});

// Network the app currently runs against. Derived from NEAR_RPC_URL in
// config.ts in one place to avoid two sources of truth; kept as a
// constant here (not re-importing config.ts) to avoid a circular import
// since config.ts re-exports from this module for back-compat.
export const CURRENT_NETWORK: NetworkId = resolveNetworkId(readBuildEnv()); // WEBNET1: one selector (lib/networkSelect.ts)

export function findAsset(symbol: string): AssetDef | undefined {
  return ASSET_TABLE.find((a) => a.symbol === symbol);
}

/** Human amount -> on-chain base units string for `symbol`, scaled by that
 * asset's own decimals. Exact decimal-string math (no float multiply);
 * throws if the amount has more fractional digits than the asset supports. */
export function toBaseUnits(symbol: string, amount: number | string): string {
  const a = findAsset(symbol);
  if (!a) throw new Error(`unknown asset ${symbol}`);
  // String(number) is JS's shortest round-trip form ("0.1", not 0.1000...0555);
  // tiny values come back in exponent form, so expand those via toFixed.
  let s = typeof amount === "number" ? String(amount) : amount.trim();
  if (/e/i.test(s)) s = Number(s).toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount ${amount}`);
  const [whole, frac = ""] = s.split(".");
  if (frac.length > a.decimals) {
    throw new Error(`amount ${amount} exceeds ${symbol} precision (${a.decimals} decimals)`);
  }
  const units = BigInt(whole) * 10n ** BigInt(a.decimals) + BigInt((frac || "0").padEnd(a.decimals, "0") || "0");
  return units.toString();
}

/** Parse a number|string amount into a plain decimal string, expanding
 * exponent notation (e.g. tiny floats print as "1e-7") the same way
 * toBaseUnits does, so both helpers agree on what a "decimal string" is. */
function decimalString(amount: number | string): string {
  let s = typeof amount === "number" ? String(amount) : amount.trim();
  if (/e/i.test(s)) s = Number(s).toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** Decompose a decimal string into (sign, all-digits-as-bigint, fractional scale). */
function decimalParts(s: string): { negative: boolean; digits: bigint; scale: number } {
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`invalid amount ${s}`);
  const [whole, frac = ""] = s.split(".");
  return { negative, digits: BigInt(whole + frac), scale: frac.length };
}

/** Exact decimal multiply `a * b`, returned as a decimal string -- no
 * float multiply, so e.g. 10 * 1.1 is exactly "11", never
 * 11.000000000000002. Uses BigInt on the amounts' decimal-digit strings
 * (handling exponent form like toBaseUnits does) instead of JS's
 * floating-point `*`, which rounds in binary and produces artifacts
 * once the result needs more significant digits than a double holds. */
export function mulDecimal(a: number | string, b: number | string): string {
  const pa = decimalParts(decimalString(a));
  const pb = decimalParts(decimalString(b));
  const negative = pa.negative !== pb.negative;
  const product = pa.digits * pb.digits;
  const scale = pa.scale + pb.scale;
  if (scale === 0) return (negative && product !== 0n ? "-" : "") + product.toString();
  const digits = product.toString().padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  const result = frac.length ? `${whole}.${frac}` : whole;
  return negative && product !== 0n ? `-${result}` : result;
}

export function assetId(symbol: string, network: NetworkId = CURRENT_NETWORK): string | null {
  return findAsset(symbol)?.ids[network] ?? null;
}

/** Reverse lookup: nep141 asset id -> display symbol, across any network (bet envelopes don't say which network they're on). Falls back to the raw id if unknown so the UI never hides an asset it doesn't recognize. */
export function symbolForAssetId(id: string): string {
  for (const a of ASSET_TABLE) {
    if (Object.values(a.ids).includes(id)) return a.symbol;
  }
  return id;
}

/** An asset is enabled on a network only if it has an id there AND no disabledReason for it. */
export function isAssetEnabled(symbol: string, network: NetworkId = CURRENT_NETWORK): boolean {
  const a = findAsset(symbol);
  if (!a) return false;
  if (!a.ids[network]) return false;
  if (a.disabledReason?.[network]) return false;
  return true;
}

export function disabledReason(symbol: string, network: NetworkId = CURRENT_NETWORK): string | null {
  const a = findAsset(symbol);
  if (!a) return "unknown asset";
  if (a.disabledReason?.[network]) return a.disabledReason[network]!;
  if (!a.ids[network]) return `no ${network} id configured`;
  return null;
}

/** All assets known on this network, enabled or not (callers decide how to render disabled ones). */
export function listAssets(network: NetworkId = CURRENT_NETWORK): AssetDef[] {
  return ASSET_TABLE.filter((a) => a.ids[network]);
}

export function listEnabledAssets(network: NetworkId = CURRENT_NETWORK): AssetDef[] {
  return listAssets(network).filter((a) => isAssetEnabled(a.symbol, network));
}

/** Builder check (CAP3): a human `amount` against the asset's max_per_side, compared EXACTLY in base units. `maxRaw` defaults to
 * the table value; a guardian-lowered max can be passed in. Returns null at launch values (the cap is not user-reachable). */
export function stakeMaxProblem(symbol: string, amount: number | string, maxRaw: string | null = maxStakePerSide(symbol)): string | null {
  if (maxRaw === null || maxRaw === LAUNCH_MAX_PER_SIDE) return null;
  const base = BigInt(toBaseUnits(symbol, amount));
  if (base <= BigInt(maxRaw)) return null;
  return `Stake exceeds the current max per side (${rawToHuman(symbol, maxRaw)} ${symbol})`;
}

/** Label for a "Max:" hint, or null while the asset is at the launch cap (nothing to show). */
export function launchMaxLabel(symbol: string, maxRaw: string | null = maxStakePerSide(symbol)): string | null {
  if (maxRaw === null || maxRaw === LAUNCH_MAX_PER_SIDE) return null;
  return rawToHuman(symbol, maxRaw);
}

function rawToHuman(symbol: string, raw: string): string {
  const d = findAsset(symbol)?.decimals ?? 0;
  const padded = raw.padStart(d + 1, "0");
  const whole = padded.slice(0, padded.length - d);
  const frac = padded.slice(padded.length - d).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Per-asset max stake per side, in the asset's own units, or null if unset (unlimited). D-CAP1. */
export function maxStakePerSide(symbol: string): string | null {
  return findAsset(symbol)?.maxStakePerSide ?? null;
}
