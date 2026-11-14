// Copies the committed judge receipts (receipts/<job_id>/*) into web/public/receipts
// so the hosted dashboard can show every check, vote and attestation receipt
// without the judge service. Only files tracked by git are copied: offline dry-run
// receipts (marked UNVERIFIED) are never committed, so they never ship.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "web", "public", "receipts");
rmSync(out, { recursive: true, force: true });
const files = execFileSync("git", ["ls-files", "receipts"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter((f) => /^receipts\/\d+\/[^/]+$/.test(f));
for (const f of files) {
  const dest = join(out, f.slice("receipts/".length));
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(root, f), dest);
}
console.log(`copied ${files.length} receipt files to web/public/receipts`);
