// D-DSY1 (1): compare the escrow's on-chain contract_version() (Cargo
// semver) with the version label declared in ESCROW_CONTRACTS ('id@LABEL').
//
// Comparison rule (documented in services/README.md):
//   * label 'vN' (N = digits)        -> matches iff the contract's semver MAJOR == N
//   * label full semver ('1.2.3', 'v1.2.3', optional -pre) -> matches iff equal
//     to the contract's version exactly (leading 'v' ignored)
//   * anything else (unparsable label / version) -> mismatch
// Unreadable/empty/non-string contract_version => status "unchecked" (a
// distinct state from "mismatch"; callers raise a distinct alert).
import type { EscrowContractRef } from "./config.js";

export interface ViewClient {
  view<T>(contractId: string, methodName: string, args?: Record<string, unknown>): Promise<T>;
}

export type VersionStatus = "match" | "mismatch" | "unchecked";

export interface VersionCheck {
  contractId: string;
  label: string;
  status: VersionStatus;
  actual: string | null;
  detail: string;
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function versionMatchesLabel(label: string, actual: string): boolean {
  const a = SEMVER.exec(actual.trim());
  if (!a) return false;
  const l = label.trim();
  const major = /^v(\d+)$/.exec(l);
  if (major) return Number(major[1]) === Number(a[1]);
  const full = l.startsWith("v") ? l.slice(1) : l;
  if (!SEMVER.test(full)) return false;
  return full === actual.trim();
}

export async function checkContractVersions(client: ViewClient, contracts: EscrowContractRef[]): Promise<VersionCheck[]> {
  const out: VersionCheck[] = [];
  for (const c of contracts) {
    try {
      const v = await client.view<unknown>(c.id, "contract_version", {});
      if (typeof v !== "string" || v.trim() === "") {
        out.push({ contractId: c.id, label: c.version, status: "unchecked", actual: null, detail: "contract_version() returned no version string" });
        continue;
      }
      const ok = versionMatchesLabel(c.version, v);
      out.push({
        contractId: c.id, label: c.version, status: ok ? "match" : "mismatch", actual: v,
        detail: `label=${c.version} contract_version=${v}`,
      });
    } catch (err: any) {
      out.push({ contractId: c.id, label: c.version, status: "unchecked", actual: null, detail: String(err?.message ?? err) });
    }
  }
  return out;
}
