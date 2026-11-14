// DR6FIX1: the loader lives in ONE place (harness/webConfig.ts, Playwright-loader-safe .ts file URLs); this re-export keeps
// `import { loadWebTestnetConfig } from "./webConfig.js"` in chain.ts and the scenario tests unchanged.
export { loadWebTestnetConfig, type WebTestnetConfig } from "../harness/webConfig.js";
