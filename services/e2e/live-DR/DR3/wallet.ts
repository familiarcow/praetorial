// Fresh per-run bettor wallet (ruling 2): a new ed25519 key -> implicit account no earlier run touched, so the balance-delta check is a hard assertion.
// The key is persisted 0600 OUTSIDE the repo so a later phase can sign again; it is never printed.
import fs from "node:fs";
import { createPrivateKey, sign as edSign } from "node:crypto";
import { freshBettorAccounts } from "../harness/money.js";

export interface Wallet { address: string; sign: (hashHex: string) => string }
const toWallet = (address: string, der: Buffer): Wallet => {
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return { address, sign: (h) => edSign(null, Buffer.from(h.replace(/^0x/, ""), "hex"), key).toString("hex") };
};
export function freshWallet(persistPath?: string): Wallet {
  const k = freshBettorAccounts().taker;
  if (persistPath) fs.writeFileSync(persistPath, JSON.stringify({ address: k.account, pkcs8: k.secretKeyPkcs8Der.toString("hex") }), { mode: 0o600 });
  return toWallet(k.account, k.secretKeyPkcs8Der);
}
export function loadWallet(persistPath: string): Wallet {
  const j = JSON.parse(fs.readFileSync(persistPath, "utf8")) as { address: string; pkcs8: string };
  return toWallet(j.address, Buffer.from(j.pkcs8, "hex"));
}
