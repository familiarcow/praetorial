// DR9 helper: top up the throwaway guardian from the keeper (storage-min balance was too tight for the 1 yocto call).
import { account, store, KEEPER, utils } from "./lib.mjs";
const { load, rec } = store("run/d34_results.json");
const k = await account(KEEPER); const r = await k.sendMoney(load().accounts.guardian, utils.format.parseNearAmount("0.1")); rec("topup_guardian_0.1_NEAR_from_keeper", r.transaction.hash);
