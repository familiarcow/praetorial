import fs from "node:fs";

/** Minimal dotenv parser: KEY=VALUE, optional `export `, quotes, # comments. Never logs values. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function loadEnvFile(path: string): Record<string, string> {
  return parseEnvFile(fs.readFileSync(path, "utf8"));
}

export interface CliIo { stdout: (s: string) => void; stderr: (s: string) => void }
export const realIo: CliIo = { stdout: (s) => console.log(s), stderr: (s) => console.error(s) };

/** Strict flag parser: every arg must be a known --flag (value flags take one value). Returns undefined on misuse. */
export function parseFlags(argv: string[], valueFlags: string[], boolFlags: string[] = []): Record<string, string | true> | undefined {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) return undefined;
    const k = a.slice(2);
    if (boolFlags.includes(k)) { out[k] = true; continue; }
    if (!valueFlags.includes(k)) return undefined;
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) return undefined;
    out[k] = v;
  }
  return out;
}
