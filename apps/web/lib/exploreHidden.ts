// CS1 (familiarcow, 2026-11-11): bets hidden from the site-wide Home sections (Explore Bets, In progress) on the TESTNET site.
// Config only: nothing is deleted, every hidden bet still opens by its URL and still shows in its own people's My Bets.
//
// The list is a build setting (VITE_EXPLORE_HIDDEN, e.g. "1-48"), set only by `npm run build:testnet`, and it applies only to
// the testnet build's own escrow contract: a mainnet build, another contract, a dev server or the mocked e2e build (whose
// fixture bets reuse ids 1-48) hide nothing.
//
// testnet frz3: bets 1-48 are pre-launch plumbing (LIVE1/LIVE5 drivers, NOKEY, DR9, KEEPLIVE, referee drills), opened by
// test scripts with placeholder terms. The CS1 case studies start at bet 49.
import { NETWORK } from "./network";
import { readBuildEnv, type EnvLike } from "./networkSelect";

const EMPTY: ReadonlySet<number> = new Set();
const MAX_RANGE = 100_000;

/** "1-3, 7,9-10" -> {1,2,3,7,9,10}. Any malformed part (or a reversed / huge range) makes the WHOLE list empty. */
export function parseIdList(raw: string | undefined): ReadonlySet<number> {
  if (!raw || !raw.trim()) return EMPTY;
  const out = new Set<number>();
  for (const part of raw.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return EMPTY;
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1 || b < a || b - a > MAX_RANGE) return EMPTY;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return out;
}

const cache = new Map<string, ReadonlySet<number>>();

/** The bet ids on `escrow` that Explore / In progress leave out (empty unless this is the testnet build's own escrow). */
export function exploreHidden(
  escrow: string,
  env: EnvLike = readBuildEnv(),
  net: { networkId: string; escrow: string } = NETWORK,
): ReadonlySet<number> {
  if (net.networkId !== "testnet" || escrow !== net.escrow) return EMPTY;
  const raw = env.VITE_EXPLORE_HIDDEN;
  if (!raw) return EMPTY;
  const key = `${escrow}|${raw}`;
  let s = cache.get(key);
  if (!s) cache.set(key, (s = parseIdList(raw)));
  return s;
}
