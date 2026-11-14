// HTTP handler for POST /relay, split out of runner.ts so it can be tested
// without a NearClient/network. Behaviour is identical to the previous
// inline handler in runner.ts.
import http from "node:http";
import type { GlobalBudgetStatus } from "./guardStore.js";
import { MAX_BODY_BYTES, parseRelayBody, errorResponse, budgetJson, describeInternal } from "./httpMap.js";

export { MAX_BODY_BYTES };

export interface RelayLike {
  relay(signedDelegateBase64: string): Promise<{ txHash: string; receiptFailure?: string }>;
  /** Optional: when present, GET /budget/global serves it (monitor feed). */
  globalBudgetStatus?(): GlobalBudgetStatus;
}

export function createRelayHandler(relayer: RelayLike): http.RequestListener {
  return (req, res) => {
    if (req.method === "GET" && req.url === "/budget/global" && relayer.globalBudgetStatus) {
      const g = relayer.globalBudgetStatus();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(budgetJson(g)));
      return;
    }
    if (req.method !== "POST" || req.url !== "/relay") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "POST /relay only" }));
      return;
    }
    let body = "";
    let size = 0;
    let tooBig = false;
    req.on("data", (c: Buffer) => {
      if (tooBig) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        body = "";
        res.statusCode = 413;
        res.setHeader("connection", "close");
        res.end(JSON.stringify({ ok: false, error: "request body too large" }));
        req.destroy();
        return;
      }
      body += c;
    });
    req.on("end", async () => {
      if (tooBig) return;
      try {
        const result = await relayer.relay(parseRelayBody(body));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result.receiptFailure ? { ok: false, txHash: result.txHash, receiptFailure: result.receiptFailure, error: `transaction failed on chain: ${result.receiptFailure}` } : { ok: true, txHash: result.txHash })); // LIVE1 2b
      } catch (err: any) {
        const e = errorResponse(err);
        if (e.internal) console.error(`[relayer] internal error: ${describeInternal(err)}`);
        res.statusCode = e.status;
        res.end(JSON.stringify(e.body));
      }
    });
  };
}
