// Q1: the gate's own checks catch what they claim to (planted raw values and sideways overflow), and pass a clean screen.
import { test, expect } from "@playwright/test";
import { scanText, overflowAt, visibleText } from "./gate";

const HEX = "a1".repeat(32);

test.describe("gate self-test", () => {
  test("scanText flags every kind of raw value and lets formatted amounts through", () => {
    const rules = (t: string, allow: string[] = []) => scanText(t, allow).map((f) => f.rule);
    expect(rules("Pay nep141:wrap.near now")).toEqual(["asset id"]);
    expect(rules("1cs_v1:btc:native:coin")).toEqual(["asset id"]);
    expect(rules(`Account ${HEX}`)).toEqual(["raw account id (64-hex)"]);
    expect(rules(`Account ${HEX}`, [HEX])).toEqual([]);
    expect(rules("Taken by bob.near")).toEqual(["raw account id (.near/.testnet)"]);
    expect(rules("Escrow bets.praetorial.near")).toEqual(["raw account id (.near/.testnet)"]);
    expect(rules("From near.com")).toEqual([]);
    expect(rules("Send to 0x" + "ab".repeat(20))).toEqual(["raw address (0x)"]);
    expect(rules("Stake 25000000 USDC")).toEqual(["base units (bare integer >= 7 digits)"]);
    expect(rules("Stake 10000000000000000000000000")).toEqual(["base units (bare integer >= 7 digits)"]);
    expect(rules("Storage 0.001250000000000000000 NEAR")).toEqual(["base units (> 12 decimals)"]);
    // Inside an opened Details region raw ids and exact amounts are allowed; asset ids and bare base units are not.
    expect(scanText(`Maker bob.near ${HEX} fee 0.0000000000000000005 NEAR`, [], true)).toEqual([]);
    expect(scanText("nep141:wrap.near 25000000", [], true).map((f) => f.rule)).toEqual(["asset id", "base units (bare integer >= 7 digits)"]);
    expect(rules("Fee 1.2e-7 NEAR")).toEqual(["scientific notation"]);
    expect(rules("You get undefined USDC, NaN, [object Object]")).toEqual(["broken value", "broken value", "broken value"]);
    // Formatted values the app is meant to show.
    expect(rules("Stake 25.00 USDC · 1,250,000.00 USDC · 0.000025 BTC · 0.000243592 ETH · < 0.01 NEAR · Bet #203 · closes in 2 days · 2026-11-09 · 121,410.55")).toEqual([]);
  });

  test("overflowAt flags a page wider than 375, an element sticking out, and a dialog that scrolls sideways; a clean page passes", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.setContent(`<body style="margin:0"><p>fine</p></body>`);
    expect(await overflowAt(page)).toEqual([]);
    await page.setContent(`<body style="margin:0"><div data-testid="wide" style="width:500px">wide</div></body>`);
    expect((await overflowAt(page)).join("\n")).toMatch(/page scrollWidth 500 > 375[\s\S]*sticks out .*wide/);
    await page.setContent(`<body style="margin:0;overflow-x:hidden"><div style="width:375px;overflow:hidden"><span data-testid="cut" style="display:inline-block;width:600px">cut off</span></div></body>`);
    expect((await overflowAt(page)).join("\n")).toMatch(/sticks out .*\[data-testid=cut\]/);
    await page.setContent(`<body style="margin:0"><dialog open style="width:300px;margin:0;padding:0"><div data-testid="sheet" style="overflow-x:auto"><pre style="width:900px;margin:0">x</pre></div></dialog></body>`);
    expect((await overflowAt(page)).join("\n")).toMatch(/scrolls sideways .*\[data-testid=sheet\]/);
  });

  test("visibleText skips a closed <details> (the collapsed Account details row) and hidden nodes; splits off Details regions", async ({ page }) => {
    await page.setContent(`<body><p>@familiarcow</p><details><summary>Account details</summary>${HEX}</details><span hidden>nep141:wrap.near</span><section id="d">Maker bob.near</section></body>`);
    expect(scanText((await visibleText(page)).main).map((f) => f.rule)).toEqual(["raw account id (.near/.testnet)"]);
    const split = await visibleText(page, ["#d"]);
    expect(scanText(split.main)).toEqual([]);
    expect(split.details).toBe("Maker bob.near");
    await page.locator("summary").click();
    expect(scanText((await visibleText(page, ["#d"])).main).map((f) => f.rule)).toEqual(["raw account id (64-hex)"]);
  });
});
