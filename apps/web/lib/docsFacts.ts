// DOCS1: the facts and command blocks the Docs pages print. Account ids come from the network table (lib/network.ts); the escrow
// release (outside apps/web) is a literal a unit test compares with release/mainnet-night/release-mainnet.json; public NEAR doc
// addresses are lib/docsPublic.json. Every command block (by id) has an entry in spikes/docs1/CLAIMS.md or (DOCS2) spikes/docs2/CLAIMS.md
// (tests/docs1.unit.test.ts), and each was run by hand on 12 Nov 2026 (spikes/docs1/REPORT.md, spikes/docs2/REPORT.md).
import { NETWORKS, type NetworkConfig } from "./network";
import type { NetworkId } from "./networkSelect";
import PUBLIC from "./docsPublic.json" with { type: "json" };
import { LAUNCH_JUDGE_CHAIN } from "./about";
import { TX } from "./mainnetEvidence";
import ACCOUNTS from "./mainnetAccounts.json" with { type: "json" };

export const MAINNET: NetworkConfig = NETWORKS.mainnet;
/** The testnet table is dropped from a mainnet bundle (lib/network.ts MAINPREP); then the Docs simply don't link the testnet escrow. */
export const TESTNET: NetworkConfig | null = (NETWORKS as Partial<Record<NetworkId, NetworkConfig>>)["testnet"] ?? null;

/** The mainnet escrow release (release/mainnet-night/release-mainnet.json escrow_wasm_sha256 / escrow_code_hash_b58 / escrow_record;
 * the commit is that record's "commit"). Test-checked against those files. */
export const ESCROW_RELEASE = {
  sha256: "caf134a484bc68c2e6900bd03cba7b3eb29af40b67d65f61db1fe04831450f2f",
  codeHashB58: "EfCgMFheGBZpoFNrhDDozkGK43KL31W12dHUc2QWjQ7Q",
  record: "contracts/escrow/release/record-84f23c8.json",
  commit: "84f23c8",
} as const;

/** The resolver release (lib/release.mainnet.json release_record; the commit is that record's "commit"). Test-checked. */
export const RESOLVER_RELEASE = { record: "resolver/release/record-f5695b9.json", commit: "f5695b9" } as const;

export const NEARBLOCKS: Record<NetworkId, (account: string) => string> = {
  mainnet: (account) => `https://nearblocks.io/address/${account}`,
  testnet: (account) => `https://testnet.nearblocks.io/address/${account}`,
};
export const explorer = (network: NetworkId, account: string): string => NEARBLOCKS[network](account);

export const NEAR_AI_GUIDE: string = PUBLIC.nearAiVerificationGuide;
export const NEAR_INTENTS_DOCS: string = PUBLIC.nearIntentsDocs;

/** The external origins the Docs may link to; the in-docs link test allows exactly these. */
export const EXTERNAL_ORIGINS: readonly string[] = PUBLIC.externalOrigins;

export interface DocsCommand { id: string; text: string }

const ESCROW = MAINNET.escrow;
const pickJson = (expr: string) => `node -pe '${expr}'`;

/** One shell helper the Trust page defines once, then uses for every contract read: `view <method> ['<json args>']`.
 * Public RPC, read-only, no keys. Tested in bash and zsh. */
const VIEW_FN = `view() { curl -s ${MAINNET.rpcUrl} -H 'content-type: application/json' -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"query\\",\\"params\\":{\\"request_type\\":\\"call_function\\",\\"finality\\":\\"final\\",\\"account_id\\":\\"${ESCROW}\\",\\"method_name\\":\\"$1\\",\\"args_base64\\":\\"$(printf '%s' "\${2:-{\\}}" | base64)\\"}}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.result).toString()))'; }`;

const rpc = (requestType: string) =>
  `curl -s ${MAINNET.rpcUrl} -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"${requestType}","finality":"final","account_id":"${ESCROW}"}}'`;

const FIRST_MODEL = LAUNCH_JUDGE_CHAIN[0]!.model_a;

/** DOCS2: the four mainnet report-pubkey runs of the pinned judge program (2 as the escrow, 2 as the attest signer; before and
 * after deploy). The command reads each one's request (which program) and result (which keys) from an archival node. */
const E4_RUNS: [string, string][] = [
  [TX.outcomeKeyRun.hash, MAINNET.escrow], [TX.outcomeKeyCheck.hash, MAINNET.escrow],
  [TX.attestKeyRun.hash, ACCOUNTS.attestSigner], [TX.attestKeyCheck.hash, ACCOUNTS.attestSigner],
];
const E4_ONCHAIN = `for t in ${E4_RUNS.map(([h, a]) => `${h}:${a}`).join(" ")}; do curl -s ${PUBLIC.mainnetArchivalRpc} -H 'content-type: application/json' -d "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"method\\":\\"tx\\",\\"params\\":{\\"tx_hash\\":\\"\${t%%:*}\\",\\"sender_account_id\\":\\"\${t##*:}\\",\\"wait_until\\":\\"NONE\\"}}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;const w=JSON.parse(Buffer.from(r.transaction.actions[0].FunctionCall.args,"base64")).source.WasmUrl.hash;for(const x of r.receipts_outcome){const v=x.outcome.status.SuccessValue;const o=v&&JSON.parse(Buffer.from(v,"base64").toString()||"null");if(o&&o.mode==="report-pubkey")console.log("program",w,"run as",o.predecessor,"ruling key",o.public_key,"attest key",o.attest_public_key)}})'; done`;

export const DOCS_COMMANDS: readonly DocsCommand[] = [
  { id: "view-helper", text: VIEW_FN },
  // Trust step 1: the contract
  { id: "escrow-code-hash", text: rpc("view_account") },
  { id: "escrow-keys", text: rpc("view_access_key_list") },
  { id: "escrow-build", text: `contracts/escrow/release/build_reproducible.sh ${ESCROW_RELEASE.commit} run ~/escrow-build` },
  { id: "verify-escrow", text: `services/verifier/verify-escrow --network mainnet --escrow ${ESCROW} --expect-escrow-hash ${ESCROW_RELEASE.sha256} --offline` },
  // Trust step 2: terms
  { id: "get-bet", text: `view get_bet '{"bet_id":1}'` },
  // Trust step 3: the program
  { id: "resolver-keys", text: "view resolver_keys" },
  { id: "outlayer-config", text: "view outlayer_config" },
  { id: "wasm-download", text: `curl -s "$(view outlayer_config | ${pickJson('JSON.parse(require("fs").readFileSync(0)).wasm_base_url')})/$(view resolver_keys | ${pickJson('JSON.parse(require("fs").readFileSync(0))[2]')}).wasm" | shasum -a 256` },
  // Trust step 4 (DOCS2): the key-binding runs, read from the chain
  { id: "e4-onchain", text: E4_ONCHAIN },
  { id: "resolver-build", text: `resolver/release/build_reproducible.sh ${RESOLVER_RELEASE.commit} run ~/resolver-build` },
  // Trust step 6: models
  { id: "judge-chain", text: "view judge_chain" },
  { id: "nearai-attestation", text: `curl -s '${PUBLIC.nearAiAttestationReport}?model=${FIRST_MODEL}' > report.json` },
  // Trust: the checkers
  { id: "verify-bet-mjs", text: "node scripts/verify-bet.mjs 1" },
  { id: "services-install", text: "cd services && npm ci && cd .." },
  { id: "verify-bet-full", text: `services/verifier/verify-bet --network mainnet --escrow ${ESCROW} --bet 1 --expect-escrow-hash ${ESCROW_RELEASE.sha256} --offline` },
  // Hackathon: run it locally
  { id: "web-install", text: "cd apps/web && npm ci" },
  { id: "web-dev", text: "npm run dev" },
  { id: "web-unit", text: "npm test" },
  { id: "web-e2e-docs", text: "npx playwright install chromium && PW_CI=1 PLAYWRIGHT_BASE_URL=http://localhost:3456 npx playwright test tests/docs1.spec.ts" },
  { id: "test-fast", text: "./test.sh fast" },
];

export function docsCommand(id: string): DocsCommand {
  const c = DOCS_COMMANDS.find((x) => x.id === id);
  if (!c) throw new Error(`unknown docs command ${id}`);
  return c;
}

/** DOCSREV: ALL the guardian's powers over the locked escrow (every method gated on `self.guardian` in contracts/escrow/src/lib.rs;
 * tests/docsrev.unit.test.ts reads the contract and fails if one is missing). One sentence, used by every page that lists them. */
export const GUARDIAN_POWERS =
  "pause and resume new offers; after a 24 hour public notice, change the fee and stake limits for new bets or add a token; close a token to new bets at once; " +
  "after a 7 day public notice, add a backup model pair at the end of the judge list (it judges, also existing bets, only once every pair before it has a retired model); " +
  "hand the guardian role to another account, which must accept it; or shut the escrow down for good";

/** DOCSREV: the operator's one power (`reclaim`, the only method gated on `self.operator`). */
export const OPERATOR_POWERS = "can close an offer nobody has taken yet; the maker gets the full stake back";

/** Placeholders familiarcow fills in (listed in spikes/docs1/CLAIMS.md "TODOs for familiarcow"). Shown on the page as-is, never invented. */
export const TODO = {
  repoUrl: "TODO(familiarcow): public repository URL",
  team: "TODO(familiarcow): team",
  demoUrl: "TODO(familiarcow): demo post on X and the demo site address",
} as const;
