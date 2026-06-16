# Knight Capital: $440M in 45 Minutes With No Kill Switch

On 1 August 2012 Knight Capital deployed new order-routing software to seven of
its eight production servers. The eighth still ran a dormant feature called Power
Peg, which a reused configuration flag reactivated. Over roughly 45 minutes the
eighth server fired millions of unintended orders into the market, producing a
loss of about $440 million. The SEC found that Knight had violated Rule 15c3-5,
the Market Access Rule, and imposed a $12 million penalty. Sources:
[SEC press release](https://www.sec.gov/newsroom/press-releases/2013-222),
[SEC order](https://www.sec.gov/Archives/edgar/data/0001060749/000119312512338098/d392396dex991.htm),
[WilmerHale client alert](https://www.wilmerhale.com/en/insights/client-alerts/knight-capital-settles-rule-15c3-5-violations-with-sec-agrees-to-pay-12-million).
Full analysis: https://makerchecker.ai/insights/knight-capital-440m-runaway-trading/.

Knight was deterministic software, not an LLM. The case is included because the
control shape is identical: an irreversible action stream with no human gate and
no version pinning on the code permitted to act.

## The risk

A routing role places live orders against the market. Two failures compounded:
an unapproved code version (the dormant Power Peg path) was permitted to act, and
order placement above any notional threshold ran with no approval gate. There was
no kill switch between the agent and the market.

## The MakerChecker configuration

Order placement is split by reversibility. Building and validating an order batch
is reversible and runs pre-gate. Sending the batch to the market is irreversible
and is modeled as a high-risk skill, so the flow grammar forces an approval gate
before the step that uses it. Argument-level limits (the notional threshold above
which a batch must be gated) cannot be expressed inside a single skill grant, so
they are modeled as a distinct high-risk skill: the role holds the low-threshold
sender for routine flow and must pass through the gate for `order-send-high@1`.

Skills are pinned by exact version. A role granted `order-build@1` cannot act
under any other version, so a dormant or unapproved code path is refused by
deny-by-default rather than executed.

Flow steps (`flow.yaml`-style):

```yaml
name: gated-order-routing
steps:
  - key: build_batch
    agent: order-router
    skills: [order-build@1, order-validate@1]
    instructions: >-
      Build and validate the order batch against position and notional limits.
      Produce the batch for review. Do not send.
    timeout_ms: 120000
  - key: send_review
    type: approval_gate
    title: Approve order batch before it reaches the market
  - key: send_batch
    agent: order-sender
    skills: [order-send-high@1]
    instructions: >-
      Send the approved batch to the market.
    timeout_ms: 120000
```

Roles and grants (deny by default; only listed grants exist):

```yaml
roles:
  - name: order-router
    grants:
      - order-build@1       # risk_tier: low
      - order-validate@1    # risk_tier: low
      # no send grant: order-router cannot place orders at all
  - name: order-sender
    grants:
      - order-send-high@1   # risk_tier: high -> forces the gate

skills:
  - name: order-build@1
    risk_tier: low
  - name: order-validate@1
    risk_tier: low
  - name: order-send-high@1
    risk_tier: high
```

The gate is identity-mode (`forbid_requester`): the user who triggers the routing
run cannot approve the send. A named, different approver signs off the batch.

## What happens

The `order-router` agent builds and validates the batch pre-gate. If it attempts
to send, deny-by-default refuses: the role holds no send grant, and the call
never reaches a tool body. A batch above the notional threshold requires
`order-send-high@1`, which is `risk_tier: high`, so the flow grammar holds the
run at the approval gate. Publishing this flow without the gate is rejected with
`high_risk_requires_gate`. A named approver, not the requester, must decide.
Every attempt, every grant check, the gate decision, and the version that acted
are written to the hash-chained, Ed25519-signed audit, so the record shows which
version was permitted to send which batch.

## What this does not prevent

Knight was deterministic, not an LLM, and MakerChecker is not a trading risk
engine or a CI/CD verifier. It does not detect a deployment mismatch between
servers or dead code left on a host. It governs the agents that act through
granted skills; it constrains the action only when the release and the order flow
run through gated, version-pinned skills. Code that calls the market outside the
control plane is outside its reach.
