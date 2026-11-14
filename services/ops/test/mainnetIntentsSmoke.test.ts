// INTENTS1: scripts/mainnet-intents-smoke.sh -- the ~$5 real intents.near round trip familiarcow signs. Dry-run (default) must
// print the exact transactions, built in the shapes the web uses and real intents.near accepts
// (fixtures/intents_near/real_abi.json); --live must refuse unless MAINNET_SMOKE_OK=yes AND a signer is given. These
// tests never run --live past its guards and never touch the network (--offline).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/mainnet-intents-smoke.sh");
const run = (args: string[], env: Record<string, string> = {}) => {
  const r = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env } });
  return { code: r.status, out: r.stdout + r.stderr };
};
/** the JSON transactions printed between the TX markers */
const txs = (out: string) => [...out.matchAll(/^--- TX (\d) [^\n]*\n([\s\S]*?)\n--- END TX/gm)].map((m) => JSON.parse(m[2]));

test("dry-run (default) prints the four exact transactions, real intents.near shapes, and signs nothing", () => {
  const r = run(["--signer", "familiarcow.near", "--offline"]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /DRY RUN/);
  const t = txs(r.out);
  assert.equal(t.length, 4, r.out);
  const fc = (x: any) => x.actions[0].FunctionCall;
  // 1. wrap 1.5 NEAR
  assert.equal(t[0].signer_id, "familiarcow.near");
  assert.equal(t[0].receiver_id, "wrap.near");
  assert.deepEqual(fc(t[0]), { method_name: "near_deposit", args: {}, gas: "30000000000000", deposit: "1500000000000000000000000" });
  // 2. deposit into intents.near: amount = wNEAR received (offline assumes the first-deposit storage fee 0.00125 NEAR is taken)
  assert.equal(t[1].receiver_id, "wrap.near");
  assert.deepEqual(fc(t[1]), {
    method_name: "ft_transfer_call",
    args: { receiver_id: "intents.near", amount: "1498750000000000000000000", msg: JSON.stringify({ receiver_id: "familiarcow.near" }) },
    gas: "100000000000000", deposit: "1",
  });
  // 3. ft_withdraw back: bare token id, to the signer, 1 yocto
  assert.equal(t[2].receiver_id, "intents.near");
  assert.deepEqual(fc(t[2]), { method_name: "ft_withdraw", args: { token: "wrap.near", receiver_id: "familiarcow.near", amount: "1498750000000000000000000" }, gas: "100000000000000", deposit: "1" });
  // 4. unwrap
  assert.deepEqual(fc(t[3]), { method_name: "near_withdraw", args: { amount: "1498750000000000000000000" }, gas: "30000000000000", deposit: "1" });
  // the balance check between 2 and 3 is a free view call in the real form
  assert.match(r.out, /mt_balance_of \{"account_id":"familiarcow\.near","token_id":"nep141:wrap\.near"\}/);
  assert.doesNotMatch(r.out, /^\+ /m, "dry-run must not invoke the NEAR CLI");
  assert.doesNotMatch(r.out, /call-function as-transaction/);
});

test("--amount-near sets the wrap amount; anything above the ~$5 smoke cap is refused", () => {
  const ok = run(["--signer", "familiarcow.near", "--offline", "--amount-near", "1.25"]);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(txs(ok.out)[0].actions[0].FunctionCall.deposit, "1250000000000000000000000");
  const big = run(["--signer", "familiarcow.near", "--offline", "--amount-near", "50"]);
  assert.notEqual(big.code, 0);
  assert.match(big.out, /cap/i);
});

test("--live refuses without MAINNET_SMOKE_OK=yes", () => {
  const r = run(["--live", "--signer", "familiarcow.near"]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /MAINNET_SMOKE_OK=yes/);
});

test("--live refuses without a signer even when MAINNET_SMOKE_OK=yes", () => {
  const r = run(["--live"], { MAINNET_SMOKE_OK: "yes" });
  assert.notEqual(r.code, 0);
  assert.match(r.out, /--signer/);
});

test("--live refuses MAINNET_SMOKE_OK values other than exactly yes", () => {
  for (const v of ["YES", "1", "true", "y"]) {
    const r = run(["--live", "--signer", "familiarcow.near"], { MAINNET_SMOKE_OK: v });
    assert.notEqual(r.code, 0, v);
  }
});
