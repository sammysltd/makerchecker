# @makerchecker/sdk

Typed TypeScript client for the MakerChecker API.

MakerChecker is open-source, self-hosted software that governs AI agents. An
agent gets a role with deny-by-default, version-pinned skill grants; segregation
of duties (the agent that proposes a consequential action cannot approve it);
n-of-m human approval gates on high-risk actions; per-skill role limits including
argument policy; and a hash-chained, Ed25519-signed audit log that can be
verified offline.

This package wraps the HTTP API of [`packages/server`](../server) in a small
client. It also exports `governedTool`, a middleware wrapper that routes any
existing tool function through a proxy session so each call is authorized and
recorded.

## Install

The package is published as an ES module (`"type": "module"`). It targets the
host `fetch`, so it runs on Node 18+ and in browsers without a polyfill.

```bash
pnpm add @makerchecker/sdk
```

To run the examples in this repository, build the SDK first and import from
`dist`:

```bash
corepack pnpm --filter @makerchecker/sdk build
```

## createClient

`createClient(options)` returns a client object. It holds no connection; each
method performs one HTTP request against `baseUrl`.

```ts
import { createClient } from "@makerchecker/sdk";

const client = createClient({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.MAKERCHECKER_API_KEY,
});
```

### ClientOptions

```ts
interface ClientOptions {
  baseUrl: string;        // server origin; trailing slashes are stripped
  apiKey?: string;        // sent as `Authorization: Bearer <apiKey>` when set
  fetch?: typeof fetch;   // override the fetch implementation (tests, proxies)
}
```

When `apiKey` is omitted, requests carry no `Authorization` header. The server
rejects them unless it runs with `MAKERCHECKER_AUTH_DISABLED=1`.

### Errors

Any non-2xx response throws `ApiError`:

```ts
import { ApiError } from "@makerchecker/sdk";

try {
  await client.runs.get("missing-id");
} catch (err) {
  if (err instanceof ApiError) {
    console.error(err.status, err.body); // HTTP status code and raw response body
  }
}
```

## Resource methods

All routes live under `/api`, except the health probe at `/healthz`. Every
method returns a `Promise` of the typed response.

### health

```ts
await client.health(); // { status: "ok"; schemaVersion: number }
```

### flows

```ts
const { runId } = await client.flows.trigger("daily-cash-reconciliation", {
  statementPath: "/data/bank_statement.csv",
  ledgerPath: "/data/ledger.csv",
});
```

`trigger(name, input?)` starts a run of the named flow and returns its `runId`.
The optional second argument is the flow input object.

### runs

```ts
const { runs } = await client.runs.list(); // RunSummary[]
const detail = await client.runs.get(runId); // RunDetail
```

`RunDetail` carries the run record, its `steps` (`StepRun[]`), its `approvals`
(`ApprovalRecord[]`), and the run's `auditEvents` (`AuditEvent[]`). Run status is
one of:

```ts
type RunStatus =
  | "pending" | "running" | "waiting_approval"
  | "completed" | "failed" | "cancelled" | "timed_out";
```

### approvals

```ts
const { approvals } = await client.approvals.list(); // PendingApproval[]
await client.approvals.decide(approvalId, "approved", "exceptions reviewed");
await client.approvals.decide(approvalId, "rejected", "amount over threshold");
```

`list()` returns approvals waiting on a decision. `PendingApproval` includes
`required_approvals` and `approved_count` for n-of-m gates, plus `overdue` and
`age_seconds` ops signals. `decide(id, decision, reason?)` records one decision;
for an n-of-m gate the run resumes once the quorum is reached.

### agents

```ts
const { agents } = await client.agents.list();
const { agent } = await client.agents.create({
  name: "recon-preparer",
  description: "Prepares daily cash reconciliations",
  roleName: "recon-preparer",
});
const detail = await client.agents.get(agent.id); // AgentDetail: agent, skills, recentRuns
await client.agents.setStatus(agent.id, "suspended"); // "active" | "suspended" | "retired"
```

`create` accepts `roleId` or `roleName` to bind the agent to an existing role,
and optional `modelConfig`.

### roles

```ts
const { roles } = await client.roles.list();
const { role } = await client.roles.create({
  name: "recon-preparer",
  description: "Prepares reconciliations, cannot approve them",
  limits: { "approve-recon@1": { maxAmount: 0 } },
});
```

`limits` is the per-skill role limit map, including argument policy.

### skills

```ts
const { skills } = await client.skills.list();
const { skill } = await client.skills.publish({
  name: "csv-ingest",
  version: 1,
  description: "Ingest statement and ledger CSVs",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  implementation: { kind: "mcp", ref: "csv-ingest" },
  riskTier: "low", // "low" | "medium" | "high"
});
await client.skills.deprecate(skill.id);
```

Skills are versioned. `publish` registers a new `name@version`; `deprecate`
marks a skill version unusable for new grants.

### grants

```ts
const { grant } = await client.grants.create({ roleId: role.id, skillId: skill.id });
await client.grants.revoke(grant.id);
```

A grant binds one skill version to one role. Without a live grant the role
cannot run that skill (deny by default). `revoke` ends a grant; revocation is
recorded rather than deleted.

### audit

```ts
const verdict = await client.audit.verify();
// { ok: true; count: number; headHash: string | null }
// | { ok: false; count: number; failedSeq: string; reason: string }
```

`verify()` walks the hash chain server-side and reports whether it is intact. On
failure it names the first `failedSeq` and the `reason`. The signed export for
offline verification is produced by [`packages/server`](../server).

### proxy

Proxy sessions let an external framework keep executing tools while MakerChecker
authorizes and records each call.

```ts
const { session } = await client.proxy.openSession({
  label: "external-framework-demo",
  externalRef: "thread-1", // optional correlation id
});

const check = await client.proxy.check(session.id, {
  agentName: "recon-preparer",
  skillRef: "csv-ingest@1",
  input: { source: "bank_statement.csv" },
});
// { allowed: true; checkId: string } | { allowed: false; code: string; reason: string }

if (check.allowed) {
  const output = runTheTool();
  await client.proxy.record(session.id, { checkId: check.checkId, output });
}

await client.proxy.closeSession(session.id);
const detail = await client.proxy.getSession(session.id); // session, actions, auditEvents
```

`check` evaluates the grant, segregation-of-duties constraints across the
session, and per-skill role limits. A `checkId` from an allowed check is passed
to `record` along with the tool `output` or an `error`. High-risk skills are
refused in proxy mode; route those through a governed flow with an approval gate.

## governedTool

`governedTool` wraps a tool function so each invocation passes through a proxy
session. Per call it runs `check`, throws `GovernanceDeniedError` if the check
denies, executes the function, then records the output. If the function throws,
it records the error and rethrows it.

```ts
function governedTool<TInput extends Record<string, unknown>, TOutput>(
  client: Client,
  sessionId: string,
  agentName: string,
  skillRef: string,
  fn: (input: TInput) => TOutput | Promise<TOutput>,
): (input: TInput) => Promise<TOutput>;
```

The returned function has the same input shape as `fn`. The original framework
remains the executor; MakerChecker is the authorization checkpoint and the
record.

```ts
import { createClient, governedTool, GovernanceDeniedError } from "@makerchecker/sdk";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "my-agent-run" });

const ingest = governedTool(
  client,
  session.id,
  "recon-preparer",
  "csv-ingest@1",
  async (input) => readCsvFiles(input),
);

try {
  const result = await ingest({ source: "bank_statement.csv" });
  // result is the tool output; the call was authorized and recorded
} catch (err) {
  if (err instanceof GovernanceDeniedError) {
    console.log(`denied (${err.code}): ${err.reason}`);
  } else {
    throw err; // tool threw; the error was recorded and rethrown
  }
}

await client.proxy.closeSession(session.id);
```

### GovernanceDeniedError

```ts
class GovernanceDeniedError extends Error {
  readonly code: string;   // machine-readable denial code from the check
  readonly reason: string; // human-readable explanation
}
```

Thrown only when the proxy check denies the call. The wrapped function does not
run. Errors thrown by the function itself propagate as their original type after
being recorded.

### Framework adapters

`governedTool` accepts any function, so it slots into existing agent
frameworks. Worked LangGraph, CrewAI, and Claude Agent SDK examples are in
[`examples/middleware/README.md`](../../examples/middleware/README.md). For
prebuilt integrations see [`packages/connector-langchain`](../connector-langchain)
and [`packages/connector-claude-agent`](../connector-claude-agent).

## Examples

Two runnable scripts drive a seeded server on `:3000`. Build the SDK first, then
set `MAKERCHECKER_API_KEY` (or run the server with
`MAKERCHECKER_AUTH_DISABLED=1`).

- [`examples/sdk-demo.mjs`](../../examples/sdk-demo.mjs): triggers a flow, polls
  the run, approves the gate, prints the report, and verifies the audit chain.
- [`examples/middleware/governed-tool-demo.mjs`](../../examples/middleware/governed-tool-demo.mjs):
  wraps tools with `governedTool` and shows an allowed call, a deny-by-default
  denial, and a segregation-of-duties denial, then prints the session audit
  trail.

```bash
node examples/sdk-demo.mjs
node examples/middleware/governed-tool-demo.mjs
```

## Limitations

The client validates nothing locally; it forwards requests and types the
responses. Authorization, segregation-of-duties evaluation, limit checks, and
audit chaining happen on the server. Response types are hand-written against the
server routes and `packages/sdk/openapi.json`; keep them in sync when routes
change.

## Related packages

- [`packages/server`](../server): the Fastify API, engine, workers, and audit
  writer this client talks to.
- [`packages/shared`](../shared): domain types, schemas, and canonical JSON and
  hash utilities.
- [`packages/sdk-python`](../sdk-python): the Python client.
- [`packages/connector-langchain`](../connector-langchain),
  [`packages/connector-claude-agent`](../connector-claude-agent): framework
  integrations built on this SDK.

## License

Apache-2.0. See [LICENSE](./LICENSE).
