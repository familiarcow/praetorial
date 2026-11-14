// Thin wrapper over near-api-js: one signer account, view/call helpers,
// and a hard per-call attached-NEAR ceiling every payable call goes
// through. No service in this repo holds a key that can sign a stake
// transfer, or a challenge, or an outcome — only plain
// contract-method calls on accounts the service itself owns.
//
// D-RPC1 (queue item 7b): every RPC call this client makes (view AND
// signed calls, since `near.connection.provider` is swapped below)
// goes through the shared PacedRpcClient -- client-side pacing (max
// 3 req/s, max 4 in-flight), retry with backoff+jitter on
// 429/5xx/network errors (honoring Retry-After), and failover across
// cfg.rpcUrls once one endpoint's retries are exhausted.
import { connect, keyStores, KeyPair, Near, Account, providers } from "near-api-js";
import type { ServiceConfig } from "./config.js";
import { MAX_ATTACHED_NEAR_YOCTO } from "./config.js";
import { PacedRpcClient, resolveRpcUrls } from "./rpc.js";

export interface SignerKey {
  accountId: string;
  privateKey: string; // empty string => view-only client, no signing capability
}

/** near-api-js JsonRpcProvider subclass that routes every RPC call
 * through a shared PacedRpcClient instead of near-api-js's own
 * fetch/retry logic, so pacing/backoff/failover/429-counting is
 * identical whether the call came from view() or from a signed
 * Account.functionCall(). */
export class PacedJsonRpcProvider extends providers.JsonRpcProvider {
  constructor(private readonly paced: PacedRpcClient, url: string) {
    super({ url });
  }

  async sendJsonRpc<T = any>(method: string, params: unknown): Promise<T> {
    const response: any = await this.paced.sendJsonRpc(method, params);
    if (response?.error) {
      const msg = typeof response.error === "string" ? response.error : JSON.stringify(response.error);
      throw new Error(`NEAR RPC error (${method}): ${msg}`);
    }
    if (typeof response?.result === "undefined") {
      throw new Error(`NEAR RPC (${method}): response had no result`);
    }
    return response.result as T;
  }
}

export class NearClient {
  private near!: Near;
  account!: Account;
  private viewOnly: boolean;
  private provider: PacedJsonRpcProvider;
  private pacedClient: PacedRpcClient;

  // Views read at `final` by default: an `optimistic` read can show a
  // state (e.g. a Proposed/Settled outcome) that a reorg later drops, and
  // services act/notify on it. Costs ~2 blocks of latency, which the
  // keeper's persisted 30s rate limit already covers.
  private viewFinality: "final" | "optimistic";

  constructor(private cfg: ServiceConfig, private signer: SignerKey, opts: { viewFinality?: "final" | "optimistic" } = {}) {
    this.viewFinality = opts.viewFinality ?? (process.env.NEAR_VIEW_FINALITY === "optimistic" ? "optimistic" : "final");
    this.viewOnly = signer.privateKey === "";
    const urls = cfg.rpcUrls?.length ? cfg.rpcUrls : resolveRpcUrls(cfg.networkId).all;
    this.pacedClient = new PacedRpcClient({ urls });
    this.provider = new PacedJsonRpcProvider(this.pacedClient, cfg.nodeUrl);
  }

  async init(): Promise<void> {
    if (this.viewOnly) return; // nothing to sign in; view() uses provider directly.
    const keyStore = new keyStores.InMemoryKeyStore();
    const kp = KeyPair.fromString(this.signer.privateKey as any);
    await keyStore.setKey(this.cfg.networkId, this.signer.accountId, kp);
    this.near = await connect({
      networkId: this.cfg.networkId,
      nodeUrl: this.cfg.nodeUrl,
      keyStore,
    });
    // Swap in the paced provider so signed calls (functionCall, etc.)
    // get the same pacing/retry/failover as view() below, instead of
    // near-api-js's own unpaced JsonRpcProvider built by connect().
    (this.near.connection as { provider: providers.Provider }).provider = this.provider;
    this.account = await this.near.account(this.signer.accountId);
  }

  async view<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
    // One path for signing and view-only clients so finality is uniform.
    const result: any = await this.provider.query({
      request_type: "call_function",
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      finality: this.viewFinality,
    });
    const bytes = Buffer.from(result.result);
    return bytes.length ? JSON.parse(bytes.toString("utf8")) : (null as unknown as T);
  }

  /** Non-payable state-changing call. */
  async call<T>(
    contractId: string,
    methodName: string,
    args: Record<string, unknown> = {},
    gasTgas = 30,
  ): Promise<T> {
    return this.account.functionCall({
      contractId,
      methodName,
      args,
      gas: BigInt(gasTgas) * 1_000_000_000_000n,
    }) as unknown as Promise<T>;
  }

  /** Payable call with a hard ceiling: refuses to attach more than
   * MAX_ATTACHED_NEAR_YOCTO (configurable, testnet-safe default 0.05 NEAR)
   * to any single call, independent of what the caller requests. This is
   * the "float cap" safety rail for the keeper (master map C3/R17). */
  async callPayable<T>(
    contractId: string,
    methodName: string,
    args: Record<string, unknown>,
    attachedYocto: bigint,
    gasTgas = 300,
  ): Promise<T> {
    if (attachedYocto > MAX_ATTACHED_NEAR_YOCTO) {
      throw new Error(
        `refusing to attach ${attachedYocto} yoctoNEAR to ${methodName}: exceeds per-call max ${MAX_ATTACHED_NEAR_YOCTO}`,
      );
    }
    return this.account.functionCall({
      contractId,
      methodName,
      args,
      gas: BigInt(gasTgas) * 1_000_000_000_000n,
      attachedDeposit: attachedYocto,
    }) as unknown as Promise<T>;
  }
}
