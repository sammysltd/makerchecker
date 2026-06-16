# @makerchecker/connector-langchain

A LangChain adapter for [MakerChecker](../../README.md). It exposes
`governLangChainTool`, a function that takes an existing LangChain
`StructuredTool` and returns a `StructuredTool` whose `invoke()` runs a
MakerChecker authorization check before the tool, runs the tool, and records the
result to the hash-chained audit log. The returned tool keeps the original
`name`, `description`, and `schema`, so it is a drop-in replacement inside a
`ToolNode`, an agent executor, or any LangGraph graph. The agent runs unchanged.

MakerChecker is open-source, self-hosted software that governs AI agents. Each
agent holds a role with deny-by-default, version-pinned skill grants. This
connector maps a single LangChain tool to one skill reference and enforces that
grant on every invocation. Other controls (segregation of duties, n-of-m
approval gates, per-skill argument policy, Ed25519-signed audit) are evaluated
server-side by the same `proxy.check` call.

`@langchain/core` is a peer dependency (`^1.0.0`). The MakerChecker SDK
([@makerchecker/sdk](../sdk)) is a direct dependency.

## Install

```bash
pnpm add @makerchecker/connector-langchain @makerchecker/sdk @langchain/core
```

## API

### `governLangChainTool(client, context, tool)`

```ts
function governLangChainTool<T extends StructuredToolInterface>(
  client: Client,
  context: GovernContext,
  tool: T,
): DynamicStructuredTool;
```

Parameters:

- `client`: a `Client` from `createClient` ([@makerchecker/sdk](../sdk)).
- `context`: a `GovernContext` identifying the governed call.
- `tool`: any LangChain `StructuredTool` / `DynamicStructuredTool` (a
  `StructuredToolInterface`).

Returns a new `DynamicStructuredTool` carrying the original tool's `name`,
`description`, and `schema`. The schema object is passed through by reference, so
the LLM tool spec and graph definition are identical to the ungoverned tool.

```ts
export interface GovernContext {
  sessionId: string; // an open proxy session (client.proxy.openSession)
  agentName: string; // the registered agent whose role grants are evaluated
  skillRef: string; // the name@version of the skill this tool maps to
}
```

`invoke()` on the returned tool performs these steps:

1. Calls `client.proxy.check(sessionId, { agentName, skillRef, input })`. The
   `input` field is included when the tool input is a plain object. A denied
   result (`allowed: false`) throws `GovernanceDeniedError(code, reason)` and the
   underlying tool is not invoked.
2. Calls `tool.invoke(input, config)`.
3. On success, calls `client.proxy.record(sessionId, { checkId, output })` and
   returns the tool output.
4. If the tool throws, calls
   `client.proxy.record(sessionId, { checkId, error })` with the error message,
   then rethrows the original error.

### `governToolkit(client, context, tools, skillRefs)`

```ts
function governToolkit<T extends StructuredToolInterface>(
  client: Client,
  context: Omit<GovernContext, "skillRef">,
  tools: readonly T[],
  skillRefs: ((tool: T) => string) | Record<string, string>,
): DynamicStructuredTool[];
```

Maps `governLangChainTool` over an array of tools. All tools share one
`sessionId` and `agentName`; each resolves its own `skillRef`. `skillRefs` is
either a function `(tool) => skillRef` or a record mapping tool `name` to
`skillRef`. A tool that does not resolve to a `skillRef` throws an error rather
than running ungoverned.

### `GovernanceDeniedError`

Re-exported from [@makerchecker/sdk](../sdk). Thrown when the check denies the
call. Fields: `code` (string) and `reason` (string).

## Usage

```ts
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createClient } from "@makerchecker/sdk";
import {
  governLangChainTool,
  GovernanceDeniedError,
} from "@makerchecker/connector-langchain";

const client = createClient({
  baseUrl: "http://localhost:3000",
  apiKey: "mk_...",
});

// An existing LangChain tool.
const matchTxns = tool(
  async ({ statement }) => ({ matched: statement.length, exceptions: 1 }),
  {
    name: "match_txns",
    description: "Match statement transactions against the ledger; flag exceptions.",
    schema: z.object({ statement: z.array(z.string()) }),
  },
);

const { session } = await client.proxy.openSession({ label: "langchain-run" });

const governedMatch = governLangChainTool(
  client,
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "txn-match@1" },
  matchTxns,
);

// governedMatch.name === "match_txns"; same description and schema.
// Drop it into a ToolNode or agent executor in place of matchTxns.

try {
  const out = await governedMatch.invoke({ statement: ["t1", "t2", "t3"] });
  // Check passed, tool ran, output recorded to the audit log.
} catch (err) {
  if (err instanceof GovernanceDeniedError) {
    // The check denied the call. The tool body never executed.
    console.error(`denied (${err.code}): ${err.reason}`);
  } else {
    throw err;
  }
}

await client.proxy.closeSession(session.id);
```

A runnable version is in
[examples/connectors/langchain/governed-langchain-demo.mjs](../../examples/connectors/langchain/governed-langchain-demo.mjs).
It wraps two tools, shows one allowed call and one denied call (an agent whose
role was never granted the second skill), prints the session audit trail, and
verifies the chain.

## Behavior notes

- Deny is fail-closed. On a denied check, the underlying tool is never invoked.
- The audit record on a thrown tool error stores
  `{ message }` derived from the error (the message for an `Error`, otherwise
  `String(err)`). The original error is rethrown unchanged.
- The `input` field is sent to `proxy.check` only when the tool input is a plain
  object (not an array, not a primitive). Argument policy on the skill is
  evaluated server-side against that input.
- The wrapper does not alter retry, callback, or streaming behavior of the
  underlying tool; it calls `tool.invoke(input, config)` and passes the
  LangChain `config` through.

## Limitations

- One governed tool maps to exactly one `skillRef`. A tool that should map to
  several skills depending on its arguments needs separate wrapped instances or
  server-side argument policy.
- The check evaluates the tool input passed to `invoke()`. Side effects the tool
  performs that are not reflected in its input or output are outside the recorded
  evidence.

## License

Apache-2.0. Embedding this connector in your own systems carries no AGPL
obligations.
