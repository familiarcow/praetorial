// SRCW1 (2): sourcecheck execution = a plain OutLayer `request_execution` signed by the dedicated attest signer (D-ATTEST2,
// CM-OL11f), mirroring services/keeper/src/archiveProd.ts (OutLayerArchiveClient + realArchiveFactories.resolveWasm/execute):
// wasm hash = escrow view resolver_keys[2], base URL = escrow view outlayer_config.wasm_base_url, NEVER hand-configured.
// (archiveProd itself pulls node:fs through ArchiveStore, so the small pure parts are mirrored here and parity-tested against it.)
// resolver_keys = [resolver_pubkey_hex, attest_pubkey_hex, wasm_hash]; the pinned attest key is [1].
import { buildSignedFunctionCallTx, base58Encode, type JsonRpc } from "../../common/src/nearWebClient.js";
import { base64Encode, utf8 } from "../../common/src/bytes.js";
import type { SourceCheckChain } from "./core.js";

const WASM_TARGET = "wasm32-wasip2";
const MAX_INSTRUCTIONS = 5_000_000_000;
const MAX_MEMORY_MB = 128;
const MAX_SECONDS = 90;
/** ~0.31 NEAR per run measured on testnet (D-ATTEST2 note); unspent deposit is refunded by OutLayer. Ceiling 0.4 NEAR, same as the keeper. */
export const ATTACH_YOCTO = 400_000_000_000_000_000_000_000n;
const GAS = 100_000_000_000_000n;

export function sourceCheckRequestArgs(p: { wasmBaseUrl: string; wasmHash: string; rawTerms: string }): Record<string, any> {
  return {
    source: { WasmUrl: { url: `${p.wasmBaseUrl}/${p.wasmHash}.wasm`, hash: p.wasmHash, build_target: WASM_TARGET } },
    input_data: JSON.stringify({ mode: "sourcecheck", terms: p.rawTerms }),
    resource_limits: { max_instructions: MAX_INSTRUCTIONS, max_memory_mb: MAX_MEMORY_MB, max_execution_seconds: MAX_SECONDS },
    response_format: "Json",
  };
}

export interface SendArgs { contractId: string; methodName: string; args: Record<string, any>; gas: bigint; attachedDeposit: bigint; signerId: string; }
export interface SendResult { hash: string; /** final tx result (receipts_outcome...) or null while still running */ result: any | null; }
export interface ChainOpts {
  escrowContract: string; outlayerContract: string; attestAccountId: string;
  view<T>(contractId: string, method: string, args?: Record<string, unknown>): Promise<T>;
  send(a: SendArgs): Promise<SendResult>;
  poll?(hash: string): Promise<any | null>;
  timeoutMs?: number; pollMs?: number;
}
export class SourceCheckTimeout extends Error { override name = "SourceCheckTimeout"; }

/** Guest output = JSON in the OutLayer contract's callback receipt (same as archiveProd.extractOutlayerOutput, without Buffer). */
export function extractOutlayerOutput(txResult: any, outlayerContract: string): unknown | null {
  for (const o of txResult?.receipts_outcome ?? []) {
    if (o?.outcome?.executor_id !== outlayerContract) continue;
    const v = o?.outcome?.status?.SuccessValue;
    if (!v) continue;
    try {
      // The guest prints checked_at as a bare u64-ns number (> 2^53): quote it BEFORE parsing so no float rounding breaks the signature.
      const text = new TextDecoder().decode(Uint8Array.from(atob(v), (c) => c.charCodeAt(0))).replace(/("checked_at"\s*:\s*)(\d+)/g, '$1"$2"');
      const parsed = JSON.parse(text);
      if (parsed !== null && typeof parsed === "object") return parsed;
    } catch { /* not the guest output */ }
  }
  return null;
}

export class OutLayerSourceCheckChain implements SourceCheckChain {
  constructor(private readonly o: ChainOpts) {}
  private async keys(): Promise<[string, string, string]> {
    const k = await this.o.view<unknown>(this.o.escrowContract, "resolver_keys", {});
    if (!Array.isArray(k) || k.length < 3 || typeof k[1] !== "string" || typeof k[2] !== "string" || !k[2]) throw new Error("escrow resolver_keys view did not return [resolver, attest, wasm_hash]");
    return [String(k[0]), k[1], k[2]];
  }
  async pinnedAttestPubkeyHex(): Promise<string> { return (await this.keys())[1]; }
  async execute(rawTerms: string): Promise<unknown> {
    const [, , hash] = await this.keys();
    const oc = await this.o.view<{ wasm_base_url?: string }>(this.o.escrowContract, "outlayer_config", {});
    if (!oc?.wasm_base_url) throw new Error("escrow outlayer_config view has no wasm_base_url");
    const args = sourceCheckRequestArgs({ wasmBaseUrl: oc.wasm_base_url, wasmHash: hash, rawTerms });
    const deadline = Date.now() + (this.o.timeoutMs ?? 55_000);
    let r = await this.o.send({ contractId: this.o.outlayerContract, methodName: "request_execution", args, gas: GAS, attachedDeposit: ATTACH_YOCTO, signerId: this.o.attestAccountId });
    for (;;) {
      const res = r.result;
      if (res) {
        if (res.status?.Failure) throw new Error(`OutLayer request_execution failed: ${JSON.stringify(res.status.Failure).slice(0, 200)}`);
        const out = extractOutlayerOutput(res, this.o.outlayerContract);
        if (out !== null) return out;
        if (res.status?.SuccessValue !== undefined) throw new Error("OutLayer run returned no output (failed run)");
      }
      if (Date.now() >= deadline) throw new SourceCheckTimeout("OutLayer sourcecheck did not finish in time");
      await new Promise((ok) => setTimeout(ok, this.o.pollMs ?? 2000));
      r = { hash: r.hash, result: this.o.poll ? await this.o.poll(r.hash) : null };
    }
  }
}

// ---- real wiring (Worker): plain JSON-RPC + WebCrypto-signed tx ------------------------------------------------------------
export function jsonRpcOver(url: string, budget: { left: number }): JsonRpc {
  return {
    async sendJsonRpc(method, params) {
      if (budget.left-- <= 0) throw new Error("subrequest budget exhausted");
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: "sc", method, params }) });
      return res.json();
    },
  };
}
const rpcResult = async (rpc: JsonRpc, method: string, params: unknown) => {
  const r = await rpc.sendJsonRpc(method, params);
  if (r?.error) throw new Error(`NEAR RPC error (${method}): ${typeof r.error === "string" ? r.error : JSON.stringify(r.error.data ?? r.error.cause ?? r.error.name ?? r.error).slice(0, 200)}`);
  return r.result;
};

export function realChain(c: { rpc: JsonRpc; escrowContract: string; outlayerContract: string; attestAccountId: string; attestPrivateKey: string; timeoutMs?: number; pollMs?: number }): OutLayerSourceCheckChain {
  const view = async <T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> => {
    const r = await rpcResult(c.rpc, "query", { request_type: "call_function", account_id: contractId, method_name: method, args_base64: base64Encode(utf8(JSON.stringify(args))), finality: "final" });
    return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result)));
  };
  const attempt = async (a: SendArgs): Promise<SendResult> => {
    const { parseNearSecretKey } = await import("../../common/src/nearWebClient.js");
    const pubStr = "ed25519:" + base58Encode(parseNearSecretKey(c.attestPrivateKey).pub);
    const [key, block] = await Promise.all([
      rpcResult(c.rpc, "query", { request_type: "view_access_key", finality: "optimistic", account_id: a.signerId, public_key: pubStr }),
      rpcResult(c.rpc, "block", { finality: "final" }),
    ]);
    const { signedTx, txHashInput } = await buildSignedFunctionCallTx({ signerId: a.signerId, secretKey: c.attestPrivateKey, nonce: BigInt(key.nonce) + 1n, receiverId: a.contractId, blockHash: block.header.hash, methodName: a.methodName, args: utf8(JSON.stringify(a.args)), gas: a.gas, deposit: a.attachedDeposit });
    const hash = base58Encode(new Uint8Array(await crypto.subtle.digest("SHA-256", txHashInput as Uint8Array<ArrayBuffer>)));
    const r = await c.rpc.sendJsonRpc("send_tx", { signed_tx_base64: base64Encode(signedTx), wait_until: "NONE" });
    if (r?.error) throw new Error(`NEAR RPC error (send_tx): ${JSON.stringify(r.error.data ?? r.error.name ?? r.error).slice(0, 200)}`);
    return { hash, result: null };
  };
  return new OutLayerSourceCheckChain({
    escrowContract: c.escrowContract, outlayerContract: c.outlayerContract, attestAccountId: c.attestAccountId, view,
    timeoutMs: c.timeoutMs, pollMs: c.pollMs,
    async send(a) {
      try { return await attempt(a); } catch (e: any) { if (!/InvalidNonce/i.test(String(e?.message))) throw e; return await attempt(a); }
    },
    async poll(hash) {
      const r = await c.rpc.sendJsonRpc("tx", { tx_hash: hash, sender_account_id: c.attestAccountId, wait_until: "FINAL" });
      if (r?.error || !r?.result) return null; // UNKNOWN_TRANSACTION / TIMEOUT while the callback is still pending
      return r.result.final_execution_status === "FINAL" || r.result.receipts_outcome ? r.result : null;
    },
  });
}
