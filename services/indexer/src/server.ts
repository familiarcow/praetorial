// Tiny read-only HTTP API over the escrow contract's views. Caches a
// discovered bet map in memory, refreshed on a timer. No signing key;
// if this process is down, any client falls back to calling
// open_offers/get_bet directly (the explicit fallback this service
// exists to make faster, never to gatekeep).
import http from "node:http";
import { URL } from "node:url";
import { NearClient } from "@praetorial/common/nearClient.js";
import { loadServiceConfig } from "@praetorial/common/config.js";
import { type TaggedBet } from "@praetorial/common/discovery.js";
import { refreshBets, refreshGovernance } from "./refresh.js";
import type { GovernanceEvent } from "./governance.js";
import { fetchEscrowHistory } from "../../verifier/src/live.js";
import { buildOpenOffersBoardMulti, historyHttp, redactUnconfirmed } from "./board.js";
import { createSecondRpcClient } from "@praetorial/common/terminalConfirm.js";
import { ServiceAlertRaiser, alertForSingleRpc } from "../../monitor/src/serviceAlerts.js";
import { LogOnlyAlertChannel } from "../../monitor/src/alertChannel.js";
import { servedContracts, onlyServed } from "./served.js";

// IDX1: `served` (contract ids) limits EVERY read endpoint to those contracts; other cached rows are never served.
// Omitted = serve everything cached (tests / pre-IDX1 callers).
export function createServer(getAllBets: () => Map<string, TaggedBet>, getAllGovernance: () => Map<string, GovernanceEvent[]> = () => new Map(), served?: readonly string[]) {
  const getBets = served ? () => onlyServed(getAllBets(), served) : getAllBets;
  const getGovernance = served ? () => new Map([...getAllGovernance()].filter(([c]) => served.includes(c))) : getAllGovernance;
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/offers") {
      res.end(JSON.stringify(buildOpenOffersBoardMulti(getBets())));
      return;
    }
    if (url.pathname === "/history") {
      const h = historyHttp(getBets(), url.searchParams);
      res.statusCode = h.status;
      res.end(JSON.stringify(h.body));
      return;
    }
    if (url.pathname === "/bet") {
      const id = Number(url.searchParams.get("bet_id"));
      // D-UPGRADE1: optional contract_id disambiguates bet_id across
      // contract versions; defaults to the primary (first-configured)
      // contract for back-compat with pre-multi-contract callers.
      const contractId = url.searchParams.get("contract_id");
      const bets = getBets();
      let found: TaggedBet | null = null;
      for (const [, tb] of bets) {
        if (tb.betId !== id) continue;
        if (contractId && tb.contractId !== contractId) continue;
        found = tb;
        if (contractId) break;
      }
      res.end(JSON.stringify(found ? redactUnconfirmed(found) : null));
      return;
    }
    if (url.pathname === "/governance") {
      // JC1y: indexed governance events (judge chain, guardian, assets, amendments, model observations); ?contract_id= & ?kind= filter.
      const cid = url.searchParams.get("contract_id");
      const kind = url.searchParams.get("kind");
      const all = [...getGovernance()].filter(([c]) => !cid || c === cid).flatMap(([, v]) => v).filter((e) => !kind || e.kind === kind);
      res.end(JSON.stringify(all));
      return;
    }
    if (url.pathname === "/health") {
      res.end(JSON.stringify({ ok: true, bets_cached: getBets().size }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
}

export async function main(): Promise<void> {
  const cfg = loadServiceConfig();
  // Indexer needs no signing key (read-only); near-api-js still wants an
  // account context for view calls, so it uses the primary escrow
  // contract's own id as a harmless view-only caller (never signs
  // anything), regardless of how many contracts are configured.
  const client = new NearClient(cfg, { accountId: cfg.escrowContract, privateKey: "" });
  // view-only client: skip init() requiring a key; call RPC views directly.
  // D-DSY1: terminal outcomes need confirmation from rpcUrls[1]; with a single
  // RPC they stay "settling, confirming" and an alert is raised.
  const second = createSecondRpcClient(cfg);
  // IDX1: ingest and serve only ESCROW_CONTRACT_ID when it is set (the escrow the web uses).
  const contracts = servedContracts(cfg.escrowContracts, process.env.ESCROW_CONTRACT_ID);
  const raiser = new ServiceAlertRaiser(new LogOnlyAlertChannel((m) => console.error(m)));
  if (!second) {
    console.error("indexer: single RPC: terminal outcomes unconfirmed (configure a second RPC URL)");
    await raiser.raise([alertForSingleRpc()]);
  }
  let bets = new Map<string, TaggedBet>();
  let maxIds: Record<string, number> = {};

  async function refresh() {
    const r = await refreshBets(client, contracts, bets, maxIds, { second, raiser });
    maxIds = r.maxIds;
    bets = r.bets;
    for (const f of r.failed) console.error(`indexer: contract ${f.contractId} unreadable, keeping cached entries: ${f.error}`);
  }

  let governance = new Map<string, GovernanceEvent[]>();
  async function refreshGov() {
    const network = cfg.networkId;
    const r = await refreshGovernance((id) => fetchEscrowHistory(network, id, {}), contracts.map((c) => c.id), governance);
    governance = r.events;
    for (const f of r.failed) console.error(`indexer: governance history for ${f.contractId} unreadable, keeping cached events: ${f.error}`);
  }

  await refresh();
  await refreshGov().catch((e) => console.error("indexer governance refresh failed", e));
  setInterval(() => refresh().catch((e) => console.error("indexer refresh failed", e)), Number(process.env.INDEXER_POLL_INTERVAL_MS ?? 20_000));
  setInterval(() => refreshGov().catch((e) => console.error("indexer governance refresh failed", e)), Number(process.env.INDEXER_GOVERNANCE_INTERVAL_MS ?? 60_000));

  const port = Number(process.env.INDEXER_PORT ?? 8787);
  createServer(() => bets, () => governance, contracts.map((c) => c.id)).listen(port, () => console.log(`indexer listening on :${port}`));
}

if (process.argv[1] && process.argv[1].endsWith("server.ts")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
