// NAV1 (UX-31 Wallet, "Use asset logo"): small asset marks bundled with the app (vite inlines or fingerprints them; never hotlinked).
import usdc from "./usdc.svg";
import usdt from "./usdt.svg";
import near from "./near.svg";
import btc from "./btc.svg";
import eth from "./eth.svg";
import zec from "./zec.svg";

export const ASSET_LOGOS: Record<string, string> = { USDC: usdc, USDT: usdt, NEAR: near, BTC: btc, ETH: eth, ZEC: zec };
