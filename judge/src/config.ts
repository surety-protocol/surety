import { NearAiClient } from "./nearai/client.ts";
import { dcapVerifier, nrasGpuVerifier, type AttestationPolicy } from "./nearai/attestation.ts";
import { NearAiPanel, OfflineRulePanel, type AiPanel } from "./ai-panel.ts";

/** NEAR-operated TEE models from three different labs (checked against GET /v1/models on 2026-11-09). */
export const DEFAULT_JUDGE_MODELS = ["deepseek-ai/DeepSeek-V4.1-Flash-1017", "z-ai/glm-5.3-flash", "Qwen/Qwen3.8-27B"];

export function list(v: string | undefined, fallback: string[]): string[] {
  const xs = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return xs.length ? xs : fallback;
}

export function policyFromEnv(env = process.env): AttestationPolicy {
  return {
    acceptedTcbStatuses: list(env.JUDGE_ACCEPTED_TCB, ["UpToDate"]),
    requireGpuEvidence: env.JUDGE_REQUIRE_GPU !== "0",
  };
}

export function panelFromEnv(env = process.env): AiPanel {
  const mode = env.JUDGE_AI_MODE ?? "nearai";
  if (mode === "offline") return new OfflineRulePanel(env.JUDGE_ALLOW_UNVERIFIED === "1");
  if (mode !== "nearai") throw new Error(`JUDGE_AI_MODE must be "nearai" or "offline", got ${mode}`);
  if (!env.NEARAI_API_KEY) throw new Error("NEARAI_API_KEY is required (or set JUDGE_AI_MODE=offline for local development)");
  const client = new NearAiClient(env.NEARAI_BASE_URL || "https://cloud-api.near.ai/v1", env.NEARAI_API_KEY);
  return new NearAiPanel({
    client,
    models: list(env.JUDGE_MODELS, DEFAULT_JUDGE_MODELS),
    policy: policyFromEnv(env),
    verifyQuote: dcapVerifier,
    verifyGpu: nrasGpuVerifier(),
  });
}
