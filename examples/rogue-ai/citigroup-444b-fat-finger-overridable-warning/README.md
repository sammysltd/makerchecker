# Citigroup $444B Basket: A Warning You Can Dismiss Is Not a Control

On 2 May 2022 a Citigroup trader meant to sell a $58M basket and instead built
one of $444B. Internal controls blocked $255B, but $189B reached the execution
algorithm and roughly $1.4B sold before the trader cancelled, briefly crashing
the OMX Stockholm 30 by about 8 percent. The trader had dismissed 711 pop-up
warnings on the way to releasing the order. The FCA and PRA fined Citigroup
£61.6M in May 2024. The warnings were overridable; nothing was a hard block.

Sources:
- https://www.cnn.com/2024/05/22/investing/citigroup-fine-stock-dump-fat-finger/index.html
- https://www.bloomberg.com/news/articles/2024-05-22/citigroup-fined-61-6-million-over-fat-finger-trading-blunder
- https://www.marketsmedia.com/citi-fined-61-6m-for-fat-finger-trade/

Full analysis: https://makerchecker.ai/insights/citigroup-444b-fat-finger-overridable-warning/

## The risk

An execution agent submits a basket order whose notional is orders of magnitude
larger than intended. The releasing identity sees warnings but can clear them
the same way the trader cleared 711 pop-ups: by clicking through. There is no
notional ceiling the role cannot exceed on its own, and no second person whose
sign-off the order cannot proceed without.

## The MakerChecker configuration

The action splits by notional, and notional is what the skill grant governs.
Building, pricing, and validating the basket is the safe, reversible direction:
a staged order is neither in the market nor irreversible, so the agent does that
pre-gate with no approval. Submitting to the algo is the one-way door, and it is
split into two distinct skills by size.

- `basket-stage@1` is `risk_tier: low`. The execution agent's role holds it and
  runs it before any gate to assemble and validate the order.
- `trade-submit-capped@1` is `risk_tier: high`, bounded to a role notional cap.
  Submitting at or below the cap is the routine path. The grant carries the cap
  as the skill argument limit, so a $444B basket is over the cap and is refused
  outright by deny-by-default. There is no override on the agent side.
- `trade-submit-uncapped@1` is `risk_tier: high` and is **not granted** to the
  execution role at all. Any over-cap submission can only travel as a request
  for this skill, which the flow grammar forces through an approval gate before
  it runs. The trader cannot dismiss a gate.

```yaml
# flow.yaml (steps)
name: basket-order-submission
steps:
  - key: stage
    agent: execution-agent
    skills: [basket-stage@1]
    instructions: >-
      Assemble and price the basket, validate constituents and notional, and
      stage the order. Do not submit.
    timeout_ms: 120000
  - key: submit
    agent: execution-agent
    skills: [trade-submit-capped@1]
    instructions: >-
      Submit the staged basket only if its notional is within the role cap.
    timeout_ms: 120000
  - key: oversize_release
    type: approval_gate
    title: Over-cap basket requires desk-head sign-off before release
```

```yaml
# roles / grants (deny by default; only listed grants exist)
roles:
  - role: execution-agent@3
    grants:
      - basket-stage@1            # low risk, pre-gate, reversible
      - trade-submit-capped@1     # high risk, bounded to role notional cap
      # trade-submit-uncapped@1 is NOT granted: over-cap release is denied by default
  - role: desk-head@2
    grants:
      - trade-submit-uncapped@1   # high risk, only reachable past the gate
gate:
  step: oversize_release
  forbid_requester: true         # the agent that staged the order cannot self-approve its release
```

The role cap is expressed as the argument bound on `trade-submit-capped@1`; a
notional above it is not a smaller skill the role can stretch to cover, it is a
call to a skill the role does not hold. The cap is a hard number, not a prompt.

## What happens

1. The execution agent stages the $444B basket with `basket-stage@1`. Staging
   is low risk and reversible, so it runs with no gate.
2. The agent calls `trade-submit-capped@1`. The notional is over the role cap,
   so the argument bound is exceeded and deny-by-default refuses the call. There
   is no pop-up to dismiss and no override. The attempt is recorded.
3. The only remaining path to release is `trade-submit-uncapped@1`, which the
   execution role is not granted. The flow routes the over-cap release to the
   `oversize_release` approval gate, where it waits for a named desk head. The
   agent that staged the order cannot decide the gate (`forbid_requester`), and
   an unauthenticated decision is refused (fail closed).
4. Every step is written in the same transaction as its audit event: the staged
   order, the refused over-cap call, the routing to the gate, and the named
   sign-off (or rejection). The events are hash-chained and Ed25519-signed, so
   the record of what was attempted and who released it verifies offline.

## What this does not prevent

This does not stop the wrong number being entered and it does not validate the
economics of the trade. If a number is fat-fingered, it is still fat-fingered.
What changes is that the order cannot be released on the agent's own authority
once it crosses the cap, and the warning that the trader dismissed 711 times
becomes a non-bypassable gate requiring another person's sign-off. The missing
hard block is supplied; the typo is not caught.
