# MakerChecker

[![CI](https://github.com/sammysltd/makerchecker/actions/workflows/ci.yml/badge.svg)](https://github.com/sammysltd/makerchecker/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/sammysltd/makerchecker?label=release)](https://github.com/sammysltd/makerchecker/releases/latest)
[![License](https://img.shields.io/badge/license-AGPL--3.0%20core%20%2B%20Apache--2.0%20SDK-informational)](LICENSING.md)

MakerChecker is open-source, self-hosted software that governs AI agents. It gives each agent an identity with one role, deny-by-default skill grants pinned to a specific version, segregation-of-duties constraints so the agent that proposes a consequential action cannot approve it, n-of-m human approval gates on high-risk actions, per-skill role limits including argument policy, and a hash-chained, Ed25519-signed audit log that an external party can verify offline. It is framework-agnostic: agents keep running in LangGraph, CrewAI, or the Claude Agent SDK while MakerChecker is the authorization checkpoint and the record.

The control plane is a Fastify server backed by Postgres. Agents reach it two ways: as a flow, where MakerChecker orchestrates sequential agent steps and approval gates, or as a proxy session, where MakerChecker authorizes and records tool calls that another framework executes. Both paths write to the same audit chain.

[Live demo](https://makerchecker.ai/demo/): an agent is blocked from approving its own work, a human signs off, and the audit chain verifies, in the browser, with no signup.

![Run viewer](docs/assets/demo.gif)

## What it enforces

- **Deny by default.** A skill runs only if the agent's role holds a current grant to that exact skill version. Revocation takes effect at the next enforcement check.
- **Segregation of duties.** Role-pair constraints are checked at decision time and at invocation time. The same actor cannot be maker and checker on one run.
- **Human approval gates.** A high-risk skill cannot run without a gate. The run parks until a human decides. Rejection fails the run.
- **n-of-m named approvals.** Gates support quorums, named approver lists, and requester-cannot-approve by default. Unauthenticated or out-of-list decisions fail closed.
- **Role limits and budgets.** Per-skill invocation caps, amount ceilings that fail closed on unreadable inputs, and run-level invocation and token budgets.
- **Verifiable audit.** Every transition lands in a genesis-rooted, hash-linked, append-only log, exportable as an Ed25519-signed bundle that verifies with no access to the running system.

Concept reference: [docs/concepts.md](docs/concepts.md). Audit chain and bundle format: [docs/audit-spec.md](docs/audit-spec.md).

## Quickstart

```bash
docker compose up
```

This boots Postgres and the server on `:3000`. The compose file sets `MAKERCHECKER_SEED_DEMO=1` and `DEMO_DATA_DIR`, so first boot seeds the demo casts and prints two API keys once: a demo admin key and a demo officer key. Copy them from the boot logs.

The seed includes a Daily Cash Reconciliation flow with a maker-checker SoD constraint and two planted exceptions in the data: `T-1009`, a supplier payment booked as -7800.00 on the statement but -7080.00 in the ledger (a transposition typo), and `T-1012`, an unidentified credit on the statement that is missing from the ledger. It also seeds an AML Alert Triage flow whose run parks at a BSA-officer gate the requester cannot approve (see [examples/aml-alert-triage](examples/aml-alert-triage/README.md)), a `self-approval-attempt` flow that SoD blocks live, and several other domain casts (MDR, PV, gross-to-net, cold-chain) listed in [examples/README.md](examples/README.md).

Pass an API key as a Bearer token, or set `MAKERCHECKER_AUTH_DISABLED=1` on the server for keyless local use. The admin key triggers runs and approves the cash-reconciliation gate. The AML flow's BSA-officer gate is identity-mode, so decide that one with the officer key.

```bash
export H='authorization: Bearer mk_...'   # key printed at first boot

# trigger the flow
curl -X POST localhost:3000/api/flows/daily-cash-reconciliation/runs -H "$H" -H 'content-type: application/json' -d '{}'

# it parks at the human gate; find the approval and decide it
curl localhost:3000/api/approvals -H "$H"
curl -X POST localhost:3000/api/approvals/<id>/decision -H "$H" -H 'content-type: application/json' \
  -d '{"decision":"approved","reason":"Both exceptions explained"}'

# inspect every step, skill call, and gate decision
curl localhost:3000/api/runs/<runId> -H "$H"

# verify the audit chain end to end
curl localhost:3000/api/audit/verify -H "$H"
```

Set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` to run the agents on a real model that decides which granted skills to call. Omit both and steps execute deterministically, so the demo runs air-gapped. More: [docs/quickstart.md](docs/quickstart.md) and the [demo walkthrough](examples/daily-cash-reconciliation/README.md).

The quickstart connects as the Postgres owner for simplicity, which can disable the append-only audit triggers. For tamper-resistance against a compromised application credential, run the server as a non-owner role using [`ops/harden-db.sql`](ops/harden-db.sql) and [`docker-compose.hardened.yml`](docker-compose.hardened.yml). Walkthrough: [docs/db-hardening.md](docs/db-hardening.md).

## Packages

pnpm workspaces with Turborepo. The control plane is AGPL-3.0. The integration layer (SDK, connectors, examples) is Apache-2.0, so embedding it in your own code carries no copyleft obligation.

| Package | License | What it is |
|---|---|---|
| [`packages/server`](packages/server) | AGPL-3.0 | Fastify API, flow engine, workers, audit writer, demo seed, and the `cli.js` admin tool. |
| [`packages/web`](packages/web) | AGPL-3.0 | Vite/React SPA: run viewer, approvals inbox, registry. |
| [`packages/shared`](packages/shared) | AGPL-3.0 | Domain types, TypeBox schemas, RFC 8785 canonical JSON, and hash utilities. |
| [`packages/sdk`](packages/sdk) | Apache-2.0 | Typed TypeScript HTTP client plus the framework-agnostic `governedTool` wrapper. |
| [`packages/sdk-python`](packages/sdk-python) | Apache-2.0 | Typed Python HTTP client plus `governed_tool`. |
| [`packages/connector-langchain`](packages/connector-langchain) | Apache-2.0 | `governLangChainTool` / `governToolkit` for LangChain `StructuredTool`s. |
| [`packages/connector-claude-agent`](packages/connector-claude-agent) | Apache-2.0 | `governClaudeTool` for Claude Agent SDK custom tools. |

The six governed primitives are Agent, Role, Skill, Trigger, Flow, and Run/Audit, all Postgres-backed and versioned. See [docs/concepts.md](docs/concepts.md).

## Integration

An agent's tool calls are governed through a proxy session. Open a session, then wrap each tool so every invocation calls `proxy.check` (a deny throws `GovernanceDeniedError` before the tool runs), runs the tool, and calls `proxy.record` with the output (or the error, which is rethrown). The framework keeps executing the tool. High-risk skills are refused on the proxy path; they require a flow gate.

### TypeScript SDK

`createClient` returns a typed client. `governedTool` wraps any plain function.

```ts
import { createClient, governedTool, GovernanceDeniedError } from "@makerchecker/sdk";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "recon-run" });

const match = governedTool(
  client,
  session.id,
  "recon-preparer",   // registered agent whose role grants are evaluated
  "txn-match@1",       // skillRef: name@version
  (input: { statement: unknown[]; ledger: unknown[] }) => matchTxns(input),
);

await match({ statement, ledger }); // throws GovernanceDeniedError if denied
await client.proxy.closeSession(session.id);
```

`governedTool(client, sessionId, agentName, skillRef, fn)` returns an async function with the same input type. Generic middleware recipes: [examples/middleware](examples/middleware/README.md).

### LangChain connector

`governLangChainTool` wraps a `StructuredTool` and returns a `DynamicStructuredTool` with the same `name`, `description`, and `schema`, so it drops into any `ToolNode` or agent executor unchanged. `governToolkit` maps over an array of tools, assigning each its own `skillRef`; an unmapped tool throws rather than running ungoverned.

```ts
import { createClient } from "@makerchecker/sdk";
import { governLangChainTool } from "@makerchecker/connector-langchain";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "langgraph-run" });

const governedMatch = governLangChainTool(
  client,
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "txn-match@1" },
  matchTxns, // your existing DynamicStructuredTool
);
// new ToolNode([governedMatch]). The graph is unchanged.
```

`@langchain/core` is a peer dependency. Runnable demo: [examples/connectors/langchain](examples/connectors/langchain/README.md).

### Claude Agent SDK connector

`governClaudeTool` returns an `SdkMcpToolDefinition` (same `name`, `description`, `inputSchema`) that drops into `createSdkMcpServer`.

```ts
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createClient } from "@makerchecker/sdk";
import { governClaudeTool } from "@makerchecker/connector-claude-agent";
import { z } from "zod";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });
const { session } = await client.proxy.openSession({ label: "claude-run" });

const ingest = governClaudeTool(
  client,
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "csv-ingest@1" },
  "csv_ingest",
  "Ingest the statement CSVs",
  { statementPath: z.string() },
  async (args) => ({ content: [{ type: "text", text: await readCsv(args) }] }),
);

const server = createSdkMcpServer({ name: "governed-tools", tools: [ingest] });
```

`@anthropic-ai/claude-agent-sdk` is a peer dependency. Details: [packages/connector-claude-agent/README.md](packages/connector-claude-agent/README.md), example: [examples/connectors/claude-agent](examples/connectors/claude-agent).

### Python SDK

`create_client` returns the client; `governed_tool` wraps any callable. Works with CrewAI, LangChain-Python, LlamaIndex, AutoGen, or a plain function.

```python
from makerchecker import create_client, governed_tool, GovernanceDeniedError

client = create_client("http://localhost:3000", api_key="mk_...")
session = client.proxy.open_session("crew-run")["session"]

ingest = governed_tool(
    client, session["id"], "recon-preparer", "csv-ingest@1",
    lambda i: read_csv(i["path"]),
)

result = ingest({"path": "statement.csv"})   # raises GovernanceDeniedError if denied
client.proxy.close_session(session["id"])
```

Install with `pip install makerchecker`. Framework recipes: [packages/sdk-python/README.md](packages/sdk-python/README.md).

## Audit and verification

Every state transition emits an audit event in the same database transaction as the state write. Each event hash is `SHA-256` over the RFC 8785 canonical JSON of the event (the `seq` storage column is excluded), chained through `prev_hash`. The chain is rooted in a genesis event derived from the instance UUID. Tampering with any row breaks recomputation at that row.

Verification:

- `GET /api/audit/verify` walks the chain and returns `{ ok, count, headHash }` or, on a break, `{ ok: false, failedSeq, reason }`.
- The server CLI verifies the chain against the database and verifies signed bundles offline:

```bash
# against the running database
docker compose exec server node dist/cli.js audit verify

# export a signed bundle, then verify it with no database
docker compose exec server node dist/cli.js audit export --out bundle.json
node dist/cli.js audit verify-bundle --in bundle.json
node dist/cli.js audit verify-bundle --in bundle.json --key instance.pub  # pin the expected key
```

Bundles are Ed25519-signed and carry the manifest needed to recompute the chain independently. The format is specified in [docs/audit-spec.md](docs/audit-spec.md) so a third party can reimplement verification in any language. The CLI also renders evidence packs: `audit report --run <id>` produces a self-contained HTML run report with chain verification, and `audit access-review` renders the role/grant/SoD review (also available as JSON at `/api/reports/access-review`).

## Status

1.0.0. The public API, flow grammar, and audit-bundle format are stable under semantic versioning. Implemented:

- Roles, agents, and versioned skills (MCP/HTTP/local) with risk tiers; deny-by-default grants with revocation.
- SoD constraints enforced at decision time and invocation time.
- Flows with approval gates, retries, timeouts, and a crash-recovery watchdog.
- n-of-m named approvals: quorums, named approver lists, requester self-approval forbidden by default (fail closed).
- Role limits and budgets: per-skill invocation caps, fail-closed amount ceilings, run-level invocation and token budgets.
- Proxy sessions wrapping LangGraph/CrewAI/Claude Agent SDK agents with grant checks, SoD, and the audit trail, plus typed connectors and generic middleware recipes.
- Hash-chained audit log with Ed25519-signed export bundles and a CLI verifier.
- Evidence packs: HTML run reports and role/grant/SoD access-review reports.
- Cron, event, and manual/API triggers; HMAC-signed outbound webhooks with retries and a failure counter.
- Overdue-approval alerts (`approval.overdue` audit event and webhook; the approvals API reports `overdue` and `age_seconds`).
- Prometheus `/metrics` endpoint (opt-in via `MAKERCHECKER_METRICS=1`).
- Real-model execution (Anthropic, Gemini/OpenAI-compatible) with a deterministic air-gapped fallback.
- API-key auth; React UI; typed SDK; OpenAPI document at `/api/openapi.json`; configurable redaction applied at write to LLM/skill audit payloads and at read to run detail and evidence packs.

Security model and hardened deployment: [SECURITY.md](SECURITY.md). Security reports are welcome.

## Comparison

|  | MakerChecker | Cordum | Galileo Agent Control | Observability tools |
|---|---|---|---|---|
| Deny-by-default grant ledger | Versioned grants per role; full permission history reconstructable | Allow-unless-policy-hits; agent identity is enterprise-paywalled | None; content rules, not permissions | None |
| Runtime SoD enforcement | Declared role-pair constraints, enforced at execution | Multi-approver routing only | None | None |
| Signed offline-verifiable export | Core feature, [open spec](docs/audit-spec.md) | Hash chain claimed; no published spec, no signed export | None | Logs and traces, not evidence |
| License | AGPL-3.0 core, Apache-2.0 SDK and examples | BUSL-1.1 | Apache 2.0 (Cisco-owned) | Varies |

Guardrail products answer whether content is dangerous. MakerChecker answers whether the actor is authorized and who approved the action. An agent that passes every content check can still execute a payment it was never authorized to touch. The two compose: run guardrails on content, run MakerChecker on authority. Full landscape: [docs/positioning/competitive-landscape.md](docs/positioning/competitive-landscape.md).

## License

Split license. The control plane is AGPL-3.0; the integration layer is Apache-2.0.

- `packages/server`, `packages/web`, `packages/shared`: AGPL-3.0 ([LICENSE](LICENSE)).
- `packages/sdk`, `packages/sdk-python`, `packages/connector-langchain`, `packages/connector-claude-agent`, and `examples/`: Apache-2.0. Code you embed in your own systems never carries AGPL obligations. The boundary is the network API.
- A commercial license (no copyleft obligation) is available for organizations whose policies preclude AGPL-3.0: hello@makerchecker.ai.

Rationale and the commercial/CLA model: [LICENSING.md](LICENSING.md). Per-package `license` fields are authoritative.

Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) · Security: [SECURITY.md](SECURITY.md) · Code of Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) · Changelog: [CHANGELOG.md](CHANGELOG.md) · Starter issues: [docs/good-first-issues.md](docs/good-first-issues.md)
