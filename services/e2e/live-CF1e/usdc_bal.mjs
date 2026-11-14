// CF1e: maker mock-USDC balance + bet 1 status (read-only).
import { account } from "../live-FRZ1/lib.mjs";
const a = await account("maker1.praetorial-dev-1101.testnet");
console.log("maker usdc", await a.viewFunction({ contractId: "intents-mock.praetorial-dev-1101.testnet", methodName: "mt_balance_of", args: { account_id: a.accountId, token_id: "nep141:usdc.testnet" } }));
console.log("bet1", (await a.viewFunction({ contractId: "praetorial-frz1b-2611081810.praetorial-dev-1101.testnet", methodName: "get_bet", args: { bet_id: 1 } })).status);
