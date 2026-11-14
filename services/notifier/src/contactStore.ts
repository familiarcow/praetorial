// PII minimisation (TASK A): the only personal data this service is
// allowed to hold at all is a user's contact info (email or telegram
// handle), and it must never sit on disk as plaintext. Everything else
// about a bet/account is public NEAR chain data already (see notifier.ts
// doc comment). Encrypted with AES-256-GCM (node:crypto, no extra
// dependency) under a key supplied only via NOTIFIER_CONTACT_KEY --
// this process refuses to start without one. Backed by node:sqlite
// (same approach as services/relayer/src/guardStore.ts, commit ed731f4)
// so contacts survive a restart without inventing a second storage
// mechanism in this codebase.
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export type ContactKind = "email" | "telegram";

export interface Contact {
  kind: ContactKind;
  value: string;
}

const ALGO = "aes-256-gcm";
const KEY_HEX_LEN = 64; // 32 bytes

function parseKey(keyHex: string | undefined): Buffer {
  if (!keyHex) {
    throw new Error(
      "NOTIFIER_CONTACT_KEY is required: refusing to start without a key to encrypt contact info at rest",
    );
  }
  if (keyHex.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(keyHex)) {
    throw new Error("NOTIFIER_CONTACT_KEY must be a 64-char hex string (32 bytes) for AES-256-GCM");
  }
  return Buffer.from(keyHex, "hex");
}

export class ContactStore {
  private db: DatabaseSync;
  private key: Buffer;

  /** `keyHex` is the raw secret, never logged -- callers must not log it
   * either. Throws (refuses to start) without a valid key. */
  constructor(dbPath: string, keyHex: string | undefined) {
    this.key = parseKey(keyHex);
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  private migrate(): void {
    // Only an account id (already public NEAR chain data -- see
    // notifier.ts) plus an opaque encrypted blob is ever stored. No
    // plaintext column of any kind exists on this table.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        account_id    TEXT PRIMARY KEY,
        iv            BLOB NOT NULL,
        auth_tag      BLOB NOT NULL,
        ciphertext    BLOB NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Encrypts {kind, value} and upserts it for `account`. Never logs the
   * plaintext anywhere -- the only things that leave this function are
   * iv/auth_tag/ciphertext bytes. */
  setContact(account: string, kind: ContactKind, value: string): void {
    const plaintext = Buffer.from(JSON.stringify({ kind, value }), "utf8");
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    this.db
      .prepare(
        `INSERT INTO contacts (account_id, iv, auth_tag, ciphertext, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET iv = excluded.iv, auth_tag = excluded.auth_tag,
           ciphertext = excluded.ciphertext, updated_at_ms = excluded.updated_at_ms`,
      )
      .run(account, iv, authTag, ciphertext, Date.now());
  }

  /** Decrypts and returns the stored contact for `account`, or null if
   * none exists. Throws (never returns plaintext, never silently
   * substitutes garbage) if the configured key cannot authenticate the
   * stored auth tag -- e.g. a wrong/rotated key. */
  getContact(account: string): Contact | null {
    const row = this.db.prepare("SELECT iv, auth_tag, ciphertext FROM contacts WHERE account_id = ?").get(account) as
      | { iv: Uint8Array; auth_tag: Uint8Array; ciphertext: Uint8Array }
      | undefined;
    if (!row) return null;
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(row.iv));
    decipher.setAuthTag(Buffer.from(row.auth_tag));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as Contact;
  }

  /** User deletion: removes every row for `account`. Idempotent -- a
   * second call on an already-deleted account is a harmless no-op. */
  deleteContact(account: string): void {
    this.db.prepare("DELETE FROM contacts WHERE account_id = ?").run(account);
  }

  /** Test/ops helper: how many rows remain for an account (should be 0
   * or 1; never more, since account_id is the primary key). */
  rowCountForAccount(account: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE account_id = ?").get(account) as {
      n: number;
    };
    return row.n;
  }
}
