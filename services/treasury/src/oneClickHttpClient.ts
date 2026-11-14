// D-ECON2 follow-up (2): real 1Click quote HTTP client.
//
// POST /v0/quote request/response shape per the public docs cited in
// src/oneClickClient.ts and README.md:
// https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote
// and https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request
// (auth: `Authorization: Bearer <JWT>`, JWT provisioned via the
// 1Click dashboard -- https://docs.near-intents.org/integration/distribution-channels/1click-api/authentication).
//
// This client ONLY ever sends dry:true quote requests -- it throws
// before touching fetch at all on a non-dry request. That is a
// deliberate, structural choice, not just a test omission: actually
// submitting a swap (a real deposit against a quote's depositAddress)
// is unimplemented here and stays that way regardless of any env
// flag, satisfying "executing a real swap stays
// unimplemented-to-network" at the client level, independent of
// src/treasuryJob.ts's own liveModeEnabled() gate.
//
// The JWT (ONECLICK_API_KEY) is read once from env (or an injected
// override, for tests) and used ONLY as the Authorization header
// value -- never logged, never included in any thrown error message,
// never serialized into the request body.
import type { OneClickClient, OneClickQuoteRequest, OneClickQuoteResponse } from "./oneClickClient.js";

export const DEFAULT_ONECLICK_BASE_URL = "https://1click.chaindefuser.com";

export interface HttpOneClickClientOptions {
  baseUrl?: string;
  /** Defaults to process.env.ONECLICK_API_KEY. Never logged. */
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export class HttpOneClickClient implements OneClickClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HttpOneClickClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_ONECLICK_BASE_URL).replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env.ONECLICK_API_KEY;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async getQuote(req: OneClickQuoteRequest): Promise<OneClickQuoteResponse> {
    if (req.dry !== true) {
      // Structural refusal -- never even reaches fetch. Live swap
      // submission is unimplemented-to-network by design.
      throw new Error(
        "HttpOneClickClient refuses a non-dry quote request: submitting a real swap is unimplemented-to-network here",
      );
    }

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    const res = await this.fetchImpl(`${this.baseUrl}/v0/quote`, {
      method: "POST",
      headers,
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`1Click POST /v0/quote failed: HTTP ${res.status}${text ? ` - ${text}` : ""}`);
    }

    const body = (await res.json()) as any;
    if (!body?.quote) {
      throw new Error("1Click POST /v0/quote response is missing the 'quote' object");
    }
    return body as OneClickQuoteResponse;
  }
}
