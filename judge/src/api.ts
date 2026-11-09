// Demo HTTP API (SPEC §7). Holds no keys itself; signing happens through the chain client.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SuretyChain } from "@surety/shared/chain";
import { DemoRunner, RateLimitError } from "./demo.ts";

export interface ApiOptions {
  chain: SuretyChain;
  demo: DemoRunner;
  receiptsDir: string;
  /** Allowed browser origins for CORS; "*" allows any (local development only). */
  corsOrigins: string[];
}

const RECEIPT_FILE = /^(verdict|tests|judge-[A-Za-z0-9._-]+)\.json$/;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json", ...headers });
  res.end(text);
}

async function readJson(req: IncomingMessage, limit = 10_000): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export function createApi(o: ApiOptions): Server {
  return createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> = {};
    if (origin && (o.corsOrigins.includes("*") || o.corsOrigins.includes(origin))) {
      cors["access-control-allow-origin"] = o.corsOrigins.includes("*") ? "*" : origin;
      cors["access-control-allow-methods"] = "GET, POST, OPTIONS";
      cors["access-control-allow-headers"] = "content-type";
      cors["vary"] = "origin";
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "OPTIONS") return send(res, 204, "", cors);

      if (req.method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, contract_id: o.chain.contractId, token_id: o.chain.tokenId, demo_busy: o.demo.isBusy() }, cors);
      }

      if (req.method === "POST" && url.pathname === "/demo/run") {
        let body: { scenario?: unknown };
        try {
          body = (await readJson(req)) as { scenario?: unknown };
        } catch {
          return send(res, 400, { error: "invalid JSON body" }, cors);
        }
        if (body.scenario !== "sloppy" && body.scenario !== "honest" && body.scenario !== "cheater") {
          return send(res, 400, { error: 'scenario must be "sloppy", "honest" or "cheater"' }, cors);
        }
        try {
          const job_id = await o.demo.start(body.scenario);
          return send(res, 202, { job_id }, cors);
        } catch (e) {
          if (e instanceof RateLimitError) return send(res, 429, { error: e.message }, cors);
          throw e;
        }
      }

      const st = /^\/demo\/status\/(\d+)$/.exec(url.pathname);
      if (req.method === "GET" && st) {
        const s = await o.demo.status(Number(st[1]));
        if (!s.job) return send(res, 404, { error: "unknown job" }, cors);
        return send(res, 200, s, cors);
      }

      const rc = /^\/receipts\/(\d+)\/([^/]+)$/.exec(url.pathname);
      if (req.method === "GET" && rc) {
        const file = decodeURIComponent(rc[2]!);
        if (!RECEIPT_FILE.test(file)) return send(res, 400, { error: "bad receipt file name" }, cors);
        try {
          const bytes = await readFile(join(o.receiptsDir, rc[1]!, file));
          res.writeHead(200, { "content-type": "application/json", ...cors });
          return res.end(bytes);
        } catch {
          return send(res, 404, { error: "receipt not found" }, cors);
        }
      }

      return send(res, 404, { error: "not found" }, cors);
    } catch (e) {
      return send(res, 500, { error: (e as Error).message }, cors);
    }
  });
}
