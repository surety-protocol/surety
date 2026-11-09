// Response signatures, per https://docs.near.ai/cloud/verification/cloud-api/response-signatures

import { createPublicKey, verify as edVerify } from "node:crypto";
import { verifyMessage } from "ethers";
import { sha256Hex } from "@surety/shared/hash";
import type { CheckedReport } from "./attestation.ts";

export interface SignatureRecord {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

/** provider_tee: "<MODEL_ID>:<request_hash>:<response_hash>" over the exact bytes. */
export function expectedProviderText(model: string, requestBytes: Uint8Array, responseBytes: Uint8Array): string {
  return `${model}:${sha256Hex(requestBytes)}:${sha256Hex(responseBytes)}`;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** True if `signature` over `text` was made by `address` under `algo`. */
export function signatureValid(text: string, signature: string, address: string, algo: string): boolean {
  try {
    if (algo === "ecdsa") {
      const sig = signature.startsWith("0x") ? signature : `0x${signature}`;
      return verifyMessage(text, sig).toLowerCase() === address.toLowerCase();
    }
    if (algo === "ed25519") {
      const pub = Buffer.from(address.replace(/^0x/, ""), "hex");
      if (pub.length !== 32) return false;
      const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, pub]), format: "der", type: "spki" });
      return edVerify(null, Buffer.from(text, "utf8"), key, Buffer.from(signature.replace(/^0x/, ""), "hex"));
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Accept a completion only if: the signature is provider_tee, its text matches
 * our exact bytes, it is valid, and its signer matches exactly one verified
 * model report (same address and algorithm).
 */
export function verifyResponseSignature(
  sig: SignatureRecord,
  model: string,
  requestBytes: Uint8Array,
  responseBytes: Uint8Array,
  verifiedModels: CheckedReport[],
): { ok: true } | { ok: false; reason: string } {
  if (sig.signature_kind !== "provider_tee") return { ok: false, reason: `signature kind is ${sig.signature_kind ?? "missing"}, need provider_tee` };
  const expected = expectedProviderText(model, requestBytes, responseBytes);
  if (sig.text !== expected) return { ok: false, reason: "signed text does not match our exact request and response bytes" };
  if (!signatureValid(sig.text, sig.signature, sig.signing_address, sig.signing_algo)) return { ok: false, reason: "signature is not valid for the stated signer" };
  const matches = verifiedModels.filter(
    (m) => m.signing_algo === sig.signing_algo && m.signing_address.toLowerCase() === sig.signing_address.toLowerCase(),
  );
  if (matches.length !== 1) return { ok: false, reason: `signer matches ${matches.length} verified model reports, need exactly 1` };
  return { ok: true };
}
