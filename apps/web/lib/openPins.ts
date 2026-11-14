// WT1b (b): the open flow refuses when the target escrow's pinned resolver (resolver_keys()[2], D-KEY1) is not
// the resolver release this web build was made for. `fetchKeys` is injectable so tests mock the view call.
import { pinnedKeysMismatch, loadReleaseConfig, type ReleaseConfig } from "./releaseConfig";

/** Returns an error message to show the user (and stop), or null when the open may proceed. */
export async function checkOpenPins(
  fetchKeys: () => Promise<string[]>,
  rel: ReleaseConfig = loadReleaseConfig(),
): Promise<string | null> {
  let keys: string[];
  try {
    keys = await fetchKeys();
  } catch (e) {
    return `could not read the escrow's pinned resolver keys (${String((e as any)?.message ?? e)}); refusing to open`;
  }
  return pinnedKeysMismatch(keys, rel);
}
