import { test } from "node:test";
import assert from "node:assert/strict";
import { createSession, SESSION_TTL_MS } from "../src/session.js";

test("existing session tests still pass", () => {
  const before = Date.now();
  const s = createSession("ada");
  assert.equal(s.username, "ada");
  assert.match(s.token, /^[0-9a-f]{32}$/);
  assert.ok(s.expiresAt >= before + SESSION_TTL_MS);
});
