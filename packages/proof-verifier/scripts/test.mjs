/**
 * Self-test, in two parts:
 *
 * 1. Determinism / freeze check — regenerates the corpus into a TEMP directory
 *    (never the tracked tree) and byte-compares every generated file against
 *    the committed vectors/. Any diff fails loudly: it means either the
 *    generator is no longer deterministic or a code change altered a vector
 *    without the corpus being regenerated and reviewed. External implementers
 *    pin the committed files by hash, so the corpus must never drift silently.
 *
 * 2. Conformance — runs every case in vectors/index.json through the verifier
 *    against the COMMITTED fixtures (including both pinKey cases against the
 *    committed instance-pubkey.pem) and asserts each verdict matches.
 *
 * The suite writes nothing into the repo; it asserts `git status` is unchanged.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { nodeCrypto } from "../src/node-crypto.js";
import { verifyBundle } from "../src/verify-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_DIR = join(HERE, "..", "vectors");
// Committed but not generated: the fixture signing key the generator READS.
const NON_GENERATED = new Set(["test-fixture-signing-key.pem"]);

const gitStatus = () => {
  try {
    return execFileSync("git", ["status", "--porcelain"], { cwd: HERE }).toString();
  } catch {
    return null; // not a git checkout (e.g. the published npm tarball)
  }
};
const statusBefore = gitStatus();

// ---- 1. Determinism: regenerate into a temp dir, byte-compare -------------
const tmp = mkdtempSync(join(tmpdir(), "aapr-vectors-"));
try {
  execFileSync("node", [join(HERE, "build-vectors.mjs"), tmp], { stdio: "inherit" });

  const generated = readdirSync(tmp).sort();
  const committed = readdirSync(VECTORS_DIR).filter((f) => !NON_GENERATED.has(f)).sort();
  if (generated.join(",") !== committed.join(",")) {
    process.stderr.write(`FAIL: generated file set [${generated}] != committed file set [${committed}]\n`);
    process.exit(1);
  }
  for (const name of generated) {
    if (!readFileSync(join(tmp, name)).equals(readFileSync(join(VECTORS_DIR, name)))) {
      process.stderr.write(`FAIL: regenerated ${name} differs from the committed vector.\n` +
        `The corpus is frozen; if a code change legitimately alters it, run\n` +
        `"npm run build:vectors", review the diff, and commit the result.\n`);
      process.exit(1);
    }
  }
  process.stdout.write(`  ok  ${generated.length} regenerated files byte-identical to committed vectors\n\n`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ---- 2. Conformance: run every case against the COMMITTED fixtures --------
const index = JSON.parse(readFileSync(join(VECTORS_DIR, "index.json"), "utf8"));
const readBundle = (f) => JSON.parse(readFileSync(join(VECTORS_DIR, f), "utf8"));
const readPem = (f) => readFileSync(join(VECTORS_DIR, f), "utf8");

let passed = 0;
const failures = [];

for (const c of index.cases) {
  const bundle = readBundle(c.file);
  const opts = c.pinKey ? { expectedPublicKeyPem: readPem(c.pinKey) } : {};
  const result = await verifyBundle(bundle, nodeCrypto, opts);
  const got = result.ok ? "pass" : "fail";
  const label = `${c.file}${c.pinKey ? ` [pin ${c.pinKey}]` : ""}`;

  if (got !== c.expect) {
    failures.push(`${label}: expected ${c.expect}, got ${got} (${result.reason ?? "ok"})`);
    continue;
  }
  if (c.expect === "fail" && c.reasonContains && !String(result.reason).includes(c.reasonContains)) {
    failures.push(`${label}: failed as expected but reason "${result.reason}" lacks "${c.reasonContains}"`);
    continue;
  }
  if (c.expect === "fail" && c.reasonCode && result.reasonCode !== c.reasonCode) {
    failures.push(`${label}: expected reasonCode "${c.reasonCode}", got "${result.reasonCode ?? "none"}"`);
    continue;
  }
  passed += 1;
  process.stdout.write(`  ok  ${label} -> ${got}${got === "fail" ? ` (${result.reason})` : ` (${result.count} events)`}\n`);
}

const statusAfter = gitStatus();
if (statusBefore !== null && statusBefore !== statusAfter) {
  failures.push(`the test suite dirtied the git tree:\nbefore:\n${statusBefore}after:\n${statusAfter}`);
}

process.stdout.write(`\n${passed}/${index.cases.length} conformance cases passed\n`);
if (failures.length) {
  process.stderr.write("\nFAILURES:\n" + failures.map((f) => "  - " + f).join("\n") + "\n");
  process.exit(1);
}
