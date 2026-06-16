# The Agent That Spent $6,500 on AWS to Scan a Hobbyist Network

Between 9 and 10 May 2026 an AI agent told to scan the DN42 hobbyist network
provisioned five AWS `m8g.12xlarge` instances along with load balancers and
Lambda functions, then redeployed duplicates of the same resources in a loop. It
ran up a verified bill of $6,531.30 in about 24 hours. The operator had told it
to continue without reviewing each step.

Sources:
- https://lantian.pub/en/article/fun/ai-agent-bankrupted-their-operator-scan-dn42lantian.lantian/
- https://www.bovo-digital.tech/en/blog/ai-agent-aws-bill-6531-dn42-bankrupt
- https://decrypt.co/370988/ai-agent-rekts-dev-bogus-scan-crypto-donations

Full analysis: https://makerchecker.ai/insights/dn42-agent-runaway-aws-cloud-bill/

## The risk

The consequential action is provisioning paid cloud infrastructure on the
agent's own authority, repeated without a checkpoint. A scan task needed a small
amount of compute. The agent provisioned five large instances plus load
balancers and Lambda, then redeployed duplicates because nothing stopped the
loop. Each provision call was a real spend with no per-action ceiling the role
could not exceed and no second person whose sign-off the deploy could not
proceed without. The operator's blanket "continue" authorized every iteration.

## The MakerChecker configuration

The action splits by tier, and the instance class and count are what the skill
grant governs. Inspecting the environment, planning a deployment, and tearing
down resources are the safe, reversible directions: the agent does those
pre-gate with no approval. Provisioning paid compute is the one-way door for the
bill, and it is split into two distinct skills by size.

Argument-level limits such as instance class and count are not expressed as
flags on one skill. The small tier is a distinct high-risk skill that carries
the tier as its grant bound; anything larger is a call to a skill the role does
not hold.

- `cloud-inspect@1` is `risk_tier: low`. The agent's role holds it and runs it
  pre-gate to list resources, regions, and current spend.
- `cloud-teardown@1` is `risk_tier: low`. Releasing resources the agent created.
  The safe direction, reversible toward zero cost; runs pre-gate.
- `cloud-provision-small@1` is `risk_tier: high`, bounded to a small tier (one
  instance, capped class, per the grant). Provisioning within tier is the
  routine path, and the high tier forces it through the per-deploy approval gate.
- `cloud-provision-large@1` is `risk_tier: high` and is **not granted** to the
  scan role at all. Five large instances is over the granted tier, so the
  request can only travel as this skill, which deny-by-default refuses.

```yaml
# flow.yaml (steps)
name: network-scan-provisioning
steps:
  - key: plan
    agent: scan-agent
    skills: [cloud-inspect@1]
    instructions: >-
      Inspect the account, regions, and current spend, and produce a deployment
      plan sized to the scan. Do not provision.
    retries: { max_attempts: 3, backoff: exponential }
    timeout_ms: 120000
  - key: provision_decision
    type: approval_gate
    title: Each paid deploy requires named sign-off before it runs
    approvals: { min_approvals: 1, forbid_requester: true }
  - key: provision
    agent: scan-agent
    skills: [cloud-provision-small@1]
    instructions: >-
      Provision the approved small-tier resources only, for this deploy. A
      larger class or count is out of scope for this role.
    timeout_ms: 120000
  - key: teardown
    agent: scan-agent
    skills: [cloud-teardown@1]
    instructions: >-
      Release the resources created for the scan when it completes.
    timeout_ms: 120000
```

```yaml
# roles / grants (deny by default; only listed grants exist)
roles:
  - role: scan-agent@1
    limits: { skills: { "cloud-inspect@1": { maxInvocationsPerRun: 20 } } }
    grants:
      - cloud-inspect@1            # low risk, pre-gate
      - cloud-teardown@1           # low risk, pre-gate, reversible toward zero cost
      - cloud-provision-small@1    # high risk, bounded to small tier, gated per deploy
      # cloud-provision-large@1 is NOT granted: over-tier provisioning is denied by default
  - role: infra-owner@1
    grants:
      - cloud-provision-large@1    # only granted where large provisioning is a real duty
gate:
  step: provision_decision
  forbid_requester: true          # the agent that planned the deploy cannot self-approve it
```

The tier is the argument bound on `cloud-provision-small@1`; five large
instances is not a bigger version of the same call the role can stretch to
cover, it is a call to `cloud-provision-large@1`, which the role does not hold.
The gate sits before each provision step, so the redeploy loop hits a fresh
sign-off every iteration instead of running on a single blanket "continue."

## What happens

1. The agent inspects the account and current spend with `cloud-inspect@1` and
   produces a sized plan. Inspection is low risk and runs without a gate.
2. The agent attempts five `m8g.12xlarge` instances. That is over the granted
   tier, so the request resolves to `cloud-provision-large@1`, a skill the scan
   role was never granted. Deny-by-default refuses the call before any resource
   is created. The blanket "continue" does not change the decision, because
   authorization is on the action and its tier, not on a standing approval.
3. A within-tier deploy travels as `cloud-provision-small@1`. The high tier
   routes it to the `provision_decision` gate, where a named owner signs off and
   `forbid_requester` stops the agent from approving its own deploy. The
   redeploy loop meets the gate again on the next iteration rather than firing
   duplicates unattended.
4. Each step is written in the same transaction as its audit event: the plan,
   the refused over-tier call, the routing to the gate, and the named sign-off
   or rejection. The events are hash-chained and Ed25519-signed, so the record
   of what was attempted, what ran, and who approved it verifies offline. That
   record is what a cost dispute with the provider would rest on.

## What this does not prevent

This is not a billing meter and not a hard dollar cap. It does not count spend
or stop the agent once a budget number is hit. A blanket "continue" from the
operator still authorizes whatever the role is granted, so the defense is the
per-action tier limit and the per-deploy gate, not the standing instruction. If
a within-tier deploy is approved repeatedly, cost still accrues; what changes is
that over-tier provisioning is refused outright and every paid deploy needs a
named sign-off instead of running on the agent's own authority.
