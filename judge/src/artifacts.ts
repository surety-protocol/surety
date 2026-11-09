// Loads job specs and patches by reference (SPEC §5): a repo-relative path, or
// an https URL once the repo is public. Everything here is untrusted input.

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { sha256Hex } from "@surety/shared/hash";
import type { JobSpec } from "@surety/shared/types";

export const MAX_ARTIFACT_BYTES = 1_000_000;

export class ArtifactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactError";
  }
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Resolve a repo-relative path and refuse anything that escapes the repo. */
export async function resolveInRepo(repoRoot: string, ref: string): Promise<string> {
  if (!ref || ref.includes("\0")) throw new ArtifactError("empty or invalid path");
  if (isAbsolute(ref) || /^[a-zA-Z]:/.test(ref)) throw new ArtifactError(`absolute paths are not allowed: ${ref}`);
  const root = await realpath(repoRoot);
  const target = resolve(root, ref);
  if (!inside(root, target)) throw new ArtifactError(`path escapes the repository: ${ref}`);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new ArtifactError(`not found: ${ref}`);
  }
  if (!inside(root, real)) throw new ArtifactError(`path escapes the repository via a link: ${ref}`);
  return real;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export async function loadArtifact(ref: string, repoRoot: string, fetcher: Fetcher = fetch): Promise<Buffer> {
  if (/^https:\/\//i.test(ref)) {
    const res = await fetcher(ref, { signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!res.ok) throw new ArtifactError(`download failed (${res.status}): ${ref}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ARTIFACT_BYTES) throw new ArtifactError(`artifact too large: ${ref}`);
    return buf;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) && !/^[a-zA-Z]:/.test(ref)) throw new ArtifactError(`only https URLs or repo paths are allowed: ${ref}`);
  const path = await resolveInRepo(repoRoot, ref);
  const buf = await readFile(path);
  if (buf.length > MAX_ARTIFACT_BYTES) throw new ArtifactError(`artifact too large: ${ref}`);
  return buf;
}

/** Only these test commands may run. The spec comes from the client, so no free-form shell. */
export const ALLOWED_TEST_COMMANDS = ["npm test", "npm test --silent"];

const relPath = z
  .string()
  .min(1)
  .refine((p) => !isAbsolute(p) && !p.split(/[\\/]/).includes(".."), "must be a relative path inside the repo");

const checkSchema = z.discriminatedUnion("type", [
  z.object({ id: z.string().min(1).max(32), type: z.literal("test"), name: z.string().min(1).max(200) }),
  z.object({ id: z.string().min(1).max(32), type: z.literal("ai"), question: z.string().min(5).max(500) }),
]);

export const jobSpecSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    repo_path: relPath,
    test_command: z.string().refine((c) => ALLOWED_TEST_COMMANDS.includes(c), `test_command must be one of: ${ALLOWED_TEST_COMMANDS.join(", ")}`),
    allowed_paths: z.array(z.string().min(1).max(200)).max(20),
    checks: z.array(checkSchema).min(1).max(30),
    min_score_bps: z.number().int().min(1).max(10_000),
  })
  .superRefine((s, ctx) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const c of s.checks) {
      if (ids.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate check id ${c.id}` });
      ids.add(c.id);
      if (c.type === "test") {
        if (names.has(c.name)) ctx.addIssue({ code: "custom", message: `duplicate test name ${c.name}` });
        names.add(c.name);
      }
    }
  });

export interface LoadedSpec {
  spec: JobSpec;
  bytes: Buffer;
  hash: string;
}

export async function loadSpec(ref: string, expectedHash: string, repoRoot: string, fetcher?: Fetcher): Promise<LoadedSpec> {
  const bytes = await loadArtifact(ref, repoRoot, fetcher);
  const hash = sha256Hex(bytes);
  if (hash !== expectedHash) throw new ArtifactError(`spec hash mismatch: on-chain ${expectedHash}, file ${hash}`);
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ArtifactError("spec is not valid JSON");
  }
  const parsed = jobSpecSchema.safeParse(raw);
  if (!parsed.success) throw new ArtifactError(`invalid spec: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return { spec: parsed.data as JobSpec, bytes, hash };
}

export async function loadPatch(ref: string, expectedHash: string, repoRoot: string, fetcher?: Fetcher): Promise<{ bytes: Buffer; hash: string }> {
  const bytes = await loadArtifact(ref, repoRoot, fetcher);
  const hash = sha256Hex(bytes);
  if (hash !== expectedHash) throw new ArtifactError(`patch hash mismatch: on-chain ${expectedHash}, file ${hash}`);
  return { bytes, hash };
}

/** Files touched by a unified diff, from its `diff --git a/X b/Y` headers (and ---/+++ for plain diffs). */
export function changedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const g = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (g) {
      files.add(g[1]!);
      files.add(g[2]!);
      continue;
    }
    const p = /^(?:---|\+\+\+) (?:[ab]\/)?(.+?)(?:\t.*)?$/.exec(line);
    if (p && p[1] !== "/dev/null") files.add(p[1]!);
  }
  files.delete("/dev/null");
  return [...files].sort();
}

/** True if every changed file sits under one of the allowed path prefixes. */
export function onlyAllowedPaths(files: string[], allowed: string[]): boolean {
  const norm = (p: string) => p.replaceAll("\\", "/");
  return files.every((f) => allowed.some((a) => norm(f).startsWith(norm(a))));
}

export { sep };
