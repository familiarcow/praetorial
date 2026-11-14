import fs from "node:fs";
import path from "node:path";

export interface TxLogEntry {
  ts: string;
  service: string;
  action: string;
  bet_id?: number;
  payout_id?: number;
  tx_hash?: string;
  status: "ok" | "error" | "skipped" | "VIOLATION";
  detail?: string;
}

export class TxLogger {
  constructor(private filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  log(entry: Omit<TxLogEntry, "ts">): void {
    const full: TxLogEntry = { ts: new Date().toISOString(), ...entry };
    fs.appendFileSync(this.filePath, JSON.stringify(full) + "\n");
    // eslint-disable-next-line no-console
    console.log(`[${full.service}] ${full.action} bet=${full.bet_id ?? "-"} status=${full.status} ${full.detail ?? ""}`.trim());
  }
}
