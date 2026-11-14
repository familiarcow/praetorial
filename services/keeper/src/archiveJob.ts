// D-FETCH1 part 3 / D-RESOLVE1 point (c) / queue item 7f3 (2026-11-05):
// the keeper no longer signs archive snapshots itself (there is no
// keeper signing key for this anymore). Instead it schedules the
// resolver's "archive" OutLayer job -- periodically, plus at trigger
// time (bet taken / status change) -- while the bet is live, and stores
// whatever resolver-signed snapshots come back after verifying them.
import fs from "node:fs";
import path from "node:path";
import type { Bet } from "@praetorial/common/types.js";
import { sha256Hex, verifyArchiveSnapshotPinned, type ArchiveSnapshot } from "@praetorial/common/archiveSnapshot.js";

/** Bet statuses during which source data is still being written and an
 * archive snapshot is worth capturing. Mirrors the "live" set used
 * elsewhere in the keeper (policy.ts's non-terminal statuses), minus
 * "Open" (no counterpart yet, nothing to archive against). */
const LIVE_STATUSES = new Set(["Taken", "Resolving", "Challenged", "Evidence"]);

export function isBetLive(bet: Bet): boolean {
  return LIVE_STATUSES.has(bet.status);
}

/** Periodic cadence between archive runs for one live bet (D-RESOLVE1
 * point (c): "periodically"). 6 hours -- frequent enough to catch a
 * short outage window, cheap enough not to spam OutLayer runs. */
export const ARCHIVE_PERIOD_NS = 6n * 3600n * 1_000_000_000n;

export interface ArchiveScheduleState {
  lastArchivedAtNs: bigint | null;
}

/** Decides whether an archive job is due for one live bet right now.
 * True on every status-change "trigger" call (caller passes
 * `isTrigger: true` right after noticing the bet became live / changed
 * status) and otherwise every `ARCHIVE_PERIOD_NS` while live. Pure --
 * no I/O, no OutLayer call, easily unit tested against fabricated Bet
 * fixtures. */
export function isArchiveJobDue(bet: Bet, state: ArchiveScheduleState, nowNs: bigint, isTrigger = false): boolean {
  if (!isBetLive(bet)) return false;
  if (isTrigger) return true;
  if (state.lastArchivedAtNs === null) return true;
  return nowNs - state.lastArchivedAtNs >= ARCHIVE_PERIOD_NS;
}

/** Runs the resolver's "archive" OutLayer job (a test double here; a
 * real OutLayer `request_execution` call in production) and returns
 * whatever resolver-signed snapshots came back, plus any sources that
 * failed/were blocked (never signed, never archived).
 *
 * D-ATTEST1 (7g4): the job carries ONLY the bet id and the RAW term sheet.
 * The wasm derives terms_hash, the list of urls (the term sheet's own
 * `sources_allowed`) and `captured_at` (its own clock) -- the keeper can no
 * longer (and must not try to) choose any of them. */
export interface ArchiveJobClient {
  runArchiveJob(betId: string, rawTerms: string, contractId?: string): Promise<{
    snapshots: ArchiveSnapshot[];
    failed: Array<{ id: string; reason: string }>;
    /** MON4b: raw OutLayer output (for run_diagnostics); optional. */
    raw?: unknown;
  }>;
}

/** Manifest of everything stored for one bet (LH3 (d)): one small file a
 * party can submit as a SINGLE exhibit, identified by its own sha256. */
export interface ArchiveManifest {
  bet_id: string;
  terms_hash: string;
  snapshots: Array<{ source_id: string; sha256: string; captured_at: string }>;
}

/** Snapshot store. With `dir` it is file-backed (one JSON file per bet,
 * atomic replace) so snapshots survive a keeper restart; without it, a
 * plain in-memory Map (unit tests). */
export class ArchiveStore {
  private byBet = new Map<string, ArchiveSnapshot[]>();
  readonly dir?: string;

  constructor(opts: { dir?: string } = {}) {
    this.dir = opts.dir;
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(betId: string, kind: "snapshots" | "manifest"): string {
    return path.join(this.dir!, `bet-${betId.replace(/[^A-Za-z0-9_.-]/g, "_")}.${kind}.json`);
  }

  private load(betId: string): ArchiveSnapshot[] {
    if (!this.dir) return this.byBet.get(betId) ?? [];
    const f = this.fileFor(betId, "snapshots");
    if (!fs.existsSync(f)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(f, "utf8"));
      return Array.isArray(raw?.snapshots) ? raw.snapshots : [];
    } catch {
      return []; // torn/corrupt file: treated as empty; verified snapshots are re-captured every 6h
    }
  }

  private save(betId: string, snaps: ArchiveSnapshot[]): void {
    if (!this.dir) {
      this.byBet.set(betId, snaps);
      return;
    }
    const f = this.fileFor(betId, "snapshots");
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ snapshots: snaps }, null, 2));
    fs.renameSync(tmp, f);
  }

  /** Verifies every returned snapshot against the contract's own
   * pinned `attest_pubkey` (D-KEY1: from the escrow contract's
   * `resolver_keys()` view -- NEVER a bet/envelope field) before
   * storing it -- a snapshot whose signature doesn't verify against
   * that pinned key (wrong key, including an old keeper key or a
   * self-consistent snapshot signed by some other key; tampered body;
   * wrong bet_id, or a terms_hash that is not the bet's own -- D-ATTEST1)
   * is dropped, never stored (memory or disk), never surfaced as
   * evidence. Returns the snapshots actually stored. */
  store(betId: string, pinnedAttestPubkeyHex: string, betTermsHash: string, snapshots: ArchiveSnapshot[]): ArchiveSnapshot[] {
    const kept = snapshots.filter(
      (s) => s.betId === betId && verifyArchiveSnapshotPinned(s, pinnedAttestPubkeyHex, betTermsHash),
    );
    const existing = this.load(betId);
    const same = (a: ArchiveSnapshot, b: ArchiveSnapshot) =>
      a.sourceId === b.sourceId && a.capturedAt === b.capturedAt && a.termsHash === b.termsHash && a.body === b.body;
    const merged = [...existing];
    for (const k of kept) if (!merged.some((m) => same(m, k))) merged.push(k);
    this.save(betId, merged);
    return kept;
  }

  get(betId: string): ArchiveSnapshot[] {
    return this.load(betId);
  }

  /** Builds the manifest for a bet (null if nothing is stored). Sorted
   * by (source_id, captured_at) so the bytes -- and hash -- are stable. */
  buildManifest(betId: string): ArchiveManifest | null {
    const snaps = this.load(betId);
    if (snaps.length === 0) return null;
    return {
      bet_id: betId,
      terms_hash: snaps[0].termsHash,
      snapshots: snaps
        .map((s) => ({ source_id: s.sourceId, sha256: sha256Hex(s.body), captured_at: s.capturedAt }))
        .sort((a, b) => (a.source_id + "|" + a.captured_at).localeCompare(b.source_id + "|" + b.captured_at)),
    };
  }

  /** Writes the manifest next to the snapshots and returns its path and
   * its OWN sha256 (over the exact file bytes) -- the single hash a party
   * submits as one exhibit. Needs a file-backed store; null if there is
   * nothing to describe. */
  writeManifest(betId: string): { path: string; sha256: string; manifest: ArchiveManifest } | null {
    if (!this.dir) throw new Error("writeManifest needs a file-backed ArchiveStore");
    const manifest = this.buildManifest(betId);
    if (!manifest) return null;
    const text = JSON.stringify(manifest, null, 2);
    const f = this.fileFor(betId, "manifest");
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, f);
    return { path: f, sha256: sha256Hex(text), manifest };
  }
}

/** Orchestrates one scheduled archive run for a live bet: calls the
 * resolver archive job, then stores only the snapshots that verify
 * against the contract's own pinned `attest_pubkey` (D-KEY1 --
 * `pinnedAttestPubkeyHex` must come from the escrow contract's
 * `resolver_keys()` view, never a bet/envelope field). Never signs
 * anything itself -- the keeper has no snapshot-signing key anymore
 * (D-FETCH1 part 3). */
export async function runScheduledArchive(
  client: ArchiveJobClient,
  store: ArchiveStore,
  betId: string,
  pinnedAttestPubkeyHex: string,
  betTermsHash: string,
  rawTerms: string,
  contractId?: string,
): Promise<{ stored: ArchiveSnapshot[]; failed: Array<{ id: string; reason: string }>; raw?: unknown }> {
  // D-ATTEST1: never feed the resolver a term sheet that is not the bet's.
  if (sha256Hex(rawTerms) !== (betTermsHash.startsWith("sha256:") ? betTermsHash.slice(7) : betTermsHash)) {
    throw new Error("archive job refused: sha256(rawTerms) does not match the bet's terms_hash");
  }
  const { snapshots, failed, raw } = await client.runArchiveJob(betId, rawTerms, contractId);
  const stored = store.store(betId, pinnedAttestPubkeyHex, betTermsHash, snapshots);
  return { stored, failed, raw };
}
