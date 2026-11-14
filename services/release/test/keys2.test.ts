// KEYS2 (D-KEYS2 / D-KEYS2a / D-KEYS2b): escrow.praetorial.near, fee.praetorial.near and secrets.praetorial.near are lost
// (their keys were never kept). Tonight's mainnet uses bets.praetorial.near (escrow contract), praetorial.near (fee_account =
// owner = guardian) and aikey.praetorial.near (OutLayer secrets owner, GATE-09). These tests pin every mainnet config, script
// and the RUNBOOK to the new names, and the RUNBOOK to the bot-run, key-file-signed order of D-KEYS2b.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rd = (p: string) => readFileSync(join(ROOT, p), "utf8");
const json = (p: string) => JSON.parse(rd(p));
const LOST = /\b(escrow|fee|secrets)\.praetorial\.near\b/;
const ESCROW = "bets.praetorial.near";
const FEE = "praetorial.near";
const AIKEY = "aikey.praetorial.near";
const BETS_PK = "ed25519:3BiLqo5QjYkcTL1TnHDdT8ch7xJjGWwbGzUEZAK4HWYh";
const AIKEY_PK = "ed25519:HKGkCQhpoStBPuG7CHfzLvH2XmuQe7d53SkUQux5MtLc";
const TEMP_PK = "ed25519:6eWbyxb82R32qxqmPmRM553u49YDZDHubwsmmavpYfuf";
const KEYS = "$PRAETORIAL_SECRETS_DIR/praetorial-mainnet-keys";
const SIX = ["keeper", "relayer", "monitor", "notifier", "indexer", "sourcecheck"];
const mainnetVars = (svc: string): Record<string, string> => {
  const t = rd(`services/workers/${svc}/wrangler.toml`);
  const m = /^\[env\.mainnet\.vars\]\s*$/m.exec(t);
  assert.ok(m, `${svc}: no [env.mainnet.vars]`);
  const body = t.slice(m.index + m[0].length).split(/\n\s*\[/)[0]!;
  return Object.fromEntries([...body.matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map((m) => [m[1]!, m[2]!]));
};
const mainnetSection = (svc: string) => rd(`services/workers/${svc}/wrangler.toml`).split(/^(?=\[)/m).filter((s) => /^\[\[?env\.mainnet/.test(s)).join("");

test("KEYS2: all six Worker [env.mainnet.vars] ESCROW_CONTRACT_ID = bets.praetorial.near", () => {
  for (const s of SIX) assert.equal(mainnetVars(s).ESCROW_CONTRACT_ID, ESCROW, s);
});
test("KEYS2: monitor [env.mainnet.vars] FEE_ACCOUNT_ID = praetorial.near", () => {
  assert.equal(mainnetVars("monitor").FEE_ACCOUNT_ID, FEE);
});
test("KEYS2: no Worker [env.mainnet] section names a lost account", () => {
  for (const s of [...SIX, "registry"]) assert.doesNotMatch(mainnetSection(s), LOST, s);
});
test("KEYS2 (D-RLY1a): mainnet relayer RELAYER_GLOBAL_DAILY_BUDGET_YOCTO = 1.4 NEAR", () => {
  assert.equal(mainnetVars("relayer").RELAYER_GLOBAL_DAILY_BUDGET_YOCTO, "1400000000000000000000000");
});

test("KEYS2: web mainnet profile escrow + mainnet release fee_account + deploy guard", () => {
  assert.match(rd("apps/web/lib/network.ts"), /escrow:\s*"bets\.praetorial\.near"/);
  assert.equal(json("apps/web/lib/release.mainnet.json").fee_account, FEE);
  assert.match(rd("apps/web/scripts/mainnetDeployGuard.ts"), /REQUIRED_MAINNET_IDS = \["bets\.praetorial\.near"/);
});

for (const f of ["release/draft-args.mainnet.json", "release/mainnet-night/dryrun/args.mainnet.json"]) {
  test(`KEYS2: ${f}: fee_account = guardian = praetorial.near, secrets_account_id = aikey.praetorial.near`, () => {
    const a = json(f);
    assert.equal(a.fee_account, FEE);
    assert.equal(a.guardian, FEE);
    assert.equal(a.outlayer_config.secrets_account_id, AIKEY);
  });
}
for (const f of ["release/draft-input.mainnet.json", "release/mainnet-night/dryrun/input.priced.json"]) {
  test(`KEYS2: ${f}: fee_account praetorial.near, secrets owner aikey., escrow note bets.`, () => {
    const a = json(f);
    assert.equal(a.fee_account, FEE);
    assert.equal(a.outlayer_config.secrets_account_id, AIKEY);
    assert.match(JSON.stringify(a), /bets\.praetorial\.near/);
  });
}
test("KEYS2: release-mainnet.json mainnet_escrow.account = bets.praetorial.near", () => {
  assert.equal(json("release/mainnet-night/release-mainnet.json").mainnet_escrow.account, ESCROW);
});

const LIVE_FILES = [
  "apps/web/lib/network.ts", "apps/web/lib/release.mainnet.json", "apps/web/scripts/mainnetDeployGuard.ts",
  "release/draft-args.mainnet.json", "release/draft-input.mainnet.json", "release/mainnet-night/release-mainnet.json",
  "release/mainnet-night/dryrun/args.mainnet.json", "release/mainnet-night/dryrun/input.priced.json",
  "services/workers/scripts/deploy-mainnet.sh", "services/workers/README.md",
  ...readdirSync(join(ROOT, "scripts/mainnet-night")).map((f) => `scripts/mainnet-night/${f}`),
  ...SIX.map((s) => `services/workers/${s}/wrangler.toml`),
];
test("KEYS2: no live mainnet config/script names escrow./fee./secrets.praetorial.near", () => {
  for (const f of LIVE_FILES) assert.doesNotMatch(rd(f), LOST, f);
});

test("KEYS2: 00-accounts.sh lists bets. and aikey., not the lost accounts", () => {
  const s = rd("scripts/mainnet-night/00-accounts.sh");
  assert.match(s, /bets\.praetorial\.near/);
  assert.match(s, /aikey\.praetorial\.near/);
  assert.doesNotMatch(s, LOST);
});
test("KEYS2: 05-olhome.sh builds homes for bets and aikey (bot-held, D-KEYS2a)", () => {
  const s = rd("scripts/mainnet-night/05-olhome.sh");
  assert.match(s, /ops\|attest\|bets\|aikey\)/);
});
test("KEYS2: script defaults: 40-bind-secret owner aikey., escrow bets.; views/fill/keeper/deploy default to bets.", () => {
  const b = rd("scripts/mainnet-night/40-bind-secret.sh");
  assert.match(b, /OWNER=\$\{OWNER:-aikey\.praetorial\.near\}/);
  assert.match(b, /ESC=\$\{ESC:-bets\.praetorial\.near\}/);
  assert.match(rd("scripts/mainnet-night/30-views.sh"), /\$\{2:-bets\.praetorial\.near\}/);
  assert.match(rd("scripts/mainnet-night/20-fill-outlayer.sh"), /\$\{ESCROW:-bets\.praetorial\.near\}/);
  assert.match(rd("scripts/mainnet-night/50-keeper-credit.mjs"), /\?\? "bets\.praetorial\.near"/);
  assert.match(rd("services/workers/scripts/deploy-mainnet.sh"), /ESCROW=\$\{ESCROW:-bets\.praetorial\.near\}/);
});

// ---- RUNBOOK (D-KEYS2 rule, D-KEYS2a bot-held bets./aikey., D-KEYS2b bot runs everything with the temp owner key)
const RB = rd("release/mainnet-night/RUNBOOK.md");
const GAPS = rd("release/mainnet-night/GAPS.md");
test("KEYS2: RUNBOOK and GAPS never use autogenerate-new-keypair and never name a lost account outside the history note", () => {
  assert.doesNotMatch(RB, /autogenerate-new-keypair/);
  const live = RB.split("<!-- KEYS2-HISTORY -->")[0]!;
  assert.doesNotMatch(live, LOST);
  assert.doesNotMatch(GAPS.split("<!-- KEYS2-HISTORY -->")[0]!, LOST);
});
test("KEYS2: RUNBOOK create commands: bets. 6 NEAR + aikey. 0.3 NEAR, manually provided keys, signed by the temp owner key file", () => {
  const owner = `sign-with-access-key-file ${KEYS}/owner-temp/praetorial.near-temp.json send`;
  assert.ok(RB.includes(`near account create-account fund-myself ${ESCROW} '6 NEAR' use-manually-provided-public-key ${BETS_PK} sign-as praetorial.near network-config mainnet ${owner}`));
  assert.ok(RB.includes(`near account create-account fund-myself ${AIKEY} '0.3 NEAR' use-manually-provided-public-key ${AIKEY_PK} sign-as praetorial.near network-config mainnet ${owner}`));
});
test("KEYS2: RUNBOOK: deploy+new and delete of bets.'s key are signed with the bets key file, gated by PRAETORIAL_MAINNET_GO=GO", () => {
  const bets = `sign-with-access-key-file ${KEYS}/bets/bets.praetorial.near.json send`;
  assert.ok(RB.includes(`near contract deploy ${ESCROW} use-file`) && RB.includes(`with-init-call new file-args`));
  assert.ok(RB.includes(`near account delete-keys ${ESCROW} public-keys ${BETS_PK} network-config mainnet ${bets}`));
  assert.match(RB, /\[ "\$PRAETORIAL_MAINNET_GO" = GO \]/);
});
test("KEYS2: RUNBOOK: bets./aikey. OutLayer homes come from 05-olhome.sh; verifier uses the bets home", () => {
  assert.match(RB, /05-olhome\.sh bets/);
  assert.match(RB, /05-olhome\.sh aikey/);
  assert.match(RB, /--outlayer-home-escrow \$W\/olhome-bets/);
  assert.match(RB, /OUTLAYER_HOME=\$W\/olhome-aikey PRAETORIAL_MAINNET_GO=GO bash scripts\/mainnet-night\/40-bind-secret\.sh/);
});
test("KEYS2 (D-KEYS2b): RUNBOOK ends with familiarcow deleting the temp key (his phrase at the prompt) and the bot deleting key files", () => {
  const familiarcow = `near account delete-keys praetorial.near public-keys ${TEMP_PK} network-config mainnet sign-with-seed-phrase`;
  const i = RB.indexOf(familiarcow);
  assert.ok(i > 0, "familiarcow's delete-key command for the temp key");
  assert.ok(RB.indexOf(`rm -rf ${KEYS}/owner-temp`) > i, "owner-temp key file deleted after");
  assert.ok(RB.indexOf(`rm -rf ${KEYS}/bets`) > RB.indexOf(`near account delete-keys ${ESCROW}`), "bets key file deleted after the on-chain delete");
  assert.ok(RB.indexOf("rm -rf $W/olhome-bets") > RB.indexOf(`near account delete-keys ${ESCROW}`), "bets OutLayer home deleted after the on-chain delete");
});
test("KEYS2: RUNBOOK: every bot near-cli tx line signs from a key file (no seed phrase) except familiarcow's temp-key delete", () => {
  const live = RB.split("<!-- KEYS2-HISTORY -->")[0]!;
  const txLines = live.split("\n").filter((l) => /^\s*near (account|contract|tokens) /.test(l) || /&& near (account|contract|tokens) /.test(l));
  assert.ok(txLines.length >= 6, `found ${txLines.length} near-cli lines`);
  for (const l of txLines) {
    // familiarcow's only lines (D-KEYS2b): add / delete the temporary bot key on praetorial.near, his phrase at the prompt.
    if (l.includes(TEMP_PK) && /^near account (add-key|delete-keys) praetorial\.near /.test(l)) { assert.match(l, /sign-with-seed-phrase$/); continue; }
    assert.doesNotMatch(l, /sign-with-seed-phrase|sign-with-plaintext-private-key/, l);
    if (/view-account-summary|list-keys/.test(l)) continue;
    assert.match(l, /sign-with-access-key-file \$PRAETORIAL_SECRETS_DIR\/praetorial-mainnet-keys\/(owner-temp|bets)\/[a-z.-]+\.json send/, l);
  }
});
test("KEYS2: every key-file near-cli line in the RUNBOOK is run verbatim by 15-keyfile-steps.sh (except the GO-gated top-up)", () => {
  const sh = rd("scripts/mainnet-night/15-keyfile-steps.sh");
  const live = RB.split("<!-- KEYS2-HISTORY -->")[0]!;
  const lines = live.split("\n").filter((l) => /^near (account|contract) .*sign-with-access-key-file/.test(l));
  assert.equal(lines.length, 4, "create bets, create aikey, deploy, delete bets key");
  for (const l of lines) assert.ok(sh.includes(`  ${l} || die`), l);
});
