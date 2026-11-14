// Plain near-api-js signer for the funder account (an ordinary key
// file, not a Privy wallet). Used ONLY to send the one-time testnet
// funding transfer (task step 3) -- never used to act on behalf of
// the user's own Privy-controlled account. Copied/adapted from
// services/privy-e2e/lib/localSigner.ts; key material is read from
// disk and handed straight to near-api-js, never logged.
import fs from "node:fs";
import { connect, keyStores, KeyPair, Near, Account } from "near-api-js";
import { NODE_URL_TESTNET } from "./config.js";

const NETWORK_ID = "testnet";

export interface NearKeyFile {
  account_id?: string;
  public_key: string;
  private_key: string;
}

export function loadKeyFile(path: string): NearKeyFile {
  const parsed = JSON.parse(fs.readFileSync(path, "utf8"));
  if (!parsed.private_key || !parsed.public_key) throw new Error(`key file ${path} missing keys`);
  return parsed;
}

export class LocalSigner {
  near!: Near;
  account!: Account;
  constructor(
    public accountId: string,
    private privateKey: string,
  ) {}

  async init(): Promise<void> {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(NETWORK_ID, this.accountId, KeyPair.fromString(this.privateKey as any));
    this.near = await connect({ networkId: NETWORK_ID, nodeUrl: NODE_URL_TESTNET, keyStore });
    this.account = await this.near.account(this.accountId);
  }

  async sendNear(receiverId: string, amountYocto: bigint): Promise<any> {
    return this.account.sendMoney(receiverId, amountYocto as any);
  }
}
