// LIVE1: the AI-judge attestation path on the live stack: a Coinbase BTC-USD touch bet (typed btc_touch template, AI
// mode, no referee) gets a REAL sourcecheck attestation from the deployed sourcecheck Worker and is opened through the
// deployed relayer; the bet is read back from the escrow. Prints JSON with every tx hash.
import { newAccount, mintIntents, openBet, USDC, ONE_USDC } from "./liveDriver";
import { buildTypedSheet } from "../../lib/templates";
import { fieldsFromForm } from "../../lib/guidedFields";

const deadline = new Date(Date.now() + 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/T\d\d:\d\d:\d\dZ$/, "T12:00:00Z");
// Built at open time: open_utc must be within 300s of the open clock (the app re-stamps it the same way, WT1d).
const mkSheet = () => buildTypedSheet("btc_touch", fieldsFromForm("btc_touch", { direction: "at_or_above", x_usd: "250000", deadline_utc: deadline } as any, Date.now()));
let sheet = mkSheet();
const maker = await newAccount("ai-maker", 0.5);
const mint = await mintIntents(maker, USDC, 12n * ONE_USDC);
const t0 = Date.now();
let r: any;
for (let attempt = 1; ; attempt++) {
  try { r = await openBet({ maker, asset: "USDC", stakeMaker: 10n * ONE_USDC, stakeTaker: 10n * ONE_USDC, referee: null, takerAccount: null, sheet, label: "btc-touch" } as any); break; }
  catch (e) { if (attempt < 4 && /OPEN_UTC_SKEW/.test(String((e as Error).message))) { sheet = mkSheet(); continue; } throw e; }
}
console.log(JSON.stringify({ step: "ai-judge-open", maker: maker.id, fundTx: maker.fundTx, mint, sheet: (sheet as any).template, deadline, ms: Date.now() - t0, result: r }, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
