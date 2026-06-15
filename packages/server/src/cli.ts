import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { SCHEMA_VERSION } from "@makerchecker/shared";

import { generateApiKey } from "./auth/api-keys.js";
import { exportBundle } from "./audit/export.js";
import { ensureInstanceKeys } from "./audit/keys.js";
import { verifyChain } from "./audit/verify.js";
import { createPool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";
import { renderAccessReviewHtml } from "./reports/access-review.js";
import { renderRunReportHtml } from "./reports/run-report.js";

const USAGE = `makerchecker <command>

Commands:
  migrate                         apply pending database migrations
  create-api-key --email <email> [--name <label>]
                                  issue a new API key for an existing user
                                  (recovery path: key plaintexts print once)
  audit verify                    recompute and verify the full audit chain
  audit export [--run <id>] [--out <file>]
                                  write a signed audit bundle (JSON)
  audit report --run <id> [--out <file.html>]
                                  render the run evidence pack (HTML)
  audit access-review [--out <file.html>]
                                  render the role/grant access review (HTML)
`;

function emit(content: string, out: string | undefined, label: string): void {
  if (out) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- out is the operator's --out flag on a local admin CLI; the operator chooses where their own report is written.
    writeFileSync(out, content);
    console.log(`wrote ${label} to ${out}`);
  } else {
    console.log(content);
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, subcommand] = argv;
  const pool = createPool();
  try {
    if (command === "migrate") {
      const applied = await migrate(pool);
      console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
      return 0;
    }
    if (command === "create-api-key") {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: { email: { type: "string" }, name: { type: "string" } },
      });
      if (!values.email) {
        console.error("create-api-key requires --email <user email>");
        return 2;
      }
      const user = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
        values.email,
      ]);
      if (!user.rows[0]) {
        console.error(`no user with email "${values.email}"`);
        return 1;
      }
      const key = await generateApiKey(pool, {
        userId: user.rows[0].id,
        name: values.name ?? "cli-issued",
      });
      // Plaintext is shown exactly once; only its hash is stored.
      console.log(key.plaintext);
      return 0;
    }
    if (command === "audit" && subcommand === "verify") {
      const result = await verifyChain(pool);
      console.log(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    if (command === "audit" && subcommand === "export") {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { run: { type: "string" }, out: { type: "string" } },
      });
      const keys = await ensureInstanceKeys(pool, process.env.MAKERCHECKER_DATA_DIR ?? "./data");
      const bundle = await exportBundle(pool, keys, {
        schemaVersion: SCHEMA_VERSION,
        ...(values.run !== undefined ? { runId: values.run } : {}),
      });
      const json = JSON.stringify(bundle, null, 2);
      if (values.out) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename -- values.out is the operator's --out flag on a local admin CLI; the operator chooses where their own bundle is written.
        writeFileSync(values.out, json);
        console.log(`wrote ${bundle.manifest.count} events to ${values.out}`);
      } else {
        console.log(json);
      }
      return 0;
    }
    if (command === "audit" && subcommand === "report") {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { run: { type: "string" }, out: { type: "string" } },
      });
      if (!values.run) {
        console.error("audit report requires --run <id>");
        return 2;
      }
      // Ensure the instance key exists so the report carries its fingerprint.
      await ensureInstanceKeys(pool, process.env.MAKERCHECKER_DATA_DIR ?? "./data");
      emit(await renderRunReportHtml(pool, values.run), values.out, "run evidence pack");
      return 0;
    }
    if (command === "audit" && subcommand === "access-review") {
      const { values } = parseArgs({
        args: argv.slice(2),
        options: { out: { type: "string" } },
      });
      emit(await renderAccessReviewHtml(pool), values.out, "access review");
      return 0;
    }
    console.error(USAGE);
    return 2;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
