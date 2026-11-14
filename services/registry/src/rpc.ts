export interface AccessKeyInfo { public_key: string; access_key: { permission: "FullAccess" | { FunctionCall: unknown } } }
export interface RegistryRpc {
  viewAccessKeyList(accountId: string): Promise<AccessKeyInfo[]>;
  /** WALLET1: false only on a definite UNKNOWN_ACCOUNT; throws on any other RPC failure. Optional: without it the implicit fallback is off. */
  accountExists?(accountId: string): Promise<boolean>;
}

export function createRpcClient(url: string, fetchImpl: typeof fetch = fetch): RegistryRpc {
  const query = async (params: Record<string, unknown>): Promise<any> => {
    const res = await fetchImpl(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "reg", method: "query", params: { ...params, finality: "final" } }),
    });
    return res.json();
  };
  return {
    async viewAccessKeyList(accountId) {
      const j = await query({ request_type: "view_access_key_list", account_id: accountId });
      if (j.error || !j.result || !Array.isArray(j.result.keys)) throw new Error("rpc view_access_key_list failed");
      return j.result.keys as AccessKeyInfo[];
    },
    async accountExists(accountId) {
      const j = await query({ request_type: "view_account", account_id: accountId });
      if (j.error) {
        if (j.error.cause?.name === "UNKNOWN_ACCOUNT") return false;
        throw new Error("rpc view_account failed");
      }
      if (!j.result) throw new Error("rpc view_account failed");
      return true;
    },
  };
}
