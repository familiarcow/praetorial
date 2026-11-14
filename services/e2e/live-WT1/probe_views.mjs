import { viewFunction } from "../../../apps/web/lib/rpc";
const e = process.argv[2];
for (const m of ["protocol_fee_bps", "asset_limits", "get_asset_limits", "limits", "is_paused", "is_shutdown", "open_offers"]) {
  try { console.log(m, JSON.stringify(await viewFunction(e, m, m === "open_offers" ? { from: 0, limit: 5 } : {})).slice(0, 400)); }
  catch (err) { console.log(m, "ERR", String(err.message).slice(0, 120)); }
}
