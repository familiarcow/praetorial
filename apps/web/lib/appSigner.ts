// SECREV1 SR-3: the app's signer (Privy NEAR key, or a mocked spec's test wallet), held in module scope instead of on `window`,
// so page scripts cannot reach a "sign any hash" function. App.tsx sets it every render; components read it at call time.
export type SignRawHash = (address: string, hashHex: string) => Promise<string>;
let current: SignRawHash | null = null;
export function setAppSigner(f: SignRawHash): void { current = f; }
/** Signs with the current app signer (read at call time, so a swapped-in test wallet is honoured). */
export const appSignRawHash: SignRawHash = (address, hashHex) => {
  if (!current) return Promise.reject(new Error("wallet not ready"));
  return current(address, hashHex);
};
