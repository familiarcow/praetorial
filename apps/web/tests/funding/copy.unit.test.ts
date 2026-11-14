// F2: lib/funding/types.ts + copy.ts (the day-1 contract for F3/F4/F5).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BET_SYMBOLS, TERMINAL_STATES } from "../../lib/funding/types";
import { COPY, BANNED_WORDS } from "../../lib/funding/copy";
import { findAsset } from "../../lib/assets";

const ARGS = JSON.parse(readFileSync(new URL("../../../../release/mainnet-night/args.mainnet.json", import.meta.url), "utf8"));

test("BET_SYMBOLS are exactly the 6 whitelisted tokens of the live mainnet escrow, in D-ASSET1 order", () => {
  assert.deepEqual([...BET_SYMBOLS], ["USDC", "USDT", "NEAR", "BTC", "ETH", "ZEC"]);
  const argIds = (ARGS.asset_limits as [string, unknown][]).map(([id]) => id).sort();
  const ours = BET_SYMBOLS.map((s) => findAsset(s)!.ids.mainnet!).sort();
  assert.deepEqual(ours, argIds);
});

test("terminal states are credited / refunded / failed / expired (checking is never terminal)", () => {
  assert.deepEqual([...TERMINAL_STATES].sort(), ["credited", "expired", "failed", "refunded"]);
});

/** Every string the COPY table can produce, with sample arguments. */
function allStrings(node: unknown, path = "COPY"): { path: string; text: string }[] {
  if (typeof node === "string") return [{ path, text: node }];
  if (typeof node === "function") {
    const args = Array.from({ length: node.length }, (_, i) => (i === 0 && /inFlight|rowInBets|all/.test(path) ? 2 : `X${i}`));
    const out = path.endsWith("helpText") ? node({ depositAddress: "A", memo: "M", correlationId: "C", time: "T" }) : node(...args);
    return [{ path, text: String(out) }];
  }
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => allStrings(v, `${path}.${k}`));
  return [];
}

test("no user string says intents / 1Click / POA / omft / solver / bridge / quote / withdraw (no exceptions: ACCT2 removed near.com)", () => {
  const strings = allStrings(COPY);
  assert.ok(strings.length > 100, `walked ${strings.length} strings`);
  for (const { path, text } of strings) {
    for (const w of BANNED_WORDS) assert.ok(!text.toLowerCase().includes(w), `${path} contains "${w}": ${text}`);
  }
});

test("familiarcow's renames: Account / Add money / Cash out, and no permanent-address wording", () => {
  assert.equal(COPY.account.title, "Account");
  assert.equal(COPY.add.title, "Add money");
  assert.equal(COPY.cashOut.title, "Cash out");
  assert.equal(COPY.cashOut.cta, "Cash out");
  const all = allStrings(COPY).map((s) => s.text.toLowerCase());
  assert.ok(!all.some((t) => t.includes("permanent")), "no permanent deposit address anywhere");
  assert.ok(!all.some((t) => /\bwallet\b/.test(t) && t.startsWith("wallet")), "no screen called Wallet");
});

test("no string shows a $ amount except the approximate total", () => {
  for (const { path, text } of allStrings(COPY)) {
    if (path === "COPY.account.totalApprox") continue;
    assert.ok(!text.includes("$"), `${path}: ${text}`);
  }
  assert.equal(COPY.account.totalApprox("143.20"), "≈ $143.20");
});

test("plural and in-flight wording", () => {
  assert.equal(COPY.account.rowInBets("0.0002 BTC", 1), "In bets: 0.0002 BTC (1 bet)");
  assert.equal(COPY.account.rowInBets("25.00 USDC", 3), "In bets: 25.00 USDC (3 bets)");
  assert.equal(COPY.account.inFlight(1, true), "1 deposit in progress");
  assert.equal(COPY.account.inFlight(2, true), "2 deposits in progress");
  assert.equal(COPY.account.inFlight(2, false), "2 transfers in progress");
});

test("snapshots of the key tracker and address lines", () => {
  assert.equal(COPY.add.addressTitle("USDT", "Tron"), "Send USDT on Tron");
  assert.equal(COPY.add.band("19.80 USDT", "20.00 USDT"), "Send between 19.80 USDT and 20.00 USDT. More is fine; it's converted too.");
  assert.equal(COPY.add.exchange("Tron (TRC-20)"), 'Sending from an exchange? Pick the "Tron (TRC-20)" network there.');
  assert.equal(COPY.track.short("15.00 USDT", "19.80 USDT", "4.80 USDT", "12:39"),
    "We got 15.00 USDT, but this address needs at least 19.80 USDT. Send 4.80 USDT more before 12:39 to the same address, or we'll return the 15.00 USDT to your account.");
  assert.equal(COPY.track.credited("19.97 USDC"), "19.97 USDC added to your betting balance.");
  assert.equal(COPY.track.refundedBetting("0.001 BTC"), "We couldn't convert it, so we returned 0.001 BTC to your betting balance.");
  assert.equal(COPY.track.helpText({ depositAddress: "TQx", memo: null, correlationId: "c-1", time: "12:00 UTC" }), "Deposit address: TQx\nReference: c-1\nTime: 12:00 UTC");
  assert.equal(COPY.cashOut.sent("19.80 USDT", "T9yD…uWwb"), "Sent: 19.80 USDT is on its way to T9yD…uWwb.");
});

// ACCT2 (familiarcow 11-13, mainnet): no "From near.com" path. Too much room to lose money (an account-ID send can land in near.com's
// Confidential balance). near.com users fund like everyone else: Add money -> token -> network, paste the one-time address.
test("ACCT2: no near.com tab, account-ID send or Confidential-balance copy; the 'Only <token> on <network>' warning stays", () => {
  assert.equal((COPY as Record<string, unknown>).nearCom, undefined);
  assert.equal((COPY.add as Record<string, unknown>).tabNearCom, undefined);
  for (const { path, text } of allStrings(COPY)) {
    assert.ok(!/near\.com/i.test(text), `${path} names near.com: ${text}`);
    assert.ok(!/confidential/i.test(text), `${path} names the Confidential balance: ${text}`);
    assert.ok(!/send (it )?to your account id/i.test(text), `${path} offers an account-ID send: ${text}`);
  }
  assert.equal(COPY.add.onlyThis("USDC", "NEAR"), "Only USDC on NEAR. Other tokens or networks are lost.");
});

test("ACCT2: lib/funding/nearcom.ts is gone and no app source or Docs text mentions near.com (fastnear.com RPC hosts aside)", async () => {
  const { existsSync, readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = new URL("../../", import.meta.url).pathname;
  assert.equal(existsSync(join(root, "lib/funding/nearcom.ts")), false);
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
  const files = [...walk(join(root, "src")), ...walk(join(root, "lib"))].filter((f) => /\.(tsx?|json|md|css)$/.test(f));
  assert.ok(files.length > 50, `walked ${files.length} files`);
  for (const f of files) {
    // Comment lines may say why the path was removed; code, copy, JSON and CSS may not mention it.
    const text = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n").replace(/[a-z0-9.-]*fastnear\.com/gi, "");
    assert.ok(!/(^|[^a-z0-9])near\.com/i.test(text), `${f} mentions near.com`);
    assert.ok(!/nearcom/i.test(text), `${f} mentions nearcom`);
  }
});
