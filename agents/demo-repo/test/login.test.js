import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuth, hashPassword } from "../src/auth/login.js";

const users = () => new Map([["ada", hashPassword("correct horse")]]);

test("rejects empty password", () => {
  const auth = createAuth(users());
  assert.throws(() => auth.login("ada", ""));
});

test("accepts valid password", () => {
  const auth = createAuth(users());
  const session = auth.login("ada", "correct horse");
  assert.equal(session.username, "ada");
});

test("returns EMPTY_PASSWORD code", () => {
  const auth = createAuth(users());
  assert.throws(() => auth.login("ada", ""), (e) => e.code === "EMPTY_PASSWORD");
});

test("locks after 5 failed attempts", () => {
  const auth = createAuth(users());
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login("ada", "wrong"));
  assert.throws(() => auth.login("ada", "correct horse"), (e) => e.code === "LOCKED");
});
