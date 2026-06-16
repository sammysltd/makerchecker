# 1.2 Seconds Per Denial: Cigna's PxDx Rubber-Stamp Problem

A 2023 ProPublica investigation and a California class action revealed that
Cigna used a system called PxDx to deny more than 300,000 requests in two months
in 2022, averaging about 1.2 seconds per decision, with company doctors signing
off on denials in batches without reviewing the individual claims. In March 2025
a court let the class claims proceed.

Sources:
- https://www.cbsnews.com/news/cigna-algorithm-patient-claims-lawsuit/
- https://www.healthcaredive.com/news/cigna-lawsuit-algorithm-claims-denials-california/688857/
- https://www.courthousenews.com/judge-advances-class-claims-over-cigna-use-of-automated-algorithm-to-deny-benefits/

Full analysis: https://makerchecker.ai/insights/cigna-pxdx-batch-rubber-stamp-denials/

## The risk

A claims system can produce a denial and have a reviewer finalize it without the
reviewer reading the claim. The consequential action is the committed denial.
The PxDx pattern was not an ungranted action or a missing gate. A reviewer did
sign each denial. The failure was that sign-off took about 1.2 seconds and ran
in batches, so the human step existed on paper while reviewing nothing. The harm
ran at scale because a committed denial stands unless the member appeals, and
almost none did.

## The MakerChecker configuration

The work splits by reversibility, the same as the other coverage examples in
this repo. Producing a recommendation and assembling the claim file are
reversible: low-risk skills the assessing role holds and runs pre-gate.
Committing the denial is the irreversible step, so it is modeled as a high-risk
skill, and the flow grammar forces an approval gate before any step that uses
it. The assessing role never holds the commit skill.

What this example adds is not a stronger block. It is the audit. The gate
records, per decision, the reviewer's identity and the elapsed time between the
claim being presented and the decision being signed. A batch of denials cleared
at sub-second intervals by one reviewer becomes a visible, attributable pattern
in the signed log rather than an internal metric only the insurer could see.

Skills:

- `coverage-assess@1`, `risk_tier: low` (evaluate the request against policy and
  produce a recommendation; commits nothing)
- `claim-file-build@1`, `risk_tier: low` (assemble the claim record and the
  basis for the recommendation)
- `coverage-deny-commit@1`, `risk_tier: high` (finalizes a denial against the
  member's benefit; **not granted** to the assessing role)

Roles and grants (deny by default; only listed grants exist):

```yaml
roles:
  - name: claims-assessor
    grants:
      - coverage-assess@1     # risk_tier: low
      - claim-file-build@1    # risk_tier: low
      # no commit grant: the assessor cannot finalize a denial

  - name: medical-reviewer
    grants:
      - coverage-deny-commit@1   # risk_tier: high -> forces the gate

skills:
  - name: coverage-assess@1
    risk_tier: low
  - name: claim-file-build@1
    risk_tier: low
  - name: coverage-deny-commit@1
    risk_tier: high

sod_constraints:
  - [claims-assessor, medical-reviewer]   # assessor cannot finalize its own denial
```

Flow steps (`flow.yaml`-style). The commit step uses a high-risk skill, so
publishing this flow without the `approval_gate` before it is rejected at
publish time with `high_risk_requires_gate`:

```yaml
name: coverage-claim-decision
steps:
  - key: assess
    agent: claims-assessor
    skills: [coverage-assess@1, claim-file-build@1]
    instructions: >-
      Evaluate the claim against policy and assemble the claim file with the
      recommendation and its basis. Do not commit a denial.
    timeout_ms: 120000
  - key: medical_review
    type: approval_gate
    title: Named medical reviewer must sign each denial before it commits
    approvals:
      min_approvals: 1
      approver_emails: ["medical-reviewer@example.com"]
      forbid_requester: true
  - key: commit
    agent: medical-reviewer
    skills: [coverage-deny-commit@1]
    instructions: >-
      Review the claim file and, if denying, commit the denial with a recorded
      basis.
    timeout_ms: 120000
```

The gate is identity-mode (`forbid_requester: true`): the assessing identity
cannot also sign the denial, so the proposing system cannot finalize its own
output, and unauthenticated decisions are refused outright (fail closed).

## What happens

1. The `claims-assessor` agent evaluates the claim and builds the claim file
   pre-gate, because both skills are reversible and granted.
2. If it attempts to finalize a denial, deny-by-default refuses: the role holds
   no `coverage-deny-commit@1` grant, so the call never reaches a tool body. A
   denial only proceeds through the `coverage-claim-decision` flow, where it
   parks at the `medical_review` gate.
3. A named medical reviewer, a different identity than the assessor under
   `forbid_requester`, must decide. The decision records the reviewer's identity
   and the time the claim was held at the gate before sign-off.
4. The recommendation, the ungranted-commit refusal, the denial held at the
   gate, the reviewer identity, the elapsed review time, and the basis they
   recorded are written to the hash-chained, Ed25519-signed audit. A run of
   denials signed at 1.2-second intervals surfaces in that log as a sequence of
   sub-second reviews by one identity, which is exactly the evidence regulators
   and plaintiffs otherwise had to fight to obtain.

## What this does not prevent

It cannot force a reviewer to actually read a claim or judge whether a denial is
correct. A determined reviewer can still click through at speed, and a denial
the reviewer rubber-stamps still commits and still harms the member. A gate the
human ignores is not, by itself, a control. What MakerChecker changes here is
narrower and real: the ignoring becomes provable. Every denial carries a signed
record of who finalized it and how long they spent, so a 1.2-second batch
pattern is attributable rather than deniable.
