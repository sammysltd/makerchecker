# Examples

- `daily-cash-reconciliation/`: the flagship demo flow: cron trigger →
  Recon-Preparer agent matches bank statement vs ledger CSVs → human approval
  gate on the exception list → Recon-Reporter agent posts a summary via an
  MCP notification skill. Fully inspectable in the Run viewer.
- `aml-alert-triage/`: the financial-crime demo: an L1 analyst agent triages
  the day's AML alerts (two planted escalations: a structuring pattern and a
  sanctions near-match) → "SAR filing decision" gate for the BSA officer
  (requester cannot approve) → SAR narratives drafted and notified. The signed
  evidence export supports the NYDFS Part 504 certification.
- `mdr-reportability-triage/`: the medical-devices demo: a complaint analyst
  agent triages the day's device complaints (two planted escalations: a
  serious-injury insulin-pump over-delivery on the 30-day clock of
  21 CFR 803.50 and a recurrence-likely ventilator alarm malfunction) →
  "reportability decision" gate for the regulatory officer (requester cannot
  approve) → MDR report skeletons drafted and notified. The signed evidence
  export is the QMSR-era inspection-readiness artifact.
- `pv-icsr-processing/`: the medicines demo: a case-processor agent triages
  the day's adverse-event cases (two planted 15-day expedited cases under
  21 CFR 314.80, one foreign-sourced, the clock is source-independent) →
  "medical review" gate for the medical reviewer (requester cannot approve) →
  ICSR narratives drafted and notified. AI drafts, a named human signs: the
  draft-Annex-22 shape.
- `gross-to-net-margin/`: the pharma/medtech commercial demo: a market-analyst
  agent extracts the ERP pricing export and assembles the gross-to-net waterfall
  per market and SKU (one planted data-integrity anomaly: a double-counted
  austerity discount pushes deductions past 100% of list, yielding an impossible
  negative net), normalizes a comparable cross-market view → "margin
  certification" gate for the finance controller (requester cannot certify) →
  rebate-accrual summary drafted and notified. Not a pricing engine; we govern
  the agents that gather, normalize, and certify. The signed evidence export is
  the SOX walkthrough artifact.
- `cold-chain-disposition/`: the safe/consequential asymmetry demo: a cold-chain
  monitor agent assesses a temperature excursion (LOT-5002 peaks at 15°C against
  an 8°C limit, well past the validated 120-minute allowance) and quarantines the
  affected lot itself, because holding is the reversible, safe direction
  (`quarantine@1` is low risk and runs pre-gate). The irreversible
  release-or-destroy decision is structurally stopped at a "disposition decision"
  gate for a named QA approver (requester cannot decide): `disposition-act@1` is
  `risk_tier: high`, so the flow grammar forces the gate and rejects any
  gate-less publish with `high_risk_requires_gate`.
- `connectors/langchain/`: wrap, don't migrate, with the real
  [`@makerchecker/connector-langchain`](../packages/connector-langchain)
  connector: `governLangChainTool` wraps a `StructuredTool` (name/description/
  schema preserved) so every `invoke()` gets a deny-by-default grant check, SoD,
  and a hash-chained audit entry; your LangGraph graph is unchanged. The
  runnable demo shows one allowed call and one denied (ungranted) call with the
  audit trail printed.
- `middleware/`: wrap, don't migrate for any framework: govern agents that live
  in LangGraph, CrewAI, or the Claude Agent SDK with the SDK's `governedTool` and
  proxy sessions: grant checks, SoD, and the audit chain without re-platforming.
