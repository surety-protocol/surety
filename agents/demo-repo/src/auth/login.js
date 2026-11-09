import { createHash } from "node:crypto";
import { createSession } from "../session.js";

export const MAX_ATTEMPTS = 5;

export class AuthError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function hashPassword(password) {
  return createHash("sha256").update(password).digest("hex");
}

/** users: Map of username -> password hash */
export function createAuth(users) {
  const failures = new Map();

  return {
    login(username, password) {
      if ((failures.get(username) ?? 0) >= MAX_ATTEMPTS) {
        throw new AuthError("LOCKED", "account locked after too many failed attempts");
      }
      const expected = users.get(username);
      if (password && hashPassword(password) !== expected) {
        failures.set(username, (failures.get(username) ?? 0) + 1);
        throw new AuthError("BAD_PASSWORD", "wrong password");
      }
      failures.delete(username);
      return createSession(username);
    },
  };
}
