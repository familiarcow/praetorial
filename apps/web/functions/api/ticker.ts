// Production ticker proxy, shaped as a Cloudflare Pages Function
// (D-HOST1: Cloudflare free tier -- Pages + Functions for the ticker
// proxy). Cloudflare Pages auto-deploys any file under functions/ as a
// route matching its path, so this file serves GET /api/ticker. This
// task does NOT deploy anything -- it only makes the build deploy-ready.
// Same venue map/parser/fallback-chain as the dev proxy
// (lib/tickerVenues.ts) so dev and prod price checks never drift.
//
// GET /api/ticker?venue=coinbase|binance|bitstamp|kraken|gemini|okx|bybit
//   -> { venue, price } | { venue, error }
import { fetchVenuePrice } from "../../lib/tickerVenues";

// Cloudflare Pages Functions' onRequestGet receives a context with a
// standard Request; typed loosely here to avoid an @cloudflare/workers-types
// devDependency just for one handler signature.
export async function onRequestGet(context: { request: Request }): Promise<Response> {
  const url = new URL(context.request.url);
  const venue = url.searchParams.get("venue") ?? "";
  const { price, error } = await fetchVenuePrice(venue);
  if (error && price === null) {
    const status = error === "unknown venue" ? 400 : 502;
    return new Response(JSON.stringify({ venue, error }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ venue, price }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
