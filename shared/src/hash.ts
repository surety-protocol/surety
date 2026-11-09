import { createHash } from "node:crypto";

/** SHA-256 of the exact bytes, lowercase hex (SPEC section 1). */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function isSha256Hex(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}
