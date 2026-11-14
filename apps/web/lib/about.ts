// NAV1 (UX-31 About): familiarcow: "About the project. - How it works - What models it uses - How verifiability works - Anything else users
// need to know". Static, plain English. Every claim is sourced (no number is typed in where the code already has it):
//  - fee 1% per side: PROTOCOL_FEE_BPS_V1 = 100 (contracts/escrow/src/lib.rs; live protocol_fee_bps view = 100), D-FEEMIN1 minimum per side;
//    minimums come from the release asset limits (lib/assetLimits.generated.ts <- release/mainnet-night/args.mainnet.json).
//  - no fee on cancel/expire/void: C12. Storage charge: D-STORAGE1. Optional referee tip = the fee: D-REFFEE / D-REFUI.
//  - 24h challenge window per round, 2 rounds: ROUND_WINDOW_NS, args limits.max_rounds = 2 (D-DISPUTE1).
//  - 7-day retry before a void: RECOVERY_WINDOW_NS (D-RESOLVE1). Concede: D-CONCEDE1. Person decides, pays at once, no AI fallback: D-REFUI4.
//  - judge chain: args judge_chain (4 pairs; = the live judge_chain view on bets.praetorial.near), both models must agree (D-JUDGECHAIN1).
//  - verify (V1, every sentence checked in spikes/v1/CLAIMS.md): fingerprint = args resolver_wasm_hash (= lib/release*.json and the
//    live resolver_keys view), wasm on FastFS (outlayer_config.wasm_base_url, sha256 re-checked), source NOT public (no repo remote;
//    GATE-10 open), OutLayer TEE = OutLayer's claim (no quote checked anywhere), outcome key pinned at new() and only bound to the
//    wasm by an off-chain report-pubkey check at deploy (logs/verify-escrow.txt E4), escrow code non-upgradeable with no access keys
//    (view_access_key_list empty, DeleteKey tx ACkj5srV...). Pause / shutdown: D-SUNSET2/3. Guardian params 24h delay: D-PARAMS1.
import { findAsset } from "./assets";
import { fromBaseUnits } from "./decimal";
import { formatAmount } from "./amount";
import { loadReleaseConfig } from "./releaseConfig";
import { INTENTS_CONTRACT_ID } from "./config";
import type { RawJudgePair } from "./judgeChain";

/** The launch judge chain as deployed (release/mainnet-night/args.mainnet.json judge_chain; test-checked). The page reads the live
 * judge_chain view and shows this only while that read is pending or failed. */
export const LAUNCH_JUDGE_CHAIN: RawJudgePair[] = [
  { model_a: "deepseek-ai/DeepSeek-V4.1-Flash-1017", model_b: "z-ai/glm-5.3-flash" },
  { model_a: "Qwen/Qwen3.8-27B", model_b: "moonshotai/kimi-k3" },
  { model_a: "google/gemini-3.5-flash", model_b: "openai/gpt-5.4-mini" },
  { model_a: "x-ai/grok-4.7", model_b: "anthropic/claude-haiku-5-5" },
];

/** "deepseek-ai/DeepSeek-V4.1-Flash-1017" -> "DeepSeek-V4.1-Flash" (provider prefix and a 4-digit release suffix dropped). */
export function modelLabel(id: string): string {
  const name = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return name.replace(/-\d{4}$/, "");
}

export interface AboutPair { position: number; label: string; role: string }
export function judgePairsForAbout(chain: RawJudgePair[]): AboutPair[] {
  return chain.map((p, i) => ({ position: i + 1, label: `${modelLabel(p.model_a)} + ${modelLabel(p.model_b)}`, role: i === 0 ? "First choice" : `Backup ${i}` }));
}

export const RESOLVER_WASM_HASH = loadReleaseConfig().resolver_wasm_hash;
export const RESOLVER_WASM_HASH_SHORT = `${RESOLVER_WASM_HASH.slice(0, 8)}…`;

/** A minimum in the amount rule's shape (lib/money: stables 2 dp, others at most 6 significant figures), rounded UP so a minimum is
 *  never understated (A1, UIR1 §3.7: the old table printed up to 8 decimals). */
function minText(symbol: string, units: bigint): string {
  const a = findAsset(symbol)!;
  if (symbol === "USDC" || symbol === "USDT") return formatAmount(symbol, units, { cents: true });
  if (units === 0n) return `0 ${symbol}`;
  const digits = units.toString();
  const keepDigits = 6; // significant figures
  const drop = Math.max(0, digits.length - keepDigits); // low base-unit digits rounded away
  const step = 10n ** BigInt(drop);
  const up = ((units + step - 1n) / step) * step;
  return `${fromBaseUnits(up.toString(), a.decimals)} ${symbol}`;
}

export interface FeeRow { symbol: string; minFee: string; minStake: string }
export function feeRows(symbols: readonly string[]): FeeRow[] {
  return symbols.flatMap((s) => {
    const a = findAsset(s);
    if (!a?.minFeePerSide || !a.minStakePerSide) return [];
    return [{ symbol: s, minFee: minText(s, BigInt(a.minFeePerSide)), minStake: minText(s, BigInt(a.minStakePerSide)) }];
  });
}

export interface AboutSection {
  id: "what" | "how" | "models" | "verify" | "fees" | "know";
  title: string;
  paragraphs?: string[];
  steps?: { title: string; text: string }[];
  bullets?: { title: string; text: string }[];
  /** V1: a heading over the bullets (the verify section's "what this proves, and what it doesn't"). */
  bulletsTitle?: string;
  /** V1: the developer box (the checker script, served by this site). */
  dev?: { title: string; text: string; command: string; scriptHref: string };
}

/** A1 (UIR1 §3.7): the 3-step card row under "What Praetorial is". One sentence each, no jargon. The full rules stay in "how". */
export const ABOUT_STEPS: { title: string; text: string }[] = [
  { title: "Make an offer", text: "Write a question with a clear answer, name the sources and the date, and put in your stake." },
  { title: "Someone takes it", text: "They put in their stake, and until then you can cancel and get your money back." },
  { title: "Decided and paid", text: "After the date the AI judge (or a person you both chose) decides, and the winner gets both stakes." },
];

/** A1: the one-line grey summary on each collapsed About section (no full stop). "what" is always open (null). */
export function aboutSummary(id: AboutSection["id"], models?: { firstPair: string; pairs: number }): string | null {
  switch (id) {
    case "what": return null;
    case "how": return "Challenges, refunds and conceding";
    case "models": return models ? `${models.pairs} pairs, first: ${models.firstPair}` : "Two models must agree";
    case "verify": return "Open program, signed rulings, frozen rules";
    case "fees": return "1% per side, only when someone wins";
    case "know": return "Real money, beta, refunds";
  }
}

export const ABOUT: AboutSection[] = [
  {
    id: "what",
    title: "What Praetorial is",
    paragraphs: [
      "Praetorial lets two people bet on a question with a clear answer, like a price, a game or anything a public web page will confirm.",
      "Both stakes go into an escrow contract on NEAR. When the bet's date comes, an AI judge reads the sources named in the bet and decides, or a person you both trust decides. The stakes can only go to you or the other person, minus the fee (and a tip if a person decides).",
    ],
  },
  {
    id: "how",
    title: "How a bet works, in full",
    steps: [
      { title: "Make an offer", text: "Write the question, the sources that will answer it and the date, and put in your stake. Anyone can take it, or only the person you send it to." },
      { title: "Someone takes it", text: "They put in their stake. Until then you can cancel and get your money back. If nobody takes it before it closes, your money comes back." },
      { title: "The AI judge or a person decides", text: "After the date, the AI judge reads the sources and rules YES, NO or VOID. If you picked a person instead, they rule, and their ruling pays out straight away (no AI is used)." },
      { title: "24 hours to challenge", text: "An AI ruling becomes final after a 24 hours challenge window. A bettor who disagrees can challenge it by posting a bond (returned if the challenge wins) and the bet is judged again. There can be up to two challenges, each with its own 24 hours window." },
      { title: "Payout", text: "Once the ruling is final, the winner gets both stakes, minus the fee, in their betting balance, unless no ruling can be made in time (for example someone uses up the 3 paid runs early); then both sides are refunded." },
      { title: "Refunds", text: "For built-in bet types the judge retries for up to 7 days. For custom bets, a source that can't be read ends the bet as a refund (VOID). If it can't decide, or rules VOID, each side gets their own stake back, with no protocol fee; the small terms-storage charge is not refunded. If a person was chosen and doesn't rule by the deadline, both sides are refunded too." },
      { title: "Conceding", text: "Either side can concede at any time after the bet is taken and before it is paid out. The other side wins straight away (the normal fee applies). Nobody else has to agree." },
    ],
  },
  {
    id: "models",
    title: "Which AI models judge",
    paragraphs: [
      "The judge uses a pair of models; each launch pair is from two different companies. On a custom bet both read the same sources and must agree, otherwise there is no winner on that run. On a bet code can check from a data feed (a price, a game, a temperature), code decides and the first model checks it: it can only confirm that answer or force a VOID.",
      "The first pair judges while both its models are available. The others are backups, used in order only if a model is retired. A new backup pair can only be added after a 7 day public notice.",
    ],
  },
  {
    id: "verify",
    title: "How to verify a bet",
    paragraphs: [
      "You don't have to trust this site. Every step of a bet is a transaction on NEAR, and every AI ruling is signed. Here is how to check a bet yourself.",
    ],
    steps: [
      { title: "Open the bet's Activity", text: "On the bet page, open Activity and tap Verify under any step: making the bet, taking it, a ruling, a challenge, a payout. You see the NEAR transaction that did it, who signed it and the exact amounts that moved. \"Open on NearBlocks\" shows the same transaction on a public explorer, outside this site." },
      { title: "Open the AI judge's Verify sheet", text: "Tap \"Verify this ruling\" on the ruling, or Details, AI judge, Verify. It shows what the judge was asked (the bet's exact terms and instructions), which program judged, where it ran, what it said, and the transaction where the escrow accepted it. A green tick is a check your browser just did, like the terms hash and the ruling's signature." },
      { title: "Check the program", text: `Tap "Download the program" and compare its fingerprint (sha256) with the one shown (${RESOLVER_WASM_HASH_SHORT}). The same fingerprint is stored in the escrow and can't change. The program file is kept on NEAR FastFS.` },
      { title: "Keep a copy", text: "Tap \"Download verification file\" on the bet page. It holds the terms, every ruling with its signature, every transaction and the program's fingerprint. It's your own copy of the record." },
      { title: "Run the checker", text: "Run the free checker on that file, or ask someone you trust to. It checks everything in the file against NEAR itself, without this site, and prints PASS or FAIL for each check." },
    ],
    bullets: [
      { title: "One fixed program", text: `The judge is one fixed program. Its fingerprint (${RESOLVER_WASM_HASH_SHORT}) is stored in the escrow and can't be changed. The program file is published on NEAR FastFS, so anyone can download it and check the fingerprint. Its source code is not public yet.` },
      { title: "Run by OutLayer", text: "The escrow itself asks OutLayer to run exactly that program, by its fingerprint, and OutLayer's own log on NEAR names it. OutLayer runs it in a sealed computer (a TEE). That part is OutLayer's promise: the escrow doesn't check it." },
      { title: "One signing key", text: "The escrow only accepts an AI ruling signed with one key, set when it was deployed. A ruling signed with anything else is refused. We checked once, at deploy, that OutLayer gives this key only to that program; the escrow doesn't re-check it." },
      { title: "Signed rulings can't be edited", text: "Nobody, us included, can change a ruling after it is signed: the signature would no longer match. The answer still depends on the source pages and the AI models the judge reads." },
      { title: "Frozen code", text: "The escrow's code can't be changed and its account has no keys left. We can still pause new offers, shut the escrow down in an emergency (then every bet whose ruling isn't final yet can be refunded), change fees and limits for new bets or add a token after a 24 hour notice, close a token to new bets, add a backup model pair after a 7 day notice, and close an offer nobody has taken yet (full refund)." },
    ],
    bulletsTitle: "What this proves, and what it doesn't",
    dev: {
      title: "For developers",
      text: "verify-bet.mjs has no dependencies and needs Node 18 or newer. It re-checks the terms hash, every ruling's signature against the key stored in the escrow, the program's fingerprint (it downloads the program), the escrow's code hash and that it has no keys, and every transaction in the file. Each check prints PASS, FAIL or SKIP; it exits with 1 if anything fails. Without a file it reads the bet straight from NEAR. Add --network testnet for testnet bets.",
      command: "node verify-bet.mjs <bet id> praetorial-bet-<bet id>-verification.json",
      scriptHref: "/verify-bet.mjs",
    },
  },
  {
    id: "fees",
    title: "Fees",
    paragraphs: [
      "1% of each side's stake, with a minimum fee per side for each token (below). It is only charged when a bet ends with a winner, including a concede. Cancelled, expired and void bets pay no fee.",
      "Each side also pays a small one-time storage charge for keeping the bet on NEAR. If you choose a person to decide, you can tip them the same amount as the fee.",
    ],
  },
  {
    id: "know",
    title: "Good to know",
    bullets: [
      { title: "Real money", text: "Bets use real tokens on NEAR mainnet. Only bet what you can afford to lose." },
      { title: "Beta", text: "Praetorial is new and in beta. The site is unlisted: it is not advertised or listed anywhere yet." },
      { title: "Your funds stay in NEAR Intents", text: `Your betting balance is held in your own account on NEAR Intents (${INTENTS_CONTRACT_ID}), not by us. A bet's stakes sit in the escrow contract until the bet ends.` },
      { title: "Pauses and emergencies", text: "We can stop new offers. That never blocks payouts, refunds or cancels. In an emergency the escrow can be shut down for good, and then any bet whose ruling isn't final yet can be refunded: each side gets their own deposit back." },
      { title: "Settings for new bets", text: "The fee and stake limits for new bets can change, only after a 24 hour public notice. A bet keeps the terms it was opened with." },
      { title: "Risks", text: "Software can have bugs. An AI judge can be wrong (that's what the challenge window is for). A source page can change or go offline. Token prices move while your money is in a bet." },
    ],
  },
];
