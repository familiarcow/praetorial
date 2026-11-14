// FE2c / D-FUND1 path (2): per-asset deposit address from the NEAR Intents deposit API (the POA bridge JSON-RPC,
// https://bridge.chaindefuser.com/rpc, public, no auth, CORS open). `deposit_address {account_id, chain}` returns an
// address on that chain whose deposits are credited to `account_id` INSIDE Intents -- which is where the app reads the
// balance (mt_balance_of) and funds stakes from. `supported_tokens` gives the minimum deposit per chain+asset.
//
// Rule (1): a NEAR account id is never shown as a deposit address. Fail closed: error, unsupported asset, a response for a
// different chain/recipient, or an address that is the user's own NEAR account -> no address is shown.
//
// Testnet: the API has no testnet chains (probe 2026-11-08: near:testnet -> "Chain not supported"), so the deposit-address
// path is mainnet-only; testnet shows path (3) only plus an "available on mainnet" note.
import { findAsset, CURRENT_NETWORK, type NetworkId } from "./assets";
import { fromBaseUnits } from "./decimal";

export const DEPOSIT_API_URL = "https://bridge.chaindefuser.com/rpc";

/** `creditedTokenId` is the intents token id the bridge credits for `defuseId` (its `intents_token_id`). It MUST be the escrow's
 * launch token for that asset (release/mainnet-night/args.mainnet.json), or the money arrives as a token the app can't read or bet. */
export interface DepositRoute { chain: string; defuseId: string; creditedTokenId: string; chainLabel: string; kind: "btc" | "zec" | "evm" | "near" }
/** The six launch assets (D-ZEC1) and where each is deposited from.
 * DEPFIX1 (FUND3 F1, live P0): USDC/USDT used to be routed from Ethereum (`eth:1`), which the bridge credits as bridged
 * `eth-0x….omft.near` tokens the escrow rejects. The only source that credits the escrow's USDC/USDT is NEAR-chain
 * USDC/USDT sent to the user's `near:mainnet` deposit address (bridge `supported_tokens`, FUND3 §2.2). */
// Token ids come from the asset table (lib/assets.ts, the one place that names *.near ids); tests check each credited id against
// release/mainnet-night/args.mainnet.json and the live bridge mapping (FUND3 evidence).
const mainnetId = (symbol: string): string => {
  const id = findAsset(symbol)?.ids.mainnet;
  if (!id) throw new Error(`no mainnet id for ${symbol}`);
  return id;
};
const nearChainToken = (symbol: string): string => `near:mainnet:${mainnetId(symbol).replace(/^nep141:/, "")}`;
export const DEPOSIT_ROUTES: Record<string, DepositRoute> = {
  BTC: { chain: "btc:mainnet", defuseId: "btc:mainnet:native", creditedTokenId: mainnetId("BTC"), chainLabel: "Bitcoin", kind: "btc" },
  ZEC: { chain: "zec:mainnet", defuseId: "zec:mainnet:native", creditedTokenId: mainnetId("ZEC"), chainLabel: "Zcash", kind: "zec" },
  ETH: { chain: "eth:1", defuseId: "eth:1:native", creditedTokenId: mainnetId("ETH"), chainLabel: "Ethereum", kind: "evm" },
  USDC: { chain: "near:mainnet", defuseId: nearChainToken("USDC"), creditedTokenId: mainnetId("USDC"), chainLabel: "NEAR", kind: "near" },
  USDT: { chain: "near:mainnet", defuseId: nearChainToken("USDT"), creditedTokenId: mainnetId("USDT"), chainLabel: "NEAR", kind: "near" },
  NEAR: { chain: "near:mainnet", defuseId: "near:mainnet:native", creditedTokenId: mainnetId("NEAR"), chainLabel: "NEAR", kind: "near" },
};

/** DEPFIX1 (FUND3 F2/F6/F7): the text shown with every deposit address. */
export interface DepositWording { badge: string; send: string; onlyNetwork: string; minimum: string; evmNote: string | null }
export function depositWording(symbol: string, chainLabel: string, isEvm: boolean, minDepositLabel: string): DepositWording {
  return {
    badge: `${chainLabel} network`,
    send: `Send ${symbol} on ${chainLabel} to this address. It lands in your betting balance.`,
    onlyNetwork: `Only send ${symbol} on the ${chainLabel} network. Other networks won't reach your betting balance.`,
    minimum: `Minimum ${minDepositLabel} — smaller deposits are not credited.`,
    // F2: the bridge gives the same 0x address on every EVM chain; only the named chain credits the betting token.
    evmNote: isEvm
      ? `This address also works on Base, Arbitrum, BNB and other EVM networks, but only ${symbol} sent on ${chainLabel} reaches your betting balance. Anything sent on another network won't show up here.`
      : null,
  };
}

export type DepositOption =
  | { ok: true; symbol: string; chain: string; chainLabel: string; isEvm: boolean; creditedTokenId: string; address: string; minDepositUnits: string; minDepositLabel: string }
  | { ok: false; symbol: string; reason: "unsupported" | "wrong_recipient" | "error"; message: string };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export const depositApiEnabled = (network: NetworkId = CURRENT_NETWORK): boolean => network === "mainnet";

/** True for anything shaped like a NEAR account id: 64-hex implicit, or a dotted/.near/.testnet name. Used to refuse such a value as a non-NEAR deposit address. */
export function isNearAccountLike(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s) || /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(s);
}

function addressLooksRight(kind: DepositRoute["kind"], a: string): boolean {
  switch (kind) {
    case "btc": return /^(bc1[a-z0-9]{20,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,39})$/.test(a);
    case "zec": return /^(t[13][a-km-zA-HJ-NP-Z1-9]{33}|u1[a-z0-9]{50,})$/.test(a);
    case "evm": return /^0x[0-9a-fA-F]{40}$/.test(a);
    case "near": return /^[0-9a-f]{64}$/.test(a) || /^[a-z0-9_.-]{2,64}$/.test(a);
  }
}

const fail = (symbol: string, reason: "unsupported" | "wrong_recipient" | "error", message: string): DepositOption => ({ ok: false, symbol, reason, message });
const ERR = (symbol: string) => fail(symbol, "error", `We can't get a deposit address for ${symbol} right now. Try again in a moment.`);
const UNSUP = (symbol: string) => fail(symbol, "unsupported", `Deposits of ${symbol} aren't available yet.`);
const WRONG = (symbol: string) => fail(symbol, "wrong_recipient", `We couldn't confirm that this ${symbol} address credits your account, so we're not showing it. Try again.`);

async function rpc(f: FetchLike, method: string, params: unknown[]): Promise<any> {
  const res = await f(DEPOSIT_API_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }) });
  if (!res.ok) throw new Error(`deposit api http ${res.status}`);
  return res.json();
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export async function fetchDepositOption(symbol: string, intentsAccount: string, f: FetchLike = defaultFetch): Promise<DepositOption> {
  const route = DEPOSIT_ROUTES[symbol];
  const asset = findAsset(symbol);
  if (!route || !asset) return UNSUP(symbol);
  try {
    const [dep, tok] = await Promise.all([
      rpc(f, "deposit_address", [{ account_id: intentsAccount, chain: route.chain }]),
      rpc(f, "supported_tokens", [{ chains: [route.chain] }]),
    ]);
    if (dep?.error) return /not supported/i.test(String(dep.error)) ? UNSUP(symbol) : ERR(symbol);
    const r = dep?.result;
    if (!r || typeof r.address !== "string" || !r.address) return ERR(symbol);
    // DEPFIX1: the entry must credit the escrow's token; a source that maps to any other token id is never offered.
    const t = (tok?.result?.tokens ?? []).find((x: any) => x?.defuse_asset_identifier === route.defuseId && x?.intents_token_id === route.creditedTokenId);
    if (!t) return UNSUP(symbol);
    // Recipient checks: same chain back; any recipient field the API echoes must be this user; never the user's NEAR account id; right address shape.
    if (r.chain !== route.chain) return WRONG(symbol);
    for (const k of ["account_id", "recipient", "recipient_id", "receiver_id"]) if (r[k] !== undefined && r[k] !== intentsAccount) return WRONG(symbol);
    if (r.address === intentsAccount) return WRONG(symbol);
    if (!addressLooksRight(route.kind, r.address)) return WRONG(symbol);
    if (route.kind !== "near" && isNearAccountLike(r.address)) return WRONG(symbol);
    const min = t.min_deposit_amount;
    if (typeof min !== "string" || !/^\d+$/.test(min)) return ERR(symbol);
    return { ok: true, symbol, chain: route.chain, chainLabel: route.chainLabel, isEvm: route.kind === "evm", creditedTokenId: route.creditedTokenId, address: r.address, minDepositUnits: min, minDepositLabel: `${fromBaseUnits(min, Number(t.decimals ?? asset.decimals))} ${symbol}` };
  } catch {
    return ERR(symbol);
  }
}

export async function fetchAllDepositOptions(intentsAccount: string, f: FetchLike = defaultFetch): Promise<Record<string, DepositOption>> {
  const syms = Object.keys(DEPOSIT_ROUTES);
  const all = await Promise.all(syms.map((s) => fetchDepositOption(s, intentsAccount, f)));
  return Object.fromEntries(syms.map((s, i) => [s, all[i]]));
}
