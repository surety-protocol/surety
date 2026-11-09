import { randomBytes } from "node:crypto";

export const SESSION_TTL_MS = 60 * 60 * 1000;

export function createSession(username) {
  return {
    username,
    token: randomBytes(16).toString("hex"),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
}
