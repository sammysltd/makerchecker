# Robodebt: Removing the Human From a Debt Notice

From 2015 to 2019 the Australian government's Robodebt scheme used automated
income averaging to raise welfare debts and issue debt notices, removing the
human review that had previously checked each determination so that notices went
out unreviewed. The scheme wrongly accused roughly 400,000 people and unlawfully
recovered about A$1.76 billion. A 2023 Royal Commission found it crude, cruel,
and unlawful.

Sources:
- https://robodebt.royalcommission.gov.au/publications/report
- https://lsj.com.au/articles/crude-cruel-and-unlawful-robodebt-royal-commission-findings/
- https://www.bsg.ox.ac.uk/blog/australias-robodebt-scheme-tragic-case-public-policy-failure

Full analysis: https://makerchecker.ai/insights/australia-robodebt-automated-debt-recovery/

This was deterministic government software, not an LLM. It is included because
the control shape is the one agentic systems reproduce: an automated decision
committed against a person with the human review removed from the path.

## The risk

A determination system calculates a debt from averaged income data and then
issues the debt notice itself. The consequential action is the committed
issuance: a notice that asserts a debt against a named citizen and starts
recovery. Once removed, the human check was no longer a step the determination
had to pass, so a flawed calculation became an issued debt with no named officer
behind it and no per-debt record of who authorised it.

## The MakerChecker configuration

The work splits by reversibility. Calculating a debt and assembling the
proposed notice is reversible: a proposed debt is neither issued nor in
recovery, so the calculating role does that pre-gate with no approval. Issuing
the notice is the one-way door and is modeled as a high-risk skill, so the flow
grammar forces an approval gate before the step that uses it. Segregation of
duties keeps the system that calculated a debt from being the identity that
finalises it.

- `debt-calculate@1` is `risk_tier: low`. The calculator role holds it and runs
  it pre-gate to compute the debt and stage the proposed notice.
- `debt-issue@1` is `risk_tier: high`. It commits a notice and starts recovery.
  It is **not granted** to the calculator role at all, so the system that
  produced the figure cannot issue the notice. Issuance can only travel as a
  request for this skill, which the flow grammar holds at an approval gate for a
  named officer.

Flow steps (`flow.yaml`-style). The issue step uses a high-risk skill, so
publishing this flow without the `approval_gate` before it is rejected at
publish time with `high_risk_requires_gate`:

```yaml
name: debt-determination
steps:
  - key: calculate
    agent: debt-calculator
    skills: [debt-calculate@1]
    instructions: >-
      Calculate the debt from the income data and stage the proposed notice.
      Do not issue it.
    timeout_ms: 120000
  - key: determination_review
    type: approval_gate
    title: Approve the debt determination before the notice is issued
    approvals:
      min_approvals: 1
      approver_emails: ["review-officer@example.gov"]
      forbid_requester: true
  - key: issue
    agent: notice-issuer
    skills: [debt-issue@1]
    instructions: >-
      Issue the approved debt notice exactly as determined.
    timeout_ms: 120000
```

Roles and grants (deny by default; only listed grants exist):

```yaml
roles:
  - name: debt-calculator
    grants:
      - debt-calculate@1     # risk_tier: low
      # no issue grant: the calculator cannot issue a notice
  - name: notice-issuer
    grants:
      - debt-issue@1         # risk_tier: high -> forces the gate

skills:
  - name: debt-calculate@1
    risk_tier: low
  - name: debt-issue@1
    risk_tier: high

sod_constraints:
  - [debt-calculator, notice-issuer]   # calculator cannot finalise its own debt
```

## What happens

1. The `debt-calculator` agent computes the debt and stages the proposed notice
   pre-gate with no approval, because staging is reversible.
2. If it attempts to issue, deny-by-default refuses: the calculator role holds
   no `debt-issue@1` grant, so the call never reaches a tool body. A notice only
   proceeds through the `debt-determination` flow, where it parks at the
   `determination_review` gate.
3. The gate is identity-mode (`forbid_requester: true`): the identity that
   triggered the determination gets a 403 if it tries to decide, and
   unauthenticated decisions are refused outright (fail closed). Sign-off must
   come from a named review officer, a different identity than the requester.
4. The staged proposal, the refused issue attempt, the gate decision, and the
   version that acted are written to the hash-chained, Ed25519-signed audit. Each
   issued debt carries a per-debt record of who authorised it and on what basis.

## What this does not prevent

This does not fix the flawed income-averaging method or settle the legal
question of whether the debts were lawful. If a named officer signs off on a
debt that the averaging got wrong, the notice still issues and the harm still
occurs. Its guarantee is narrower: no notice issues without authorisation, the
calculator cannot finalise its own determination, and every issued debt carries
a signed record of who authorised it, which forces accountability and likely
surfaces the problem earlier than an unreviewed pipeline would.
