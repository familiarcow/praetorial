// WebCrypto AES-256-GCM contact store for the notifier Worker (CF1c2). Row-compatible with the node ContactStore
// (services/notifier/src/contactStore.ts): same table `contacts(account_id, iv BLOB(12), auth_tag BLOB(16), ciphertext BLOB,
// updated_at_ms)`, same plaintext JSON `{kind,value}`, same key format (NOTIFIER_CONTACT_KEY = 64 hex chars). WebCrypto's
// AES-GCM returns ciphertext||tag, node keeps them in separate columns, so we split/join the trailing 16-byte tag.
// Contact info is the only PII this service holds and never sits in SQLite as plaintext. No node:* / Buffer here.
import type { SqlStorage } from "../../common/src/tickKit.js";

export type ContactKind = "email" | "telegram";
export interface Contact { kind: ContactKind; value: string }

const TAG_BYTES = 16, IV_BYTES = 12;

/** Validates the key (same messages as the node store: a service must refuse to start without one). */
export function parseContactKey(keyHex: string | undefined): Uint8Array {
  if (!keyHex) throw new Error("NOTIFIER_CONTACT_KEY is required: refusing to start without a key to encrypt contact info at rest");
  if (keyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(keyHex)) throw new Error("NOTIFIER_CONTACT_KEY must be a 64-char hex string (32 bytes) for AES-256-GCM");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(keyHex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// DO SQL returns BLOBs as ArrayBuffer, node:sqlite (test double) as Uint8Array: accept both.
const toBytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));
const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

export class WebContactStore {
  private keyP: Promise<CryptoKey> | undefined;
  /** Throws (refuses to start) without a valid key. `nowMs` is injectable for tests. */
  constructor(private readonly sql: SqlStorage, keyHex: string | undefined, private readonly nowMs: () => number = () => Date.now()) {
    const raw = parseContactKey(keyHex);
    this.keyP = crypto.subtle.importKey("raw", buf(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    this.keyP.catch(() => {}); // surfaced where it is awaited
    sql.exec(`CREATE TABLE IF NOT EXISTS contacts (
      account_id TEXT PRIMARY KEY, iv BLOB NOT NULL, auth_tag BLOB NOT NULL, ciphertext BLOB NOT NULL, updated_at_ms INTEGER NOT NULL)`).toArray();
  }

  async setContact(account: string, kind: ContactKind, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv), tagLength: TAG_BYTES * 8 }, await this.keyP!, new TextEncoder().encode(JSON.stringify({ kind, value }))));
    const ct = sealed.slice(0, sealed.length - TAG_BYTES), tag = sealed.slice(sealed.length - TAG_BYTES);
    this.sql.exec(
      `INSERT INTO contacts (account_id, iv, auth_tag, ciphertext, updated_at_ms) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET iv = excluded.iv, auth_tag = excluded.auth_tag, ciphertext = excluded.ciphertext, updated_at_ms = excluded.updated_at_ms`,
      account, iv, tag, ct, this.nowMs()).toArray();
  }

  /** Decrypted contact, or null if none. Throws (never garbage) if the key cannot authenticate the row (wrong/rotated key). */
  async getContact(account: string): Promise<Contact | null> {
    const rows = this.sql.exec("SELECT iv, auth_tag, ciphertext FROM contacts WHERE account_id = ?", account).toArray();
    if (!rows.length) return null;
    const ct = toBytes(rows[0].ciphertext), tag = toBytes(rows[0].auth_tag);
    const joined = new Uint8Array(ct.length + tag.length); joined.set(ct); joined.set(tag, ct.length);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(toBytes(rows[0].iv)), tagLength: TAG_BYTES * 8 }, await this.keyP!, joined);
    return JSON.parse(new TextDecoder().decode(plain)) as Contact;
  }

  deleteContact(account: string): void { this.sql.exec("DELETE FROM contacts WHERE account_id = ?", account).toArray(); }

  rowCountForAccount(account: string): number { return this.sql.exec("SELECT COUNT(*) AS n FROM contacts WHERE account_id = ?", account).toArray()[0].n as number; }
}
