# Examples

This directory contains seeded scenario flows, runnable demo scripts, and a
connector demo for MakerChecker. The scenario directories carry the input CSVs
and a flow definition for each governed workflow. The demo scripts drive a
running server through the SDK.

All demos assume a MakerChecker server on `http://localhost:3000` with the
seeded demo data (`docker compose up`). Authenticate with `MAKERCHECKER_API_KEY`
set to the key printed at seed time, or run the server with
`MAKERCHECKER_AUTH_DISABLED=1`. Build the workspace packages the scripts import
from `dist/` before running them.

## Seeded scenario flows

Each directory below holds the input data and flow definition for one governed
workflow. The flows model an agent that proposes a consequential action, a
segregation-of-duties constraint, and a human approval gate. The requester role
and the approver role are bound so the proposing agent cannot approve its own
action.

- `daily-cash-reconciliation/`: A preparer agent ingests the bank statement and
  ledger CSVs, matches transactions, and flags exceptions. A human approval gate
  reviews the exception list, then a reporter agent renders the summary and
  delivers it over an MCP notification skill. A second seeded flow,
  `self-approval-attempt`, exercises the maker-checker constraint: the run is
  blocked and the violation is written to the audit chain.
- `aml-alert-triage/`: An L1 analyst agent triages the day's AML alerts
  (`alerts.csv` plants two escalations: a structuring pattern and a sanctions
  near-match). The run parks at a "SAR filing decision" gate for the BSA officer;
  the analyst who worked an alert cannot approve its disposition. SAR narratives
  are drafted and delivered after approval.
- `mdr-reportability-triage/`: A complaint analyst agent triages the day's device
  complaints (`complaints.csv` plants two escalations: a serious-injury insulin-
  pump over-delivery and a recurrence-likely ventilator alarm malfunction). The
  run parks at a "reportability decision" gate for the regulatory officer; the
  requester cannot approve. MDR report skeletons are drafted after approval.
- `pv-icsr-processing/`: A case-processor agent triages the day's adverse-event
  cases (`icsr_cases.csv` plants two 15-day expedited cases, one foreign-sourced).
  The run parks at a "medical review" gate for the medical reviewer; the requester
  cannot approve. ICSR narratives are drafted and delivered after approval.
- `gross-to-net-margin/`: A market-analyst agent extracts the ERP pricing export
  (`erp_pricing.csv`, with one planted data-integrity anomaly: a double-counted
  austerity discount that drives deductions past 100% of list and yields a
  negative net) and assembles the gross-to-net waterfall per market and SKU,
  normalized into one comparable view. The run parks at a "margin certification"
  gate for the finance controller; the requester cannot certify. A rebate-accrual
  summary is delivered after certification.
- `cold-chain-disposition/`: A cold-chain monitor agent assesses a temperature
  excursion (`excursions.csv`, `readings.csv`, `stability_limits.csv`) and
  quarantines the affected lot itself. `quarantine@1` is `risk_tier: low` and runs
  pre-gate, since holding a lot is reversible. The release-or-destroy decision uses
  `disposition-act@1` (`risk_tier: high`), so the flow grammar forces an approval
  gate at a named QA approver and rejects any gate-less publish with
  `high_risk_requires_gate`.

## Runnable demos

### `sdk-demo.mjs`

Drives the Daily Cash Reconciliation flow end to end through the SDK: trigger,
poll until `waiting_approval`, approve the gate, print the report output, then
verify the audit chain.

```bash
node examples/sdk-demo.mjs
```

It uses the SDK client from `../packages/sdk/dist/index.js`:

```js
import { createClient } from "../packages/sdk/dist/index.js";

const client = createClient({ baseUrl: "http://localhost:3000", apiKey: "mk_..." });

const { runId } = await client.flows.trigger("daily-cash-reconciliation", {
  statementPath: "...bank_statement.csv",
  ledgerPath: "...ledger.csv",
});

const { run } = await client.runs.get(runId);            // poll run.status
const { approvals } = await client.approvals.list();
await client.approvals.decide(gate.id, "approved", "reason");
const verdict = await client.audit.verify();             // { ok, count }
```

### `middleware/governed-tool-demo.mjs`

Wraps plain functions (standing in for LangGraph, CrewAI, or Claude Agent SDK
tools) with `governedTool` and runs them inside a proxy session. The framework
executes the tool; MakerChecker performs the grant check, enforces segregation
of duties across the session, and records the audit trail. The script shows one
allowed call, one deny-by-default denial, and one SoD denial after a conflicting
role has acted in the session, then prints the session's audit trail and
verifies the chain.

```bash
node examples/middleware/governed-tool-demo.mjs
```

`governedTool(client, sessionId, agentName, skillRef, fn)` returns an async
function. Each call runs `client.proxy.check` first; a denied call throws
`GovernanceDeniedError` before `fn` runs. On allow it runs `fn`, records the
output (or the rethrown error), and returns the result.

```js
import { createClient, governedTool, GovernanceDeniedError } from "../../packages/sdk/dist/index.js";

const { session } = await client.proxy.openSession({ label: "external-framework-demo" });
const ingest = governedTool(client, session.id, "recon-preparer", "csv-ingest@1",
  async (input) => ({ rows: 12, source: input.source }));

await ingest({ source: "bank_statement.csv" });   // allowed: role holds the grant
await client.proxy.closeSession(session.id);
const detail = await client.proxy.getSession(session.id);   // detail.auditEvents
```

See [`middleware/README.md`](middleware/README.md) for LangGraph, CrewAI, and
Claude Agent SDK integration sketches that use the same wrapper.

## Connector demos

### `connectors/langchain/`

Governs real `@langchain/core` tools with
[`@makerchecker/connector-langchain`](../packages/connector-langchain).
`governLangChainTool(client, { sessionId, agentName, skillRef }, tool)` takes a
`StructuredTool` and returns a tool with the same `name`, `description`, and
`schema`, usable in any `ToolNode` or agent executor. Its `invoke()` runs the
grant check, runs the original tool inside LangChain on allow, and records the
output or rethrown error. A denied call throws `GovernanceDeniedError` before
the tool body runs. `governToolkit(...)` maps the wrapper over an array of
tools, one `skillRef` per tool, and fails closed on any unmapped tool.

The demo opens a proxy session, wraps two LangChain tools, makes one allowed
call (`recon-preparer` holds `txn-match@1`) and one denied call (`recon-preparer`
was never granted `report-gen@1`), prints the session's audit trail, and verifies
the chain.

```bash
pnpm --filter @makerchecker/sdk --filter @makerchecker/connector-langchain build
cd examples/connectors/langchain && pnpm install --ignore-workspace
MAKERCHECKER_URL=http://localhost:3000 node governed-langchain-demo.mjs
```

```js
import { governLangChainTool, GovernanceDeniedError } from "../../../packages/connector-langchain/dist/index.js";

const governed = governLangChainTool(
  client,
  { sessionId: session.id, agentName: "recon-preparer", skillRef: "txn-match@1" },
  matchTxns,                                  // a real @langchain/core tool
);
await governed.invoke({ statement: ["t1", "t2", "t3"] });
```

See [`connectors/langchain/README.md`](connectors/langchain/README.md) for the
full walkthrough.

## Limitations

The Claude Agent SDK wrapper (`governClaudeTool` from
[`@makerchecker/connector-claude-agent`](../packages/connector-claude-agent)) is
shown inline in [`middleware/README.md`](middleware/README.md); there is no
standalone runnable demo for it in this directory yet. High-risk skills are
refused in proxy-session mode; those actions belong in a governed flow with a
human approval gate, as the scenario flows above show.
