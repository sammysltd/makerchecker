# Everbright: A Trading Glitch, Then a Cover Trade Before the Public Knew

On 16 August 2013 a fault in China Everbright Securities' arbitrage system
generated about 23.4 billion yuan in erroneous buy orders, of which roughly 7.27
billion yuan filled, spiking the Shanghai Composite by about 6 percent. Before
disclosing the error to the market, Everbright hedged its exposure by shorting
ETFs and index futures on the basis of the non-public information. The CSRC fined
the firm 523 million yuan for insider trading and imposed lifetime market bans on
the individuals involved.

Sources:
- https://money.cnn.com/2013/09/02/news/china-everbright-fine/
- https://www.scmp.com/business/banking-finance/article/1300692/china-everbright-securities-fined-523m-yuan-stock-market
- https://www.chinadaily.com.cn/business/2013-08/20/content_16908580.htm

Full analysis: https://makerchecker.ai/insights/everbright-securities-runaway-orders-and-insider-hedge/

## The risk

Two distinct consequential actions, one after the other. First, an arbitrage
agent placed a stream of live buy orders whose aggregate notional was orders of
magnitude beyond intent, with no ceiling it could not exceed on its own and no
gate between it and the market. Second, the same desk executed large hedging
trades on information the public did not yet have, with nobody independent
standing between the decision to hedge and its execution.

## The MakerChecker configuration

The two failures map to two controls, expressed across two flows.

For the runaway orders, order placement splits by notional, and notional is what
the skill grant governs. Building and validating an order batch is reversible and
runs pre-gate. Submitting to the market is the one-way door, split into two
high-risk skills by size:

- `arb-stage@1` is `risk_tier: low`. The arbitrage role holds it and assembles
  and validates the batch before any gate.
- `arb-submit-capped@1` is `risk_tier: high`, bounded to a role notional cap
  carried as the skill argument limit. A 23.4 billion yuan order stream is over
  the cap and is refused outright by deny-by-default. There is no override.
- `arb-submit-uncapped@1` is `risk_tier: high` and is **not granted** to the
  arbitrage role at all. Any over-cap submission can travel only as a request for
  this skill, which the flow grammar forces through an approval gate before it
  runs.

For the cover trade, the hedge is the consequential action and the constraint is
segregation of duties: the desk that holds the non-public error cannot also
effect the hedge unreviewed. Drafting a proposed hedge is reversible and stays
with the agent pre-gate. Effecting it is `risk_tier: high` and is held at an
approval gate that an independent approver, not the requesting desk, must sign.

```yaml
# flow.yaml (steps) - runaway order containment
name: arbitrage-order-submission
steps:
  - key: stage
    agent: arbitrage-agent
    skills: [arb-stage@1]
    instructions: >-
      Assemble and validate the arbitrage batch against position and notional
      limits. Stage the order. Do not submit.
    timeout_ms: 120000
  - key: submit
    agent: arbitrage-agent
    skills: [arb-submit-capped@1]
    instructions: >-
      Submit the staged batch only if its notional is within the role cap.
    timeout_ms: 120000
  - key: oversize_release
    type: approval_gate
    title: Over-cap order stream requires desk-head sign-off before release
```

```yaml
# flow.yaml (steps) - cover-trade segregation of duties
name: hedge-on-undisclosed-exposure
steps:
  - key: draft_hedge
    agent: hedging-agent
    skills: [hedge-draft@1]
    instructions: >-
      Draft a proposed hedge against the current exposure. Do not effect any
      trade.
    timeout_ms: 120000
  - key: hedge_decision
    type: approval_gate
    title: Hedge on material non-public exposure requires independent approval
    forbid_requester: true
  - key: effect_hedge
    agent: hedging-agent
    skills: [hedge-submit@1]
    instructions: >-
      Effect the approved hedge.
    timeout_ms: 120000
```

```yaml
# roles / grants (deny by default; only listed grants exist)
roles:
  - role: arbitrage-agent@2
    grants:
      - arb-stage@1            # low risk, pre-gate, reversible
      - arb-submit-capped@1    # high risk, bounded to role notional cap
      # arb-submit-uncapped@1 is NOT granted: over-cap release denied by default
  - role: hedging-agent@2
    grants:
      - hedge-draft@1          # low risk, pre-gate, reversible
      - hedge-submit@1         # high risk, only reachable past the gate
  - role: desk-head@2
    grants:
      - arb-submit-uncapped@1  # high risk, only reachable past the oversize gate

skills:
  - name: arb-stage@1
    risk_tier: low
  - name: arb-submit-capped@1
    risk_tier: high
  - name: arb-submit-uncapped@1
    risk_tier: high
  - name: hedge-draft@1
    risk_tier: low
  - name: hedge-submit@1
    risk_tier: high
```

The role cap is the argument bound on `arb-submit-capped@1`; a notional above it
is not a smaller skill the role can stretch to cover, it is a call to a skill the
role does not hold. On the hedge flow, `forbid_requester: true` means the desk
that drafted the hedge cannot sign its own release.

## What happens

1. The arbitrage agent stages the batch with `arb-stage@1`, which is low risk and
   reversible, so it runs with no gate.
2. The agent calls `arb-submit-capped@1` for the 23.4 billion yuan stream. The
   notional is over the role cap, the argument bound is exceeded, and
   deny-by-default refuses the call. There is no override.
3. The only remaining path to release is `arb-submit-uncapped@1`, which the
   arbitrage role is not granted. The flow routes the over-cap submission to the
   `oversize_release` approval gate, where it waits for a named desk head.
4. After the error, the hedging agent drafts the cover trade with `hedge-draft@1`
   pre-gate, then attempts `hedge-submit@1`, which is `risk_tier: high`. The flow
   grammar holds the run at the `hedge_decision` gate. Because the gate is
   `forbid_requester`, the desk that drafted the hedge cannot approve it, and an
   unauthenticated decision is refused (fail closed). An independent approver must
   sign before the hedge effects.
5. Each step is written in the same transaction as its audit event: the staged
   batch, the refused over-cap call, the routing to the oversize gate, the drafted
   hedge, and the named sign-off or rejection. The events are hash-chained and
   Ed25519-signed, so the record of what was attempted and who released it
   verifies offline.

## What this does not prevent

It does not fix the software defect that generated the erroneous orders, and it
does not judge whether trading on the undisclosed error is lawful. If an approver
signs off a hedge on material non-public information, the legal question stays
with the humans who decided. What changes is that the order stream cannot be
released on the agent's own authority once it crosses the cap, and the cover trade
cannot be effected by the same desk that holds the undisclosed exposure without an
independent person signing and a record being written.
