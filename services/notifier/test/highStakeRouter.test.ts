// RED-first: route high-stakes (>= $500 USD-equivalent per side)
// bet events to Telegram, in addition to the existing channel. Price
// table is injected (no live price call, no invented prices). Uses
// the real ContactStore (same encryption/deletion rules as every
// other contact) with a mocked TelegramChannel.send.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sideUsdValue,
  highStakeAccounts,
  routeHighStakeToTelegram,
  buildTelegramMessage,
  noticesToHighStakeEvents,
  type AssetPriceTable,
  type HighStakeEvent,
} from "../src/highStakeRouter.js";
import { ContactStore } from "../src/contactStore.js";
import type { TelegramChannel } from "../src/telegram.js";
import type { Notice } from "../src/notifier.js";
import type { Bet } from "@praetorial/common/types.js";

const KEY = "c".repeat(64);

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "notifier-highstake-test-"));
  return join(dir, "contacts.sqlite3");
}

const TABLE: AssetPriceTable = {
  "usdc.fakes.testnet": { decimals: 6, usdPerToken: 1 },
  "wrap.testnet": { decimals: 24, usdPerToken: 3 }, // wNEAR, cross-asset case
};

function usdcAmount(usd: number): string {
  return String(Math.round(usd * 10 ** 6));
}
function nearAmount(usdValue: number): string {
  // usdPerToken = 3 for wrap.testnet
  const tokens = usdValue / 3;
  return BigInt(Math.round(tokens * 10 ** 24)).toString();
}
function btcAmount(usdValue: number): string {
  // usdPerToken = 60000 for btc.bridge.testnet, 8 decimals
  const tokens = usdValue / 60000;
  return BigInt(Math.round(tokens * 10 ** 8)).toString();
}

const TABLE_WITH_BTC: AssetPriceTable = {
  ...TABLE,
  "btc.bridge.testnet": { decimals: 8, usdPerToken: 60000 },
};

function mockChannel(sendImpl: (chatId: string, text: string) => Promise<boolean>): TelegramChannel {
  return { send: sendImpl } as unknown as TelegramChannel;
}

test("sideUsdValue converts native units to USD using the asset's own decimals", () => {
  const usd = sideUsdValue({ account: "a.testnet", amount: usdcAmount(500), assetId: "usdc.fakes.testnet" }, TABLE);
  assert.equal(usd, 500);
  const near = sideUsdValue({ account: "b.testnet", amount: nearAmount(600), assetId: "wrap.testnet" }, TABLE);
  assert.ok(Math.abs(near - 600) < 1e-6);
});

test("below $500 on both sides: not flagged high-stake", () => {
  const ev: HighStakeEvent = {
    bet_id: 1,
    event: "proposed",
    link: "https://example.test/bet/1",
    sides: [
      { account: "maker.testnet", amount: usdcAmount(499), assetId: "usdc.fakes.testnet" },
      { account: "taker.testnet", amount: usdcAmount(100), assetId: "usdc.fakes.testnet" },
    ],
  };
  assert.deepEqual(highStakeAccounts(ev, TABLE), []);
});

test("one side >= $500 is flagged even if the other side is small (cross-asset decimals respected)", () => {
  const ev: HighStakeEvent = {
    bet_id: 2,
    event: "proposed",
    link: "https://example.test/bet/2",
    sides: [
      { account: "maker.testnet", amount: usdcAmount(500), assetId: "usdc.fakes.testnet" },
      { account: "taker.testnet", amount: nearAmount(50), assetId: "wrap.testnet" },
    ],
  };
  assert.deepEqual(highStakeAccounts(ev, TABLE), ["maker.testnet"]);
});

test("end-to-end: above-threshold opted-in account is sent exactly once", async () => {
  const dbPath = tmpDbPath();
  const store = new ContactStore(dbPath, KEY);
  store.setContact("maker.testnet", "telegram", "111222333");
  let sendCount = 0;
  const sentArgs: Array<[string, string]> = [];
  const channel = mockChannel(async (chatId, text) => {
    sendCount++;
    sentArgs.push([chatId, text]);
    return true;
  });
  const ev: HighStakeEvent = {
    bet_id: 3,
    event: "settled",
    link: "https://example.test/bet/3",
    sides: [
      { account: "maker.testnet", amount: usdcAmount(1000), assetId: "usdc.fakes.testnet" },
      { account: "taker.testnet", amount: usdcAmount(1000), assetId: "usdc.fakes.testnet" },
    ],
  };
  await routeHighStakeToTelegram([ev], TABLE, store, channel);
  // Both sides are >= $500, but only maker.testnet has a stored
  // telegram contact -- taker.testnet (no contact at all) is skipped,
  // so exactly one send happens, exactly once (not retried/duplicated).
  assert.equal(sendCount, 1);
  assert.deepEqual(sentArgs, [["111222333", sentArgs[0][1]]]);
  for (const [, text] of sentArgs) {
    assert.ok(text.includes("3"));
    assert.ok(text.includes("https://example.test/bet/3"));
    assert.ok(!text.includes("maker.testnet") && !text.includes("taker.testnet"), "message must carry no account/PII");
  }
  store.close();
  rmSync(dbPath, { force: true });
});

test("below-threshold bet is never sent even if the account is opted in", async () => {
  const dbPath = tmpDbPath();
  const store = new ContactStore(dbPath, KEY);
  store.setContact("maker.testnet", "telegram", "111222333");
  let sendCount = 0;
  const channel = mockChannel(async () => {
    sendCount++;
    return true;
  });
  const ev: HighStakeEvent = {
    bet_id: 4,
    event: "proposed",
    link: "https://example.test/bet/4",
    sides: [{ account: "maker.testnet", amount: usdcAmount(10), assetId: "usdc.fakes.testnet" }],
  };
  await routeHighStakeToTelegram([ev], TABLE, store, channel);
  assert.equal(sendCount, 0);
  store.close();
  rmSync(dbPath, { force: true });
});

test("opted-out / deleted account is never sent to, even above threshold", async () => {
  const dbPath = tmpDbPath();
  const store = new ContactStore(dbPath, KEY);
  store.setContact("maker.testnet", "telegram", "111222333");
  store.deleteContact("maker.testnet");
  let sendCount = 0;
  const channel = mockChannel(async () => {
    sendCount++;
    return true;
  });
  const ev: HighStakeEvent = {
    bet_id: 5,
    event: "proposed",
    link: "https://example.test/bet/5",
    sides: [{ account: "maker.testnet", amount: usdcAmount(9999), assetId: "usdc.fakes.testnet" }],
  };
  await routeHighStakeToTelegram([ev], TABLE, store, channel);
  assert.equal(sendCount, 0);
  store.close();
  rmSync(dbPath, { force: true });
});

test("account with no contact at all is skipped, not an error", async () => {
  const dbPath = tmpDbPath();
  const store = new ContactStore(dbPath, KEY);
  let sendCount = 0;
  const channel = mockChannel(async () => {
    sendCount++;
    return true;
  });
  const ev: HighStakeEvent = {
    bet_id: 6,
    event: "proposed",
    link: "https://example.test/bet/6",
    sides: [{ account: "nobody.testnet", amount: usdcAmount(9999), assetId: "usdc.fakes.testnet" }],
  };
  await routeHighStakeToTelegram([ev], TABLE, store, channel);
  assert.equal(sendCount, 0);
  store.close();
  rmSync(dbPath, { force: true });
});

function minimalBet(overrides: Partial<Bet>): Bet {
  return {
    envelope: {
      bet_id: 1, version: 1, maker: "maker.testnet", taker_allow: { Any: {} },
      terms_hash: "x",
      models_snapshot_hash: "m", outcomes: ["YES", "NO"], maker_side: "YES",
      maker_asset: "usdc.fakes.testnet", taker_asset: "usdc.fakes.testnet",
      stake_maker: usdcAmount(1000), stake_taker: usdcAmount(10), fee_bps: 100,
      storage_charge_per_side: "1", keep_terms: true, max_paid_runs: 1,
      tier: 1, arbiter: null, funding_deadline: 100, early_settle_outcome: null,
      finality_delay: 0, settlement_period: 10, resolve_deadline: 1000, consent_party_controlled: false,
    },
    status: "Settled", taker: "taker.testnet", created_at: 0, taken_at: null, proposed_at: 0,
    outcome: "YES", used_run_nos: [], runs_used: 1, bonds: [],
    pre_challenge_outcome: null, challenged_by: null, exhibits: [], rebuttals: [],
    objection_deposits: [], arbiter_submissions: [], amend_count: 0,
    pending_resolution_request: null, last_resolution_raw: null, pruned: false,
    next_expected_run_no: 1, all_results: [], window_extended: false, window_extension_ns: "0",
    ...overrides,
  };
}

test("noticesToHighStakeEvents resolves each notice's bet to maker/taker sides, skipping unresolvable bets", () => {
  const notices: Notice[] = [
    { bet_id: 7, contract_id: "escrow.testnet", kind: "settled", to_accounts: ["maker.testnet", "taker.testnet"], detail: "", computed_at: "" },
    { bet_id: 999, contract_id: "escrow.testnet", kind: "settled", to_accounts: [], detail: "", computed_at: "" }, // no such bet
  ];
  const betsByContract = new Map<string, Map<number, Bet>>([["escrow.testnet", new Map([[7, minimalBet({})]])]]);
  const events = noticesToHighStakeEvents(notices, betsByContract, "https://example.test/bet");
  assert.equal(events.length, 1);
  assert.equal(events[0].bet_id, 7);
  assert.equal(events[0].link, "https://example.test/bet/7");
  assert.deepEqual(
    events[0].sides.map((s) => s.account).sort(),
    ["maker.testnet", "taker.testnet"],
  );
  // Same-asset bet (unchanged behavior): the maker's $1000 side clears
  // $500, the taker's $10 side does not.
  const makerSide = events[0].sides.find((s) => s.account === "maker.testnet");
  const takerSide = events[0].sides.find((s) => s.account === "taker.testnet");
  assert.equal(makerSide?.assetId, "usdc.fakes.testnet");
  assert.equal(takerSide?.assetId, "usdc.fakes.testnet");
  assert.deepEqual(highStakeAccounts(events[0], TABLE), ["maker.testnet"]);
});

test("cross-asset bet: BTC maker side >= $500 routes even though USDC taker side is < $500 (per-side own-asset valuation)", () => {
  const notices: Notice[] = [
    { bet_id: 8, contract_id: "escrow.testnet", kind: "proposed", to_accounts: [], detail: "", computed_at: "" },
  ];
  const bet = minimalBet({
    envelope: {
      ...minimalBet({}).envelope,
      maker_asset: "btc.bridge.testnet",
      taker_asset: "usdc.fakes.testnet",
      stake_maker: btcAmount(501), // maker stakes BTC worth >= $500 (501 avoids a float-rounding hair under 500 at the exact boundary)
      stake_taker: usdcAmount(100), // taker stakes USDC worth $100
    },
  });
  const betsByContract = new Map<string, Map<number, Bet>>([["escrow.testnet", new Map([[8, bet]])]]);
  const events = noticesToHighStakeEvents(notices, betsByContract, "https://example.test/bet");
  assert.equal(events.length, 1);
  const makerSide = events[0].sides.find((s) => s.account === "maker.testnet");
  const takerSide = events[0].sides.find((s) => s.account === "taker.testnet");
  // Each side must carry its OWN staked asset, read from the envelope --
  // never a single shared assetId applied to both sides.
  assert.equal(makerSide?.assetId, "btc.bridge.testnet");
  assert.equal(takerSide?.assetId, "usdc.fakes.testnet");
  assert.deepEqual(highStakeAccounts(events[0], TABLE_WITH_BTC), ["maker.testnet"]);
});

test("cross-asset bet (reverse): USDC maker side < $500 does not route while BTC taker side >= $500 does", () => {
  const notices: Notice[] = [
    { bet_id: 9, contract_id: "escrow.testnet", kind: "proposed", to_accounts: [], detail: "", computed_at: "" },
  ];
  const bet = minimalBet({
    envelope: {
      ...minimalBet({}).envelope,
      maker_asset: "usdc.fakes.testnet",
      taker_asset: "btc.bridge.testnet",
      stake_maker: usdcAmount(100),
      stake_taker: btcAmount(501),
    },
  });
  const betsByContract = new Map<string, Map<number, Bet>>([["escrow.testnet", new Map([[9, bet]])]]);
  const events = noticesToHighStakeEvents(notices, betsByContract, "https://example.test/bet");
  assert.deepEqual(highStakeAccounts(events[0], TABLE_WITH_BTC), ["taker.testnet"]);
});

test("unknown asset in the price table: that side is not routed and a warning is logged with no account/PII", () => {
  const notices: Notice[] = [
    { bet_id: 10, contract_id: "escrow.testnet", kind: "proposed", to_accounts: [], detail: "", computed_at: "" },
  ];
  const bet = minimalBet({
    envelope: {
      ...minimalBet({}).envelope,
      maker_asset: "some-unlisted-asset.testnet",
      taker_asset: "usdc.fakes.testnet",
      stake_maker: "999999999999", // huge raw amount, would clear $500 if priced
      stake_taker: usdcAmount(10),
    },
  });
  const betsByContract = new Map<string, Map<number, Bet>>([["escrow.testnet", new Map([[10, bet]])]]);
  const events = noticesToHighStakeEvents(notices, betsByContract, "https://example.test/bet");

  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  let accounts: string[];
  try {
    accounts = highStakeAccounts(events[0], TABLE); // TABLE has no entry for "some-unlisted-asset.testnet"
  } finally {
    console.warn = originalWarn;
  }
  // Not routed: the unpriced side never crashes the whole event and
  // never gets flagged high-stake just because its raw amount is large.
  assert.deepEqual(accounts, []);
  // Logged, but with no account id / PII in the message.
  assert.ok(warnings.length >= 1, "expected a warning to be logged for the unpriced asset");
  for (const w of warnings) {
    assert.ok(!w.includes("maker.testnet") && !w.includes("taker.testnet"), "warning must carry no account/PII");
  }
  assert.ok(warnings.some((w) => w.includes("some-unlisted-asset.testnet")), "warning should name the unpriced asset");
});

test("message contains bet id, event and link; buildTelegramMessage carries no personal data", () => {
  const ev: HighStakeEvent = {
    bet_id: 42,
    event: "challenge_window_closing",
    link: "https://example.test/bet/42",
    sides: [{ account: "someone.testnet", amount: usdcAmount(600), assetId: "usdc.fakes.testnet" }],
  };
  const text = buildTelegramMessage(ev);
  assert.ok(text.includes("42"));
  assert.ok(text.includes("challenge_window_closing"));
  assert.ok(text.includes("https://example.test/bet/42"));
  assert.ok(!text.includes("someone.testnet"));
});
