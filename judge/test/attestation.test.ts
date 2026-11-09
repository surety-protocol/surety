import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { Wallet } from "ethers";
import {
  checkNearReport,
  parseOnlyVerifier,
  replayRtmr3,
  verifyPreflight,
  type AttestationBundle,
  type NearReport,
} from "../src/nearai/attestation.ts";
import { expectedProviderText, signatureValid, verifyResponseSignature } from "../src/nearai/signature.ts";

// A real report fetched from cloud-api.near.ai for z-ai/glm-5.3-flash with our own nonce.
const bundle = JSON.parse(readFileSync(new URL("./fixtures/attestation-report.glm-5.3-flash.json", import.meta.url), "utf8")) as AttestationBundle;
const NONCE = readFileSync(new URL("./fixtures/attestation-report.nonce", import.meta.url), "utf8").trim();
const MODEL = "z-ai/glm-5.3-flash";
const POLICY = { acceptedTcbStatuses: ["PARSE_ONLY_NOT_VERIFIED"], requireGpuEvidence: false };
const gpuNonceOnly = async (payload: string, nonce: string) => {
  const p = JSON.parse(payload) as { nonce: string };
  if (p.nonce.toLowerCase() !== nonce.toLowerCase()) throw new Error("GPU nonce mismatch");
};
const clone = <T>(x: T): T => structuredClone(x);

test("real gateway report: every binding checks out", async () => {
  const r = await checkNearReport(bundle.gateway_attestation, NONCE, POLICY, parseOnlyVerifier, gpuNonceOnly);
  assert.equal(r.signing_algo, "ecdsa");
  assert.deepEqual(r.checks.slice(1, 5), [
    "debug mode off",
    "quote binds signer and our fresh nonce",
    "MRCONFIGID matches the measured app configuration",
    "RTMR3 event log replays to the quote",
  ]);
});

test("real model report: every binding checks out, GPU evidence carries our nonce", async () => {
  const pre = await verifyPreflight(bundle, MODEL, NONCE, POLICY, parseOnlyVerifier, gpuNonceOnly);
  assert.equal(pre.models.length, 1);
  assert.equal(pre.models[0]!.signing_address, bundle.model_attestations![0]!.signing_address);
  assert.equal(pre.models[0]!.gpu, "verified");
});

test("RTMR3 replay reproduces the value the gateway reports in tcb_info", () => {
  const g = bundle.gateway_attestation as NearReport & { info: { tcb_info: { rtmr3: string } } };
  assert.equal(replayRtmr3(g.event_log).toString("hex"), g.info.tcb_info.rtmr3);
});

test("a different nonce is rejected (stale or replayed evidence)", async () => {
  await assert.rejects(checkNearReport(bundle.gateway_attestation, "00".repeat(32), POLICY, parseOnlyVerifier, gpuNonceOnly), /nonce/);
});

test("a swapped signing address is rejected", async () => {
  const r = clone(bundle.gateway_attestation);
  r.signing_address = "0x" + "11".repeat(20);
  await assert.rejects(checkNearReport(r, NONCE, POLICY, parseOnlyVerifier, gpuNonceOnly), /bind the signer/);
});

test("a tampered app configuration is rejected", async () => {
  const r = clone(bundle.gateway_attestation) as NearReport & { info: { tcb_info: { app_compose: string } } };
  r.info.tcb_info.app_compose += " ";
  await assert.rejects(checkNearReport(r, NONCE, POLICY, parseOnlyVerifier, gpuNonceOnly), /MRCONFIGID/);
});

test("a tampered event log is rejected", async () => {
  const r = clone(bundle.gateway_attestation);
  const log = JSON.parse(r.event_log as string) as { imr: number; event: string; event_payload: string; digest: string }[];
  const e = log.find((x) => x.imr === 3)!;
  e.event_payload = "00" + e.event_payload;
  e.digest = "";
  r.event_log = JSON.stringify(log);
  await assert.rejects(checkNearReport(r, NONCE, POLICY, parseOnlyVerifier, gpuNonceOnly), /RTMR3/);
});

test("TCB status outside the policy is rejected", async () => {
  await assert.rejects(checkNearReport(bundle.gateway_attestation, NONCE, { acceptedTcbStatuses: ["UpToDate"], requireGpuEvidence: false }, parseOnlyVerifier, null), /TCB status/);
});

test("model evidence for a different model is rejected", async () => {
  await assert.rejects(verifyPreflight(bundle, "some/other-model", NONCE, POLICY, parseOnlyVerifier, gpuNonceOnly), /not some\/other-model/);
});

test("missing model evidence is rejected", async () => {
  await assert.rejects(verifyPreflight({ gateway_attestation: bundle.gateway_attestation }, MODEL, NONCE, POLICY, parseOnlyVerifier, gpuNonceOnly), /no NEAR model evidence/);
});

test("GPU evidence without a GPU verifier is rejected", async () => {
  await assert.rejects(verifyPreflight(bundle, MODEL, NONCE, POLICY, parseOnlyVerifier, null), /GPU/);
});

// ---- response signatures ----

const req = Buffer.from('{"model":"m","messages":[]}');
const res = Buffer.from('{"id":"chat-1","choices":[]}');

test("ecdsa (EIP-191) provider_tee signature verifies and must match exactly one verified report", async () => {
  const w = Wallet.createRandom();
  const text = expectedProviderText("m", req, res);
  const signature = await w.signMessage(text);
  const sig = { text, signature, signing_address: w.address, signing_algo: "ecdsa", signature_kind: "provider_tee" };
  const report = { signing_address: w.address.toLowerCase(), signing_algo: "ecdsa", tcb_status: "x", advisory_ids: [], gpu: "verified" as const, checks: [] };
  assert.deepEqual(verifyResponseSignature(sig, "m", req, res, [report]), { ok: true });
  assert.equal(verifyResponseSignature(sig, "m", req, res, []).ok, false, "no matching report");
  assert.equal(verifyResponseSignature(sig, "m", req, res, [report, report]).ok, false, "ambiguous match");
  assert.equal(verifyResponseSignature(sig, "m", req, Buffer.from(res.toString() + " "), [report]).ok, false, "one changed byte");
  assert.equal(verifyResponseSignature(sig, "other", req, res, [report]).ok, false, "different model id");
  assert.equal(verifyResponseSignature({ ...sig, signature_kind: "gateway" }, "m", req, res, [report]).ok, false, "gateway kind");
  const other = Wallet.createRandom();
  assert.equal(verifyResponseSignature({ ...sig, signature: await other.signMessage(text) }, "m", req, res, [report]).ok, false, "wrong signer");
});

test("ed25519 signatures verify", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const sig = edSign(null, Buffer.from("hello"), privateKey).toString("hex");
  assert.equal(signatureValid("hello", sig, raw, "ed25519"), true);
  assert.equal(signatureValid("hellO", sig, raw, "ed25519"), false);
  assert.equal(signatureValid("hello", sig, raw, "rsa"), false);
});
