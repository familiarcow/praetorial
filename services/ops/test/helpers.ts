import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SECRET_MARK = "dummy-secret-value-do-not-print";

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ops-test-"));
}

export function testnetEnv(): Record<string, string> {
  return {
    NEAR_NETWORK_ID: "testnet",
    NEAR_RPC_URL: "https://rpc.example.invalid",
    ESCROW_CONTRACT_ID: "praetorial-esc.testnet",
    INTENTS_CONTRACT_ID: "intents.testnet",
    USDC_TOKEN_ID: "usdc.fakes.testnet",
    HEARTBEAT_DIR: "/tmp/praetorial-hb",
    KEEPER_KEY_FILE: "/keys/keeper.json",
    KEEPER_ACCOUNT_ID: "keeper.testnet",
    RELAYER_KEY_FILE: "/keys/relayer.json",
    RELAYER_ACCOUNT_ID: "relayer.testnet",
    NOTIFIER_CONTACT_KEY: SECRET_MARK,
    TREASURY_ACCOUNT_ID: "treasury.testnet",
    TREASURY_RELAYER_ACCOUNT_ID: "relayer.testnet",
    TREASURY_KEEPER_ACCOUNT_ID: "keeper.testnet",
    TREASURY_USD_ASSET_ID: "nep141:usdc.testnet",
    TREASURY_SCHEDULE_ENABLED: "1",
    ONECLICK_API_KEY: SECRET_MARK,
  };
}

export function mainnetEnv(): Record<string, string> {
  return {
    ...testnetEnv(),
    NEAR_NETWORK_ID: "mainnet",
    NEAR_RPC_URL: "https://free.rpc.fastnear.com",
    NEAR_RPC_FALLBACKS: "https://backup.example.invalid",
    ESCROW_CONTRACT_ID: "praetorial.near",
    INTENTS_CONTRACT_ID: "intents.near",
    USDC_TOKEN_ID: "usdc.near",
    KEEPER_ACCOUNT_ID: "keeper.near",
    RELAYER_ACCOUNT_ID: "relayer.near",
    TREASURY_ACCOUNT_ID: "treasury.near",
    TREASURY_RELAYER_ACCOUNT_ID: "relayer.near",
    TREASURY_KEEPER_ACCOUNT_ID: "keeper.near",
    TREASURY_USD_ASSET_ID: "nep141:usdc.near",
    ALERT_TELEGRAM_BOT_TOKEN: SECRET_MARK,
    ALERT_TELEGRAM_CHAT_ID: "-100123",
  };
}

export function writeEnvFile(dir: string, env: Record<string, string>, name = "svc.env"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  return p;
}

export function writeRelease(dir: string, rec: unknown, name = "record.json"): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(rec));
  return p;
}

export const TESTNET_RECORD = { testnet_escrow: { account: "praetorial-esc.testnet" }, resolver_account: "praetorial-res.testnet" };
export const MAINNET_RECORD = { mainnet_escrow: { account: "praetorial.near" }, resolver_account: "resolver.praetorial.near" };

export function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, text: () => out.join("\n") + "\n" + err.join("\n") };
}
