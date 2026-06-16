# nH Predict: An Algorithm Denying Medicare Care With a 90 Percent Reversal Rate

A class action filed around November 2023 in Minnesota alleges that UnitedHealth
and NaviHealth used a model called nH Predict to override treating physicians and
deny post-acute care to Medicare Advantage members, at a roughly 90 percent error
rate, relying on the fact that only about 0.2 percent of members appealed. Across
2025 to 2026 the court let breach-of-contract claims proceed and ordered broad
discovery into the model and how its outputs were used. Sources:
[CBS News](https://www.cbsnews.com/news/unitedhealth-lawsuit-ai-deny-claims-medicare-advantage-health-insurance-denials/),
[Healthcare Finance News](https://www.healthcarefinancenews.com/news/class-action-lawsuit-against-unitedhealths-ai-claim-denials-advances),
[ArentFox Schiff alert](https://www.afslaw.com/perspectives/alerts/federal-court-orders-broad-discovery-against-uhc-ai-coverage-denial-lawsuit).
Full analysis: https://makerchecker.ai/insights/unitedhealth-nhpredict-ai-medicare-denials/.

## The risk

A coverage-decision system can commit a denial of post-acute care, terminating
the member's benefit, with no named clinician signing the decision and no record
of who approved it or on what basis. The consequential action is the committed
denial. There is no separation between the system that proposes a denial and the
act of finalizing it, and the harm runs at scale because the committed denial is
treated as final unless the member appeals.

## The MakerChecker configuration

The action is split by reversibility. Producing a recommendation and assembling
the case file are reversible: they are low-risk skills the role holds and runs
pre-gate. Committing the denial is the irreversible, consequential step, so it is
modeled as a high-risk skill, and any flow step that uses a high-risk skill is
forced through an approval gate by the flow grammar. The role that runs the
assessment never holds the commit skill at all; it can recommend, but it cannot
finalize.

Skills:

- `coverage-assess@1`, `risk_tier: low` (evaluate the request against policy and
  produce a recommendation; commits nothing)
- `case-file-build@1`, `risk_tier: low` (assemble the clinical record and the
  basis for the recommendation)
- `coverage-deny-commit@1`, `risk_tier: high` (finalizes a denial against the
  member's benefit; **not granted** to the assessing role)

Roles and grants (deny by default; only listed grants exist):

```yaml
roles:
  - name: coverage-assessor
    grants:
      - coverage-assess@1     # risk_tier: low
      - case-file-build@1     # risk_tier: low
      # no commit grant: the assessor cannot finalize a denial

  - name: clinician-reviewer
    grants:
      - coverage-deny-commit@1   # risk_tier: high -> forces the gate

skills:
  - name: coverage-assess@1
    risk_tier: low
  - name: case-file-build@1
    risk_tier: low
  - name: coverage-deny-commit@1
    risk_tier: high
```

Flow steps (`flow.yaml`-style):

```yaml
name: medicare-coverage-decision
steps:
  - key: assess
    agent: coverage-assessor
    skills: [coverage-assess@1, case-file-build@1]
    instructions: >-
      Evaluate the post-acute coverage request against policy and assemble the
      case file with the recommendation and its basis. Do not commit a denial.
    timeout_ms: 120000
  - key: clinician_review
    type: approval_gate
    title: Named clinician must sign each denial before it commits
  - key: commit
    agent: clinician-reviewer
    skills: [coverage-deny-commit@1]
    instructions: >-
      Review the case file and, if denying, commit the denial with a recorded
      basis.
    timeout_ms: 120000
```

The gate is identity-mode (`forbid_requester`): the assessor that produced the
recommendation cannot also sign the denial, so the proposing system cannot
finalize its own output.

## What happens

The `coverage-assessor` agent evaluates the request and builds the case file
pre-gate, because both skills are reversible and granted. If it attempts to
finalize a denial, deny-by-default refuses: the role holds no commit grant, so
the call never reaches a tool body. A denial requires `coverage-deny-commit@1`,
which is `risk_tier: high`, so the flow grammar holds the run at the
`clinician_review` gate. Publishing this flow without the gate is rejected with
`high_risk_requires_gate`. A named clinician, not the assessor, must decide.
Because the gate is `forbid_requester`, the proposing role cannot sign its own
recommendation. Every step is recorded: the recommendation, the ungranted-commit
refusal, the denial held at the gate, the reviewer's identity, and the basis they
recorded are written to the hash-chained, Ed25519-signed audit. That per-decision
record is exactly the evidence the plaintiffs had to fight discovery to obtain.

## What this does not prevent

It does not fix the alleged 90 percent error rate. If a clinician signs off on a
wrong denial, the harm still occurs. MakerChecker forces a named human to commit
each denial and records who approved it on what basis; it does not judge whether
the denial is clinically correct. It ensures accountability, not accuracy.
