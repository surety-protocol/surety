// Verifies NEAR AI Cloud attestation reports, following
// https://docs.near.ai/cloud/verification/reference/quote-nonce-signer and
// https://docs.near.ai/cloud/verification/cloud-api/model-attestations
//
// For every report (gateway and each model candidate) we check:
//   1. the Intel TDX quote verifies (dcap-qvl) with an accepted TCB status
//   2. debug mode is off
//   3. quote report data = signing identity (padded) || our nonce, and the echoed nonce matches
//   4. MRCONFIGID = 0x01 || sha256(app_compose) || 15 zero bytes
//   5. replaying the RTMR3 event log reproduces the quote's RTMR3
//   6. GPU evidence, when present, is accepted by NVIDIA NRAS with our nonce

import { createHash } from "node:crypto";
import { getCollateralAndVerify, Quote } from "@phala/dcap-qvl";

const hexBytes = (v: string) => Buffer.from(v.replace(/^0x/i, ""), "hex");
const parse = <T>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;
const hash = (alg: string, ...parts: (Buffer | string)[]) => {
  const h = createHash(alg);
  for (const p of parts) h.update(p);
  return h.digest();
};

export interface QuoteFields {
  tdAttributes: Uint8Array;
  reportData: Uint8Array;
  mrConfigId: Uint8Array;
  rtMr3: Uint8Array;
}

export interface VerifiedQuote {
  status: string;
  advisoryIds: string[];
  fields: QuoteFields;
}

/** Verifies a raw TDX quote and returns its measured fields. */
export type QuoteVerifier = (quote: Buffer) => Promise<VerifiedQuote>;

/** Production verifier: full Intel DCAP verification with collateral from Intel PCS. */
export const dcapVerifier: QuoteVerifier = async (quote) => {
  const v = (await getCollateralAndVerify(quote)) as unknown as {
    status: string;
    advisory_ids?: string[];
    report: { type: string; data: QuoteFields };
  };
  if (v.report.type !== "td10") throw new Error("expected a TDX (td10) quote");
  return { status: v.status, advisoryIds: v.advisory_ids ?? [], fields: v.report.data };
};

/**
 * TEST ONLY: parses the quote without checking Intel's signatures. Lets the
 * offline tests check every binding on a real report. Never use in production.
 */
export const parseOnlyVerifier: QuoteVerifier = async (quote) => {
  const q = Quote.parse(quote) as unknown as { report: { type: string; data: QuoteFields } };
  if (q.report.type !== "td10") throw new Error("expected a TDX (td10) quote");
  return { status: "PARSE_ONLY_NOT_VERIFIED", advisoryIds: [], fields: q.report.data };
};

export interface EventLogEntry {
  imr: number;
  event_type: number;
  digest?: string;
  event: string;
  event_payload?: string;
}

/** RTMR3 replay exactly as the NEAR docs describe. */
export function replayRtmr3(eventLog: unknown): Buffer {
  let rtmr3 = Buffer.alloc(48);
  for (const e of parse<EventLogEntry[]>(eventLog)) {
    if (e.imr !== 3) continue;
    const type = Buffer.alloc(4);
    type.writeUInt32LE(e.event_type);
    const digest = hash("sha384", type, ":", Buffer.from(e.event, "utf8"), ":", hexBytes(e.event_payload ?? ""));
    if (e.digest && !hexBytes(e.digest).equals(digest)) throw new Error(`event log digest mismatch for event ${e.event}`);
    rtmr3 = hash("sha384", rtmr3, digest);
  }
  return rtmr3;
}

export interface NearReport {
  model_name?: string;
  signing_address: string;
  signing_algo: string;
  intel_quote: string;
  event_log: unknown;
  request_nonce: string;
  tls_cert_fingerprint?: string;
  nvidia_payload?: string;
  info: { tcb_info: unknown };
}

export interface AttestationPolicy {
  acceptedTcbStatuses: string[];
  /** Require GPU evidence to be present and accepted (model reports only). */
  requireGpuEvidence: boolean;
}

export const DEFAULT_POLICY: AttestationPolicy = {
  acceptedTcbStatuses: ["UpToDate"],
  requireGpuEvidence: true,
};

export interface CheckedReport {
  signing_address: string;
  signing_algo: string;
  tcb_status: string;
  advisory_ids: string[];
  gpu: "verified" | "absent";
  checks: string[];
}

export type GpuVerifier = (payloadJson: string, nonceHex: string) => Promise<void>;

/** NVIDIA NRAS: POST the decoded payload, require x-nvidia-overall-att-result === true. */
export function nrasGpuVerifier(fetcher: typeof fetch = fetch): GpuVerifier {
  return async (payloadJson, nonceHex) => {
    const payload = JSON.parse(payloadJson) as { nonce?: unknown };
    if (typeof payload.nonce !== "string" || payload.nonce.toLowerCase() !== nonceHex.toLowerCase()) {
      throw new Error("GPU evidence nonce does not match our nonce");
    }
    const res = await fetcher("https://nras.attestation.nvidia.com/v3/attest/gpu", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: payloadJson,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`NVIDIA NRAS rejected the GPU evidence (${res.status})`);
    const body = (await res.json()) as unknown[];
    const first = body?.[0] as unknown[] | undefined;
    if (!Array.isArray(first) || first[0] !== "JWT" || typeof first[1] !== "string") throw new Error("NRAS answer has no JWT");
    const claims = JSON.parse(Buffer.from(first[1].split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    if (claims["x-nvidia-overall-att-result"] !== true) throw new Error("NRAS overall attestation result is not true");
  };
}

export async function checkNearReport(
  report: NearReport,
  nonceHex: string,
  policy: AttestationPolicy,
  verifyQuote: QuoteVerifier,
  verifyGpu: GpuVerifier | null,
): Promise<CheckedReport> {
  const checks: string[] = [];
  const v = await verifyQuote(hexBytes(report.intel_quote));
  if (!policy.acceptedTcbStatuses.includes(v.status)) {
    throw new Error(`TCB status ${v.status} not accepted (advisories: ${v.advisoryIds.join(", ") || "none"})`);
  }
  checks.push(`quote verified, TCB ${v.status}`);

  if ((v.fields.tdAttributes[0] ?? 0) & 1) throw new Error("TDX debug mode is enabled");
  checks.push("debug mode off");

  const identity = hexBytes(report.signing_address);
  const expectedLen = ({ ecdsa: 20, ed25519: 32 } as Record<string, number>)[report.signing_algo];
  if (expectedLen === undefined || identity.length !== expectedLen) throw new Error(`unsupported signing identity ${report.signing_algo}`);
  const bound = report.tls_cert_fingerprint
    ? hash("sha256", identity, hexBytes(report.tls_cert_fingerprint))
    : Buffer.concat([identity, Buffer.alloc(32 - identity.length)]);
  if (!Buffer.from(v.fields.reportData).equals(Buffer.concat([bound, hexBytes(nonceHex)]))) {
    throw new Error("quote report data does not bind the signer and our nonce");
  }
  if ((report.request_nonce ?? "").toLowerCase() !== nonceHex.toLowerCase()) throw new Error("echoed nonce does not match ours");
  checks.push("quote binds signer and our fresh nonce");

  const appCompose = parse<{ app_compose: string }>(report.info.tcb_info).app_compose;
  if (typeof appCompose !== "string") throw new Error("report has no app_compose");
  const expectedConfig = Buffer.concat([Buffer.from([1]), hash("sha256", Buffer.from(appCompose, "utf8")), Buffer.alloc(15)]);
  if (!Buffer.from(v.fields.mrConfigId).equals(expectedConfig)) throw new Error("MRCONFIGID does not match app_compose");
  checks.push("MRCONFIGID matches the measured app configuration");

  if (!replayRtmr3(report.event_log).equals(Buffer.from(v.fields.rtMr3))) throw new Error("event log does not replay to the quote's RTMR3");
  checks.push("RTMR3 event log replays to the quote");

  let gpu: "verified" | "absent" = "absent";
  if (report.nvidia_payload) {
    if (!verifyGpu) throw new Error("GPU evidence present but no GPU verifier configured");
    await verifyGpu(report.nvidia_payload, nonceHex);
    gpu = "verified";
    checks.push("NVIDIA GPU evidence accepted by NRAS");
  }

  return { signing_address: report.signing_address, signing_algo: report.signing_algo, tcb_status: v.status, advisory_ids: v.advisoryIds, gpu, checks };
}

export interface AttestationBundle {
  gateway_attestation: NearReport;
  model_attestations?: NearReport[];
}

export interface PreflightResult {
  nonce: string;
  gateway: CheckedReport;
  models: CheckedReport[];
}

/** Verify the gateway and every model candidate. Any failure rejects the whole preflight. */
export async function verifyPreflight(
  bundle: AttestationBundle,
  model: string,
  nonceHex: string,
  policy: AttestationPolicy,
  verifyQuote: QuoteVerifier,
  verifyGpu: GpuVerifier | null,
): Promise<PreflightResult> {
  const gateway = await checkNearReport(bundle.gateway_attestation, nonceHex, policy, verifyQuote, verifyGpu);
  const candidates = bundle.model_attestations ?? [];
  if (candidates.length === 0) throw new Error("no NEAR model evidence returned for this model");
  const models: CheckedReport[] = [];
  for (const c of candidates) {
    if (c.model_name && c.model_name !== model) throw new Error(`model evidence is for ${c.model_name}, not ${model}`);
    const checked = await checkNearReport(c, nonceHex, policy, verifyQuote, verifyGpu);
    if (policy.requireGpuEvidence && checked.gpu !== "verified") throw new Error("policy requires GPU evidence, none present");
    models.push(checked);
  }
  return { nonce: nonceHex, gateway, models };
}
