// A fake NEAR AI Cloud for tests. It serves attestation reports, completions and
// real secp256k1 (EIP-191) response signatures from per-model wallets, and can be
// told to misbehave in specific ways.
//
// The fake "intel_quote" is hex-encoded JSON of the quote fields; fakeQuoteVerifier
// decodes it. Everything else (nonce binding, MRCONFIGID, RTMR3 replay, signature
// recovery, signer matching) runs through the real verification code.

import { createHash } from "node:crypto";
import { Wallet, type HDNodeWallet } from "ethers";
import type { QuoteVerifier } from "../../src/nearai/attestation.ts";

export type Behaviour =
  | "honest" // answers from the evidence in the prompt
  | "always-pass"
  | "always-fail"
  | "bad-json-once" // first reply is not JSON, second is honest
  | "bad-json-always"
  | "long-reasoning" // reasons for ~2000 tokens first: cut off (no content) under a smaller max_tokens
  | "overloaded-once" // first completion gets 429 service_overloaded, then answers honestly
  | "overloaded-always" // every completion gets 429
  | "wrong-signature" // signs with another key
  | "tampered-response" // signs a different response body
  | "gateway-signature" // signature_kind "gateway"
  | "stale-nonce" // attestation echoes a different nonce
  | "no-model-evidence"
  | "debug-mode"
  | "http-500";

const sha256 = (s: Buffer | string) => createHash("sha256").update(s).digest();
const APP_COMPOSE = '{"name":"fake-dstack"}';

export function fakeQuote(fields: { reportData: Buffer; mrConfigId: Buffer; rtMr3: Buffer; debug?: boolean }): string {
  return Buffer.from(
    JSON.stringify({
      reportData: fields.reportData.toString("hex"),
      mrConfigId: fields.mrConfigId.toString("hex"),
      rtMr3: fields.rtMr3.toString("hex"),
      td: fields.debug ? "01" : "00",
    }),
  ).toString("hex");
}

export const fakeQuoteVerifier: QuoteVerifier = async (quote) => {
  const f = JSON.parse(quote.toString("utf8")) as Record<string, string>;
  return {
    status: "UpToDate",
    advisoryIds: [],
    fields: {
      reportData: Buffer.from(f.reportData!, "hex"),
      mrConfigId: Buffer.from(f.mrConfigId!, "hex"),
      rtMr3: Buffer.from(f.rtMr3!, "hex"),
      tdAttributes: Buffer.from(f.td!, "hex"),
    },
  };
};

export const fakeGpuVerifier = async (payload: string, nonce: string) => {
  if ((JSON.parse(payload) as { nonce: string }).nonce !== nonce) throw new Error("GPU nonce mismatch");
};

function report(wallet: HDNodeWallet, nonce: string, model: string | undefined, opts: { staleNonce?: boolean; debug?: boolean }) {
  const echoed = opts.staleNonce ? "ab".repeat(32) : nonce;
  const identity = Buffer.from(wallet.address.slice(2), "hex");
  const reportData = Buffer.concat([identity, Buffer.alloc(12), Buffer.from(echoed, "hex")]);
  const mrConfigId = Buffer.concat([Buffer.from([1]), sha256(APP_COMPOSE), Buffer.alloc(15)]);
  return {
    ...(model ? { model_name: model } : {}),
    signing_address: wallet.address.toLowerCase(),
    signing_algo: "ecdsa",
    intel_quote: fakeQuote({ reportData, mrConfigId, rtMr3: Buffer.alloc(48), debug: opts.debug }),
    event_log: "[]",
    request_nonce: echoed,
    info: { tcb_info: { app_compose: APP_COMPOSE } },
    ...(model ? { nvidia_payload: JSON.stringify({ nonce: echoed }) } : {}),
  };
}

export interface FakeNearAi {
  fetch: typeof fetch;
  calls: { completions: number; signatures: number; attestations: number };
  behaviour: Record<string, Behaviour>;
}

export function fakeNearAi(behaviour: Record<string, Behaviour>): FakeNearAi {
  const gateway = Wallet.createRandom();
  const wallets = new Map<string, HDNodeWallet>();
  const walletFor = (m: string) => wallets.get(m) ?? (wallets.set(m, Wallet.createRandom()), wallets.get(m)!);
  const completions = new Map<string, { model: string; req: Buffer; res: Buffer }>();
  const replies = new Map<string, number>();
  const overloads = new Map<string, number>();
  const calls = { completions: 0, signatures: 0, attestations: 0 };
  let counter = 0;

  const answer = (model: string, prompt: string): string => {
    const b = behaviour[model] ?? "honest";
    const n = (replies.get(model) ?? 0) + 1;
    replies.set(model, n);
    if (b === "bad-json-always" || (b === "bad-json-once" && n === 1)) return "I think it is probably fine.";
    let pass: boolean;
    // Misbehaving judges always vote pass, so tests prove an unverified pass is ignored.
    const adversarial: Behaviour[] = ["always-pass", "wrong-signature", "tampered-response", "gateway-signature", "stale-nonce", "no-model-evidence", "debug-mode"];
    if (adversarial.includes(b)) pass = true;
    else if (b === "always-fail") pass = false;
    else {
      const files = /Files changed by the patch: (.*)/.exec(prompt)?.[1] ?? "";
      const allowed = /Allowed paths: (.*)/.exec(prompt)?.[1]?.split(", ") ?? [];
      const inScope = files.split(", ").every((f) => allowed.some((a) => f.startsWith(a)));
      const testsOk = !/FAIL /.test(/Test results: (.*)/.exec(prompt)?.[1] ?? "");
      pass = /only files|under/i.test(prompt.split("QUESTION:")[1] ?? "") ? inScope : inScope && testsOk;
    }
    return `<think>checking</think>\n\`\`\`json\n${JSON.stringify({ pass, reason: pass ? "Looks correct and in scope." : "Out of scope or failing." })}\n\`\`\``;
  };

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/v1/, "");
    if (path === "/attestation/report") {
      calls.attestations++;
      const model = url.searchParams.get("model")!;
      const nonce = url.searchParams.get("nonce")!;
      const b = behaviour[model] ?? "honest";
      if (b === "http-500") return json({ error: "boom" }, 500);
      const opts = { staleNonce: b === "stale-nonce", debug: b === "debug-mode" };
      return json({
        gateway_attestation: report(gateway, nonce, undefined, {}),
        ...(b === "no-model-evidence" ? {} : { model_attestations: [report(walletFor(model), nonce, model, opts)] }),
      });
    }
    if (path === "/chat/completions") {
      calls.completions++;
      const req = Buffer.from(init!.body as Uint8Array);
      const body = JSON.parse(req.toString("utf8")) as { model: string; max_tokens?: number; messages: { content: string }[] };
      const ob = behaviour[body.model];
      const tries = (overloads.get(body.model) ?? 0) + 1;
      overloads.set(body.model, tries);
      if (ob === "overloaded-always" || (ob === "overloaded-once" && tries === 1)) {
        return json({ error: { message: "The service is temporarily overloaded. Please retry with exponential backoff.", type: "service_overloaded" } }, 429);
      }
      const id = `chatcmpl-${++counter}`;
      const cutOff = behaviour[body.model] === "long-reasoning" && (body.max_tokens ?? Infinity) < 2000;
      const choice = cutOff
        ? { index: 0, finish_reason: "length", message: { role: "assistant", content: null, reasoning_content: "Let me think about this carefully..." } }
        : { index: 0, finish_reason: "stop", message: { role: "assistant", content: answer(body.model, body.messages[1]!.content) } };
      const res = Buffer.from(JSON.stringify({ id, object: "chat.completion", choices: [choice] }));
      completions.set(id, { model: body.model, req, res });
      return new Response(res, { status: 200, headers: { "content-type": "application/json" } });
    }
    const sig = /^\/signature\/(.+)$/.exec(path);
    if (sig) {
      calls.signatures++;
      const c = completions.get(decodeURIComponent(sig[1]!));
      if (!c) return json({ error: "not found" }, 404);
      const b = behaviour[c.model] ?? "honest";
      const resBytes = b === "tampered-response" ? Buffer.concat([c.res, Buffer.from(" ")]) : c.res;
      const text = `${c.model}:${createHash("sha256").update(c.req).digest("hex")}:${createHash("sha256").update(resBytes).digest("hex")}`;
      const signer = b === "wrong-signature" ? Wallet.createRandom() : walletFor(c.model);
      return json({
        text,
        signature: await signer.signMessage(text),
        signing_address: walletFor(c.model).address,
        signing_algo: "ecdsa",
        signature_kind: b === "gateway-signature" ? "gateway" : "provider_tee",
      });
    }
    return json({ error: `unexpected ${path}` }, 404);
  }) as typeof fetch;

  return { fetch: f, calls, behaviour };
}

export const MODELS = ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B"];
