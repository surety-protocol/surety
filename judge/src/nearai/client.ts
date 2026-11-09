// Minimal NEAR AI Cloud client that keeps the exact request and response bytes,
// as signature verification requires.

import type { AttestationBundle } from "./attestation.ts";
import type { SignatureRecord } from "./signature.ts";

export type Fetcher = typeof fetch;

export interface RawCompletion {
  requestBytes: Buffer;
  responseBytes: Buffer;
  json: { id?: string; choices?: { message?: { content?: string | null; reasoning_content?: string | null } }[] };
}

export class NearAiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NearAiError";
  }
}

export class NearAiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    private readonly fetcher: Fetcher = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** No API key needed for NEAR-operated models. */
  async attestationReport(model: string, nonceHex: string, signingAlgo = "ecdsa"): Promise<AttestationBundle> {
    const q = new URLSearchParams({ model, provider: "near", include_tls_fingerprint: "false", signing_algo: signingAlgo, nonce: nonceHex });
    const res = await this.fetcher(`${this.baseUrl}/attestation/report?${q}`, {
      headers: { Accept: "application/json", "x-no-aliasing": "true" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new NearAiError(`attestation report failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as AttestationBundle;
  }

  async chatCompletion(body: Record<string, unknown>): Promise<RawCompletion> {
    if (!this.apiKey) throw new NearAiError("NEARAI_API_KEY is not set");
    const requestBytes = Buffer.from(JSON.stringify(body), "utf8");
    const res = await this.fetcher(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Encoding": "identity",
        "x-no-aliasing": "true",
      },
      body: requestBytes,
      signal: AbortSignal.timeout(120_000),
    });
    const responseBytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new NearAiError(`completion failed (${res.status}): ${responseBytes.toString("utf8").slice(0, 300)}`);
    let json: RawCompletion["json"];
    try {
      json = JSON.parse(responseBytes.toString("utf8"));
    } catch {
      throw new NearAiError("completion response is not JSON");
    }
    return { requestBytes, responseBytes, json };
  }

  /** Fetch a response signature; 404 or an error body is retried for a short, bounded time. */
  async signature(chatId: string, signingAlgo = "ecdsa", attempts = 6): Promise<SignatureRecord> {
    if (!this.apiKey) throw new NearAiError("NEARAI_API_KEY is not set");
    let last = "";
    for (let i = 0; i < attempts; i++) {
      const res = await this.fetcher(`${this.baseUrl}/signature/${encodeURIComponent(chatId)}?signing_algo=${signingAlgo}`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        const body = (await res.json()) as Partial<SignatureRecord> & { error_code?: string; message?: string };
        if (body.signature && body.text && body.signing_address) return body as SignatureRecord;
        last = `unavailable: ${body.error_code ?? ""} ${body.message ?? ""}`.trim();
      } else if (res.status === 404) {
        last = "not found yet";
      } else {
        throw new NearAiError(`signature request failed (${res.status})`);
      }
      if (i < attempts - 1) await this.sleep(1000 * (i + 1));
    }
    throw new NearAiError(`no signature for ${chatId}: ${last}`);
  }
}
