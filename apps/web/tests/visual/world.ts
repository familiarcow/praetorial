// Q1: the mocked mainnet world for the visual gate (screens.visual.ts). Bets catalogue and service mocks from spikes/b1/pageshots.spec.ts
// (itself spikes/uir1/shots.spec.ts), plus the funding Worker (F2 createMockFundingWorker + F5 f5Worker: Add money, Cash out, Convert),
// 1Click tokens and the intents balances of the Account page.
// SAFETY: every external request is blocked unless mocked here (Privy's own SDK config GET is the one read-only pass-through; its OTP
// endpoints are mocked). The relayer is mocked to refuse, so nothing is ever sent; cash out "signs" with a throwaway test key against the
// mocked Worker only.
import { type Page } from "@playwright/test";
import nacl from "tweetnacl";
import { f5Worker, ME as F5_ME, KP, type WorkerOpts } from "../funding/withdraw-mock";
import { ONECLICK_TOKENS, ID } from "../funding/fixtures";
import type { SwapRecord } from "../../lib/funding/types";

/** The signed-in user: a 64-hex implicit account (the shape every Privy user has on mainnet), backed by a test key. */
export const ME = F5_ME;
/** Must match VITE_FUNDING_URL in playwright.visual.config.ts. */
export const FUNDING = "https://funding.praetorial.com";
export const USDC = ID.USDC;
export const NEAR = ID.NEAR;
export const BTC = ID.BTC;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ns = (ms: number) => ms * 1_000_000;
const now = Date.now();
const CHAIN = [
  { model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017", model_b: "z-ai/glm-5.3-flash" },
  { model_a: "Qwen/Qwen3.8-27B", model_b: "moonshotai/kimi-k3" },
  { model_a: "google/gemini-3.5-flash", model_b: "openai/gpt-5.4-mini" },
  { model_a: "x-ai/grok-4.7", model_b: "anthropic/claude-haiku-5-5" },
];
const SOURCES = [{ id: "S_CB", publisher: "Coinbase BTC-USD", url: "https://www.coinbase.com/price/bitcoin" }];
const RAW = JSON.stringify({ judge: { run_diagnostics: [
  { model: "m1", content_head: JSON.stringify({ answer: "met", quote: "BTC-USD daily close 121,410.55 on 2026-11-09", source_id: "S_CB", reason: "above 120,000" }) },
] } });

type B = {
  maker: string; taker?: string | null; status: string; claim: string; ma?: string; ta?: string; sm: string; st: string; referee?: string;
  outcome?: string | null; proposedAt?: number | null; eventMs?: number; resolveMs?: number; bonds?: number; raw?: string; pendingReq?: boolean;
};
function bet(id: number, o: B) {
  return {
    envelope: {
      bet_id: id, version: 1, maker: o.maker, taker_allow: "Any", terms_hash: "ab".repeat(32), models_snapshot_hash: "x",
      outcomes: ["YES", "NO"], maker_side: "YES", maker_asset: o.ma ?? USDC, taker_asset: o.ta ?? o.ma ?? USDC,
      stake_maker: o.sm, stake_taker: o.st, taker_options: [], fee_bps: 100, reserve_per_side: "0", storage_charge_per_side: "0",
      keep_terms: true, terms: JSON.stringify({ claimText: o.claim, sources_allowed: SOURCES }), run_price: "0", max_paid_runs: 3, tier: 1, arbiter: null, arbiter_fee: "0",
      funding_deadline: ns(o.eventMs ?? now + 6 * DAY), early_settle_outcome: null, finality_delay: 0,
      settlement_period: ns(DAY), resolve_deadline: ns(o.resolveMs ?? now + 30 * DAY), consent_party_controlled: false,
      referee: o.referee ? { account: o.referee, mode: "Human" } : null,
    },
    status: o.status, taker: o.taker ?? null, created_at: 0, taken_at: o.taker ? ns(now - 3 * DAY) : null,
    proposed_at: o.proposedAt != null ? ns(o.proposedAt) : null, outcome: o.outcome ?? null, reserve_remaining: "0",
    bonds: Array.from({ length: o.bonds ?? 0 }, (_, i) => ({ holder: "bob.near", amount: near(2), round: i + 1, pre_challenge_outcome: "YES", asset: NEAR })),
    exhibits: [], challenged_by: o.bonds ? "bob.near" : null, window_extension_ns: 0, fee_min_taker: "500000",
    last_resolution_raw: o.raw ?? null, pending_resolution_request: o.pendingReq ? { requested_at: ns(now - HOUR) } : null, runs_used: 0,
  };
}
export const usdc = (n: number) => String(Math.round(n * 1e6));
export const near = (n: number) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();

/** The lifecycle catalogue. "mine" = ME is a bettor (maker or taker) unless noted. */
export const BETS: Record<number, ReturnType<typeof bet>> = {
  201: bet(201, { maker: ME, status: "Open", claim: "Bitcoin closes above 120,000 USD on Coinbase on 31 Dec 2026.", sm: usdc(25), st: usdc(25) }),
  202: bet(202, { maker: "alice.near", status: "Open", claim: "ETH trades above 6,000 USD on Coinbase before 1 Jan 2027.", sm: usdc(50), st: usdc(40), eventMs: now + 2 * DAY }),
  203: bet(203, { maker: ME, taker: "bob.near", status: "Taken", claim: "The Lakers beat the Celtics on 14 Nov 2026 (ESPN final score).", ma: NEAR, sm: near(10), st: near(10), eventMs: now + 3 * DAY }),
  204: bet(204, { maker: "carol.near", taker: ME, status: "Resolving", claim: "It snows in central London on 1 Nov 2026 (Met Office).", sm: usdc(15), st: usdc(15), eventMs: now - DAY, pendingReq: true }),
  205: bet(205, { maker: "carol.near", taker: ME, status: "Proposed", outcome: "YES", proposedAt: now - 5 * HOUR, claim: "Bitcoin closes above 120,000 USD on Coinbase on 9 Nov 2026.", sm: usdc(30), st: usdc(30), eventMs: now - 2 * DAY, raw: RAW }),
  206: bet(206, { maker: ME, taker: "bob.near", status: "Challenged", outcome: "YES", proposedAt: now - 10 * HOUR, bonds: 1, claim: "Apple announces a foldable iPhone before 1 Nov 2026.", ma: NEAR, sm: near(25), st: near(25), eventMs: now - 2 * DAY, raw: RAW }),
  207: bet(207, { maker: ME, taker: "bob.near", status: "Finalized", outcome: "YES", proposedAt: now - 2 * DAY, claim: "NYC records a high above 25 C on 1 Nov 2026 (NWS Central Park).", sm: usdc(100), st: usdc(100), eventMs: now - 4 * DAY, raw: RAW }),
  208: bet(208, { maker: "dave.near", taker: ME, status: "Settled", outcome: "NO", proposedAt: now - 3 * DAY, claim: "Real Madrid beats Barcelona on 26 Oct 2026.", sm: usdc(20), st: usdc(20), eventMs: now - 5 * DAY, raw: RAW }),
  209: bet(209, { maker: "erin.near", taker: ME, status: "Settled", outcome: "YES", proposedAt: now - 3 * DAY, claim: "Gold closes above 3,000 USD on 30 Oct 2026.", sm: usdc(20), st: usdc(20), eventMs: now - 5 * DAY, raw: RAW }),
  210: bet(210, { maker: ME, taker: "frank.near", status: "Voided", outcome: "VOID", claim: "The ECB cuts rates on 30 Oct 2026.", sm: usdc(10), st: usdc(10), eventMs: now - 10 * DAY, resolveMs: now - 2 * DAY }),
  211: bet(211, { maker: ME, taker: "gina.near", status: "Settled", outcome: "NO", proposedAt: null, claim: "Our 5k: familiarcow finishes under 22 minutes on 2 Nov 2026.", sm: usdc(5), st: usdc(5), eventMs: now - 9 * DAY }),
  212: bet(212, { maker: ME, taker: "hal.near", status: "Settled", outcome: "YES", proposedAt: now - DAY, referee: "kim.near", claim: "Hal finishes the marathon on 3 Nov 2026.", sm: usdc(20), st: usdc(20), eventMs: now - 8 * DAY }),
  213: bet(213, { maker: ME, status: "Expired", claim: "SOL above 400 USD on 1 Nov 2026.", sm: usdc(15), st: usdc(15), eventMs: now - 10 * DAY }),
  214: bet(214, { maker: ME, status: "Cancelled", claim: "Dodgers win the 2026 World Series.", sm: usdc(15), st: usdc(15), eventMs: now - 10 * DAY }),
  215: bet(215, { maker: ME, taker: "ivy.near", status: "Taken", claim: "Bitcoin closes above 110,000 USD on Coinbase on 8 Nov 2026.", sm: usdc(40), st: usdc(40), eventMs: now - 2 * DAY }),
  216: bet(216, { maker: ME, taker: "jon.near", status: "Finalized", outcome: "YES", proposedAt: now - 3 * DAY, claim: "Arsenal top the Premier League on 1 Nov 2026.", ma: BTC, ta: BTC, sm: "20000", st: "20000", eventMs: now - 5 * DAY, raw: RAW }),
  217: bet(217, { maker: "ivy.near", taker: "jon.near", status: "Taken", referee: ME, claim: "Ivy finishes our 10k under 50 minutes on 9 Nov 2026.", sm: usdc(20), st: usdc(20), eventMs: now - DAY }),
  218: bet(218, { maker: ME, taker: "bob.near", status: "Proposed", outcome: "NO", proposedAt: now - 2 * DAY, claim: "It rains in Paris on 7 Nov 2026 (Meteo-France).", sm: usdc(12), st: usdc(12), eventMs: now - 3 * DAY, raw: RAW }),
  219: bet(219, { maker: ME, taker: "bob.near", status: "Rejudge", outcome: "YES", proposedAt: now - 20 * HOUR, bonds: 1, claim: "Tesla delivers over 500k cars in Q3 2026.", sm: usdc(30), st: usdc(30), eventMs: now - 3 * DAY, raw: RAW }),
  // judge.near is the one person with no username: shown as "Unnamed account", never by the raw id.
  220: bet(220, { maker: ME, taker: "kai.near", status: "Taken", referee: "judge.near", claim: "Kai can do 20 pull-ups by 30 Nov 2026.", sm: usdc(10), st: usdc(10), eventMs: now - HOUR }),
};
const PENDING: Record<number, unknown[]> = {
  207: [{ id: 1, bet_id: 207, token_id: USDC, receiver: ME, amount: usdc(198), reason: "win", attempts: 1, done: false, in_flight: true }],
  216: [{ id: 2, bet_id: 216, token_id: BTC, receiver: ME, amount: "39600", reason: "win", attempts: 3, done: false, in_flight: false }],
};
const ALL = Object.keys(BETS).map(Number);
const hist = (ids: number[]) => ids.map((id) => ({ bet_id: id, maker: BETS[id]!.envelope.maker, taker: BETS[id]!.taker, status: BETS[id]!.status, outcome: BETS[id]!.outcome }));
const NAMES: Record<string, string> = {
  "alice.near": "alice", "dave.near": "dave_bets", "bob.near": "bob", "carol.near": "carol", "erin.near": "erin", "frank.near": "frank",
  "gina.near": "gina", "hal.near": "hal", "kim.near": "kim", "ivy.near": "ivy", "jon.near": "jon", "kai.near": "kai",
};

export interface World {
  paused?: boolean; shutdown?: boolean; signedIn?: boolean; username?: string | null; empty?: boolean; indexerDown?: boolean;
  balanceDown?: boolean; chain?: string; privyInit?: number;
  /** Intents (betting) balances in base units by asset id; default 125.50 USDC, 20 NEAR, 0.0005 BTC + 1.00 USDC (Ethereum) stray. */
  intents?: Record<string, string>;
  /** Add money / Cash out records already on this device. */
  local?: SwapRecord[];
  /** Nothing in the user's NEAR account either (no "Move to betting" rows). */
  nearAccountEmpty?: boolean;
  worker?: WorkerOpts;
}
const DEFAULT_INTENTS: Record<string, string> = { [USDC]: usdc(125.5), [NEAR]: near(20), [BTC]: "50000", [ID.ETH_USDC]: "1000000" };
const BET_TOKENS = new Set<string>([ID.USDC, ID.USDT, ID.NEAR, ID.BTC, ID.ETH, ID.ZEC]);

const SIGN_EXPOSED = new WeakSet<Page>();
/** Mocks every service for one page. Call before page.goto. */
export async function mockWorld(page: Page, o: World = {}) {
  const worker = f5Worker(o.worker);
  const intents = o.intents ?? DEFAULT_INTENTS;
  // Catch-all FIRST (Playwright tries the most recently added route first): anything not mocked below never leaves the machine.
  await page.route((u) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(u.toString()), (r) => {
    const u = r.request().url();
    if (/^https:\/\/auth\.privy\.io\//.test(u) && r.request().method() === "GET") return r.continue(); // Privy SDK config (read-only)
    if (/^https:\/\/(auth\.privy\.io|.*\.privy\.io)\//.test(u) && r.request().method() === "OPTIONS") return r.continue();
    return r.fulfill({ status: 503, body: "blocked by the Q1 visual gate" });
  });
  if (o.signedIn !== false) {
    if (!SIGN_EXPOSED.has(page)) { // a test that re-mocks the same page (another world state) keeps the first binding
      SIGN_EXPOSED.add(page);
      await page.exposeFunction("__q1Sign", (hashHex: string) => Buffer.from(nacl.sign.detached(Buffer.from(hashHex, "hex"), KP.secretKey)).toString("hex"));
    }
    await page.addInitScript(({ me, local }) => {
      (window as any).__e2eTestWallet = { nearAddress: me, signRawHash: async (_a: string, h: string) => (window as any).__q1Sign(h) };
      if (local.length && !sessionStorage.getItem("q1-seeded")) {
        localStorage.setItem(`praetorial:funding:v1:${me}`, JSON.stringify(local));
        sessionStorage.setItem("q1-seeded", "1");
      }
    }, { me: ME, local: o.local ?? [] });
  }
  await page.route("https://auth.privy.io/api/v1/passwordless/init", (r) => {
    const st = o.privyInit ?? 200;
    return r.fulfill({ status: st, contentType: "application/json", body: JSON.stringify(st === 200 ? { success: true } : { error: "upstream_failure" }) });
  });
  await page.route("https://auth.privy.io/api/v1/passwordless/authenticate", (r) => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Invalid email and code combination", code: "invalid_credentials" }) }));
  await page.route("https://sourcecheck.praetorial.com/**", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "service" }) }));
  await page.route("https://1click.chaindefuser.com/v0/tokens", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(ONECLICK_TOKENS) }));
  await page.route(`${FUNDING}/**`, (r) => worker.route(r));
  await page.route("https://bridge.chaindefuser.com/rpc", (r) => r.fulfill({ status: 500, body: "{}" })); // never a permanent bridge address
  await page.route("**/_proxy/relayer/**", (r) => r.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "relayer refused (Q1 visual gate: nothing is ever sent)" }) }));
  await page.route("https://free.rpc.fastnear.com/**", async (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    const p = body.params ?? {};
    const ok = (result: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ jsonrpc: "2.0", id: "1", result }) });
    if (body.method === "status") return ok({ chain_id: o.chain ?? "mainnet" });
    if (body.method === "block") return ok({ header: { height: 100, hash: "FDM3JkqRhGKqxqDqJm7cnzT1LgzDn3dHjkh8gCgV2tHB" } });
    if (p.request_type === "view_access_key") return ok({ nonce: 1 });
    if (p.request_type === "view_account") return ok({ amount: o.nearAccountEmpty ? "0" : near(5.2) });
    if (p.request_type !== "call_function") return ok({});
    const args = JSON.parse(Buffer.from(p.args_base64 ?? "e30=", "base64").toString("utf8") || "{}");
    const bal = (t: string) => intents[t] ?? "0";
    let r: unknown = null;
    switch (p.method_name) {
      case "is_paused": r = !!o.paused || !!o.shutdown; break;
      case "is_shutdown": r = !!o.shutdown; break;
      case "get_bet": r = BETS[args.bet_id] ?? null; break;
      case "bet_count": r = 300; break;
      case "judge_chain": r = CHAIN; break;
      case "pending_judge_pair": r = null; break;
      case "pending_payouts": r = PENDING[args.bet_id] ?? []; break;
      case "open_offers": r = []; break;
      case "required_challenge_bond": r = { asset: NEAR, amount: near(2) }; break;
      case "asset_limit": { const a = String(args.asset_id ?? args.asset ?? ""); const u = a === NEAR ? near : a === BTC ? (n: number) => String(Math.round(n * 1e8 / 100000)) : usdc; r = { min_per_side: u(1), max_per_side: u(10000), min_fee_per_side: u(0.25), storage_per_kib: "1000" }; break; }
      case "protocol_fee_bps": r = 100; break;
      case "mt_balance_of":
        if (o.balanceDown) return route.fulfill({ status: 500, body: "{}" });
        r = bal(args.token_id); break;
      case "mt_batch_balance_of":
        if (o.balanceDown) return route.fulfill({ status: 500, body: "{}" });
        r = (args.token_ids ?? []).map(bal); break;
      case "mt_tokens_for_owner":
        r = Number(args.from_index ?? 0) > 0 ? [] : Object.keys(intents).filter((t) => !BET_TOKENS.has(t)).map((token_id) => ({ token_id })); break;
      case "ft_balance_of": r = p.account_id === USDC.slice(7) && !o.nearAccountEmpty ? usdc(40) : "0"; break;
      case "storage_balance_of": r = { total: "1250000000000000000000", available: "0" }; break;
      default: r = null;
    }
    return ok({ result: Array.from(Buffer.from(JSON.stringify(r), "utf8")) });
  });
  await page.route("**/_proxy/indexer/**", async (route) => {
    if (o.indexerDown) return route.fulfill({ status: 500, body: "{}" });
    const u = new URL(route.request().url());
    const json = (b: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    if (o.empty) return json([]);
    if (u.pathname.endsWith("/offers")) return json([201, 202].map((id) => ({ contract_id: "bets.praetorial.near", bet_id: id, maker: BETS[id]!.envelope.maker, maker_side: "YES", stake_maker: BETS[id]!.envelope.stake_maker, stake_taker: BETS[id]!.envelope.stake_taker, funding_deadline: BETS[id]!.envelope.funding_deadline, taker_allow: "Any" })));
    if (u.searchParams.get("account")) return json(hist(ALL.filter((id) => id !== 202 && id !== 217)));
    if (u.searchParams.get("referee")) return json(hist([217]));
    return json(hist(ALL));
  });
  await page.route("**/_proxy/registry/**", async (route) => {
    const u = new URL(route.request().url());
    const names: Record<string, string> = { ...NAMES, [ME]: o.username === undefined ? "familiarcow" : o.username ?? "" };
    const m = /\/lookup\/account\/(.+)$/.exec(u.pathname);
    if (m) { const n = names[decodeURIComponent(m[1]!)]; return n ? route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ username: n }) }) : route.fulfill({ status: 404, body: "{}" }); }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  return { worker };
}

/** The app's own "loaded" seam (lib/testHooks: set once the first render settled). */
export const ready = (page: Page) => page.waitForFunction(() => (window as any).__e2e?.ready === true, { timeout: 20_000 });
export { ID };
