// F1: the one NEAR read the funding Worker makes: intents.near mt_balance_of(account, token) before a real Cash out / Convert quote.
export function intentsChain(o: { rpcUrl: string; intentsContract: string; fetchImpl?: typeof fetch }) {
  const f = o.fetchImpl ?? fetch;
  return {
    async intentsBalance(account: string, tokenId: string): Promise<bigint> {
      const args = btoa(JSON.stringify({ account_id: account, token_id: tokenId }));
      const r = await f(o.rpcUrl, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ jsonrpc: "2.0", id: "f", method: "query", params: { request_type: "call_function", finality: "final", account_id: o.intentsContract, method_name: "mt_balance_of", args_base64: args } }),
      });
      const j: any = await r.json();
      const bytes = j?.result?.result;
      if (!Array.isArray(bytes)) throw new Error("rpc: no result");
      const v = JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
      if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error("rpc: bad balance");
      return BigInt(v);
    },
  };
}
