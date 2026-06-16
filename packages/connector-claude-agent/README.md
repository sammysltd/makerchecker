# @makerchecker/connector-claude-agent

A connector that puts an existing [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)
custom tool under MakerChecker governance. The tool continues to execute inside
the Claude Agent SDK. MakerChecker adds a deny-by-default authorization check
before the tool body runs and a hash-chained, Ed25519-signed audit record of
each invocation.

The package exports one function, `governClaudeTool`, plus a re-export of
`GovernanceDeniedError` from [@makerchecker/sdk](../sdk).

## Install

`@anthropic-ai/claude-agent-sdk` (`^0.3.0`) is a peer dependency. The
MakerChecker SDK ([@makerchecker/sdk](../sdk)) is a direct dependency.

```bash
pnpm add @makerchecker/connector-claude-agent @anthropic-ai/claude-agent-sdk zod
```

## API

```ts
function governClaudeTool<Schema extends AnyZodRawShape>(
  client: Client,
  context: GovernContext,
  name: string,
  description: string,
  inputSchema: Schema,
  handler: (args: InferShape<Schema>, extra: unknown) => Promise<ToolResult>,
): SdkMcpToolDefinition<Schema>;
```

Parameters:

- `client`: a `Client` from `createClient` ([@makerchecker/sdk](../sdk)).
- `context`: a `GovernContext` identifying the governed call (see below).
- `name`: the tool name, passed through to the underlying SDK tool.
- `description`: the tool description, passed through unchanged.
- `inputSchema`: a Zod raw shape, passed through unchanged. The agent's tool
  spec is identical to the ungoverned tool.
- `handler`: the original tool handler. It runs only when the check allows the
  call.

Return value: an `SdkMcpToolDefinition<Schema>` built via the SDK's `tool(...)`.
It carries the same `name`, `description`, and `inputSchema` as the underlying
tool, so it drops into `createSdkMcpServer({ name, tools: [...] })` without
changing the agent.

### GovernContext

```ts
interface GovernContext {
  sessionId: string; // an open proxy session (client.proxy.openSession)
  agentName: string; // the registered agent whose role grants are evaluated
  skillRef: string; // the "name@version" of the skill this tool maps to
}
```

### GovernanceDeniedError

Re-exported from [@makerchecker/sdk](../sdk). Thrown when MakerChecker denies
the call. It carries the deny `code` and `reason` returned by the check.

## Behavior

The returned handler wraps each invocation:

1. Calls `client.proxy.check(sessionId, { agentName, skillRef, input })`. Plain
   object arguments are forwarded as `input`; non-object arguments are omitted.
2. On a deny, throws `GovernanceDeniedError(code, reason)`. The original handler
   does not run. The check fails closed.
3. On an allow, runs the original handler.
4. On success, calls `client.proxy.record(sessionId, { checkId, output })` and
   returns the handler output.
5. If the handler throws, calls `client.proxy.record(sessionId, { checkId, error })`
   with the coerced error message, then rethrows the original error.

## Usage

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

## Types

- `ToolResult`: the MCP tool result a Claude Agent SDK handler returns, derived
  from `SdkMcpToolDefinition["handler"]`. The connector takes no direct
  `@modelcontextprotocol/sdk` dependency.
- `Schema`: a `AnyZodRawShape` from the Claude Agent SDK. `InferShape<Schema>`
  gives the handler its typed `args`.

## Limitations

- The MakerChecker check runs synchronously before each tool call and adds one
  round trip to the configured `baseUrl` per invocation.
- Only plain object arguments are recorded as `input`. Array and primitive
  arguments are passed to the handler but not sent in the check `input` field.

## License

Apache-2.0.
