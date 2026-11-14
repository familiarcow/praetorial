// Minimal typed surface of @playwright/test for DR6.live.spec.ts. `services` tsc cannot resolve @playwright/test
// (it is installed only under apps/web) and must not include apps/web, so the package is loaded at runtime from
// apps/web via createRequire (same CJS instance the Playwright runner uses) and narrowed from `unknown` to the
// interfaces below. Only what the spec calls is declared.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Locator {
  click(): Promise<void>;
  fill(v: string): Promise<void>;
  check(): Promise<void>;
  selectOption(v: string): Promise<unknown>;
  textContent(): Promise<string | null>;
  inputValue(): Promise<string>;
  isVisible(): Promise<boolean>;
  locator(sel: string): Locator;
  or(other: Locator): Locator;
  first(): Locator;
}
export interface RequestLike { url(): string; method(): string; failure(): { errorText: string } | null }
export interface ResponseLike { url(): string; status(): number; text(): Promise<string>; request(): RequestLike }
export interface DialogLike { message(): string; accept(): Promise<void> }
export interface Page {
  getByTestId(id: string): Locator;
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: () => unknown, arg?: undefined, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  on(ev: "response", cb: (r: ResponseLike) => void | Promise<void>): void;
  on(ev: "requestfailed", cb: (q: RequestLike) => void | Promise<void>): void;
  once(ev: "dialog", cb: (d: DialogLike) => void | Promise<void>): void;
}
export interface BrowserContext {
  newPage(): Promise<Page>;
  exposeBinding(name: string, cb: (source: unknown, ...args: never[]) => unknown): Promise<void>;
  addInitScript(script: string): Promise<void>;
}
export interface Browser { newContext(): Promise<BrowserContext> }
export interface Timeout { timeout?: number }
export interface LocatorAssertions {
  toBeVisible(o?: Timeout): Promise<void>;
  toBeEnabled(o?: Timeout): Promise<void>;
  toBeHidden(o?: Timeout): Promise<void>;
  toContainText(t: string, o?: Timeout): Promise<void>;
  toHaveAttribute(n: string, v: string, o?: Timeout): Promise<void>;
}
export interface ValueAssertions {
  toBe(v: unknown): void;
  toEqual(v: unknown): void;
  toContain(v: unknown): void;
  toMatch(re: RegExp): void;
}
export interface Expect { (target: Locator): LocatorAssertions; (target: unknown): ValueAssertions }
export interface TestFn {
  (name: string, body: (fixtures: { browser: Browser }) => Promise<void>): void;
  setTimeout(ms: number): void;
}

const isRec = (v: unknown): v is Record<string, unknown> => (typeof v === "object" || typeof v === "function") && v !== null;
const webPkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../apps/web/package.json");
const mod: unknown = createRequire(webPkg)("@playwright/test");
if (!isRec(mod) || typeof mod.test !== "function" || typeof mod.expect !== "function") throw new Error("@playwright/test (apps/web) did not export test/expect");

export const test = mod.test as TestFn;
export const expect = mod.expect as Expect;
