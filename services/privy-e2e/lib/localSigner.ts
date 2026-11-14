// Plain near-api-js signer for accounts we hold ordinary key files for
// (funder, an existing taker, the keeper/resolver role in this
// harness). None of these are Privy wallets -- Privy is exercised only
// through lib/nearRaw.ts + lib/privy.ts for the test user's wallet.
import fs from "node:fs";
import { connect, keyStores, KeyPair, Near, Account } from "near-api-js";
import { NODE_URL, NETWORK_ID } from "./rpc.js";

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
  constructor(public accountId: string, private privateKey: string) {}

  async init(): Promise<void> {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(NETWORK_ID, this.accountId, KeyPair.fromString(this.privateKey as any));
    this.near = await connect({ networkId: NETWORK_ID, nodeUrl: NODE_URL, keyStore });
    this.account = await this.near.account(this.accountId);
  }

  async call<T>(contractId: string, methodName: string, args: Record<string, unknown> = {}, gasTgas = 60): Promise<T> {
    return this.account.functionCall({
      contractId,
      methodName,
      args,
      gas: BigInt(gasTgas) * 1_000_000_000_000n,
    }) as unknown as Promise<T>;
  }

  async callPayable<T>(contractId: string, methodName: string, args: Record<string, unknown>, attachedYocto: bigint, gasTgas = 300): Promise<T> {
    return this.account.functionCall({
      contractId,
      methodName,
      args,
      gas: BigInt(gasTgas) * 1_000_000_000_000n,
      attachedDeposit: attachedYocto,
    }) as unknown as Promise<T>;
  }

  async sendNear(receiverId: string, amountYocto: bigint): Promise<any> {
    return this.account.sendMoney(receiverId, amountYocto as any);
  }
}
