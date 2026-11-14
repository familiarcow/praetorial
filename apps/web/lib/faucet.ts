// FUND1: testnet only. The public NEAR testnet faucet, opened with the user's account as a parameter (the id itself is never shown in AddMoney: rule 1).

// FUND1b: one-click test NEAR. The relayer Worker (testnet only) sends a capped transfer; the key never reaches the browser.
import { NETWORK, requireService } from "./network";
export type TestNearResult = { ok: true; txHash: string; amountNear: string } | { ok: false; message: string };
export async function requestTestNear(account: string, o: { fetchImpl?: typeof fetch; base?: string; network?: string } = {}): Promise<TestNearResult> {
  if ((o.network ?? NETWORK.networkId) !== "testnet") return { ok: false, message: "Test NEAR only exists on the test network." };
  const F = o.fetchImpl ?? fetch;
  try {
    const base = o.base ?? requireService("relayer", NETWORK.relayerUrl);
    const res = await F(`${base}/faucet`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account }) });
    const j: any = await res.json();
    if (res.ok && j?.ok && typeof j.txHash === "string") return { ok: true, txHash: j.txHash, amountNear: String(j.amountNear ?? "1") };
    return { ok: false, message: typeof j?.error === "string" ? j.error : "We couldn't send test NEAR right now. Try again in a minute." };
  } catch {
    return { ok: false, message: "We couldn't send test NEAR right now. Try again in a minute." };
  }
}
