// TPL1 (D-PM3): the coin picker on the two price bets and the city picker on the weather bet. Both are a search box over a native
// <select> (the platform picker on phones; the select keeps its value = the symbol / station code, so the bet data is unchanged).
import React, { useEffect, useState } from "react";
import { TextField } from "../ui";
import { FALLBACK_ASSETS, fetchAssetPrice, formatUsdPrice, loadMarketAssets, searchAssets, type MarketAsset } from "../../lib/marketAssets";
import { assetDeciderText, assetVenuesText } from "../../lib/assetPriceSheet";
import { NWS_CITIES, NWS_CLIMATE_DAY_LINE, NWS_MEASURED_LINE, cityLabel, searchCities } from "../../lib/nwsCities";

const BLOCK = { display: "block", margin: "6px 0" } as const;
const SMALL = { display: "block" } as const;
const store = () => { try { return window.localStorage; } catch { return null; } };
const get = (u: string) => fetch(u);

/** `tid` prefixes the test ids ("asset" -> asset-picker, asset-search, guided-asset, ...). "Which outperforms?" uses two pickers
 *  ("asset-a", "asset-b") with their own labels and shows one venues + decider line for the pair instead of one per coin. */
export function AssetPicker({ asset, onPick, label = "Coin", tid = "asset", perCoinLines = true }: {
  asset: MarketAsset | undefined; onPick: (a: MarketAsset) => void; label?: string; tid?: string; perCoinLines?: boolean;
}) {
  const [assets, setAssets] = useState<MarketAsset[]>(FALLBACK_ASSETS);
  const [q, setQ] = useState("");
  const [price, setPrice] = useState<number | null | undefined>(undefined); // undefined = loading
  const cur = asset ?? FALLBACK_ASSETS[0];
  useEffect(() => {
    let live = true;
    loadMarketAssets({ fetch: get, storage: store(), nowMs: Date.now() }).then((r) => { if (live) setAssets(r.assets); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    setPrice(undefined);
    fetchAssetPrice(cur, get).then((p) => { if (live) setPrice(p); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur.symbol]);
  const shown = searchAssets(assets, q);
  const options = shown.some((a) => a.symbol === cur.symbol) ? shown : [cur, ...shown];
  const pickFirst = (list: MarketAsset[], v: string) => {
    const r = searchAssets(list, v);
    if (v.trim() && r.length && !r.some((a) => a.symbol === cur.symbol)) onPick(r[0]);
  };
  const search = (v: string) => { setQ(v); pickFirst(assets, v); };
  // A search typed before the live list arrived ran over the built-in list: run it again on the live list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { pickFirst(assets, q); }, [assets]);
  return (
    <div data-testid={`${tid}-picker`} style={BLOCK}>
      <label style={BLOCK}>
        <span>{label}</span>{" "}
        <TextField label={`Search coins: ${label}`} hideLabel type="search" data-testid={`${tid}-search`} placeholder="Search: ETH, Zcash, NEAR..." value={q} onChange={(e) => search(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} />
      </label>
      <select aria-label={label} data-testid={`guided-${tid}`} value={cur.symbol} onChange={(e) => { const a = assets.find((x) => x.symbol === e.target.value); if (a) onPick(a); }}>
        {options.map((a) => (<option key={a.symbol} value={a.symbol}>{a.name === a.symbol ? a.symbol : `${a.name} (${a.symbol})`}</option>))}
      </select>
      {q.trim() !== "" && shown.length === 0 && <small data-testid={`${tid}-no-match`} style={SMALL}>No listed coin matches "{q.trim()}".</small>}
      <small data-testid={`${tid}-price`} style={SMALL}>
        {price === undefined ? "Loading the live price..." : price === null ? "Live price unavailable right now." : `Now about ${formatUsdPrice(price)} (the middle of the exchanges' prices right now)`}
      </small>
      {perCoinLines && <small data-testid={`${tid}-venues`} style={SMALL}>{assetVenuesText(cur)}</small>}
      {perCoinLines && <small data-testid={`${tid}-decider`} style={SMALL}>{assetDeciderText(cur)}</small>}
    </div>
  );
}

export function CityPicker({ value, onChange }: { value: string; onChange: (code: string) => void }) {
  const [q, setQ] = useState("");
  const shown = searchCities(q);
  const options = value && !shown.some((c) => c.code === value) ? [...NWS_CITIES.filter((c) => c.code === value), ...shown] : shown;
  const search = (v: string) => {
    setQ(v);
    const r = searchCities(v);
    if (v.trim() && r.length && !r.some((c) => c.code === value)) onChange(r[0].code);
  };
  return (
    <div data-testid="city-picker" style={BLOCK}>
      <label style={BLOCK}>
        <span>City</span>{" "}
        <TextField label="Search cities" hideLabel type="search" data-testid="city-search" placeholder="Search: Chicago, Boston, Texas..." value={q} onChange={(e) => search(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <select aria-label="City" data-testid="guided-station" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">choose...</option>
        {options.map((c) => (<option key={c.code} value={c.code}>{c.label}</option>))}
      </select>
      {q.trim() !== "" && shown.length === 0 && <small data-testid="city-no-match" style={SMALL}>No city matches "{q.trim()}". These are the {NWS_CITIES.length} cities we can check.</small>}
      <small data-testid="nws-measured" style={SMALL}>{NWS_MEASURED_LINE}</small>
      <small data-testid="nws-climate-day" style={SMALL}>{NWS_CLIMATE_DAY_LINE}</small>
      {value && (
        <details data-testid="nws-station-details" style={{ fontSize: "0.8em" }}>
          <summary>Details</summary>
          National Weather Service station {value}: its official daily climate report for {cityLabel(value)} decides the bet.
        </details>
      )}
    </div>
  );
}
