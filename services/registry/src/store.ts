import { promises as fs } from "node:fs";
import { dirname } from "node:path";

export interface UserRecord { username: string; account_id: string; public_key: string; discoverable: boolean; claimed_at: number }
export interface RegistryState { users: Record<string, UserRecord>; nonces: Record<string, number> }
export interface RegistryStore { read(): Promise<RegistryState>; write(s: RegistryState): Promise<void> }

const empty = (): RegistryState => ({ users: {}, nonces: {} });

export class MemoryStore implements RegistryStore {
  private s: RegistryState = empty();
  async read() { return structuredClone(this.s); }
  async write(s: RegistryState) { this.s = structuredClone(s); }
}

/** Atomic JSON file: write temp in the same dir, then rename. A corrupt file is an error, never a silent reset. */
export class JsonFileStore implements RegistryStore {
  constructor(private path: string) {}
  async read(): Promise<RegistryState> {
    let txt: string;
    try { txt = await fs.readFile(this.path, "utf8"); } catch (e: any) { if (e.code === "ENOENT") return empty(); throw e; }
    const j = JSON.parse(txt);
    if (!j || typeof j !== "object" || typeof j.users !== "object" || typeof j.nonces !== "object") throw new Error("registry store file malformed");
    return j as RegistryState;
  }
  async write(s: RegistryState): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
    await fs.rename(tmp, this.path);
  }
}
