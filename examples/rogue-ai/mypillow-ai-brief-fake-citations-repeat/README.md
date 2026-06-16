# The MyPillow Brief: 30 Fake AI Citations, Then a Repeat Offense

In 2025, attorneys for Mike Lindell filed a Denver motion containing about 30
defective citations produced with AI, including citations to nonexistent cases.
In July 2025, Judge Nina Wang fined each attorney 3,000 dollars. In May 2026,
Christopher Kachouroff and his firm were sanctioned again, 5,000 dollars, over
another flawed citation in a later filing. Sources:
[Colorado Sun](https://coloradosun.com/2025/07/07/mike-lindell-attorneys-fined-artificial-intelligence/),
[Law&Crime](https://lawandcrime.com/high-profile/puzzlingly-defiant-judge-sanctions-mike-lindells-lawyers-over-ai-generated-filing-rife-with-cites-to-nonexistent-cases-excoriates-their-troubling-explanation/),
[Colorado Politics](https://www.coloradopolitics.com/2026/05/08/mike-lindells-lawyer-sanctioned-again-over-flawed-case-citations/).
Full analysis: https://makerchecker.ai/insights/mypillow-ai-brief-fake-citations-repeat/.

## The risk

Drafting a brief is reversible. Filing it with the court is not: once a motion is
on the docket, the fabricated citations are in the record, and the sanction
follows the filing, not the draft. The consequential action is the act of
submission. The repeat offense is the part to govern directly. A control that
fires once and is then trusted is worthless here, because the second filing came
after the first sanction. The gate has to fire on every submission, including the
next version of the same brief.

## The MakerChecker configuration

Split the work by reversibility. Drafting the brief and running citation
verification are reversible, so the drafting role holds those skills and runs them
pre-gate. Submitting to the court is the irreversible, consequential step, so it
is modeled as a high-risk skill, and any flow step that uses a high-risk skill is
forced through an approval gate by the flow grammar. The drafting role never holds
a submission skill. An unbounded "file anything" skill exists in the catalog and
is granted to no role, so a self-issued instruction to file is refused by
deny-by-default. The bounded submission skill requires a completed verification
record as its own argument check, modeled as a distinct high-risk skill: it will
not accept arguments that lack a passing citation-verification result for the
exact draft version being filed.

Skills (`name@version`, `risk_tier`):

- `brief-draft@1`, `risk_tier: low`. Compose or revise the motion; produces a
  draft, files nothing.
- `cite-verify@1`, `risk_tier: low`. Check each citation against an authority
  source and produce a verification record bound to the draft version.
- `court-file-verified@1`, `risk_tier: high`. Submits a specific draft version
  to the court, and only accepts arguments carrying a passing `cite-verify@1`
  record for that exact version; the version binding is the skill's own argument
  check, modeled as a distinct high-risk skill.
- `court-file-open@1`, `risk_tier: high`. Submits an arbitrary filing with no
  verification requirement; exists in the catalog but is **not granted** to any
  role.

Roles and grants (deny by default; only listed grants exist):

```yaml
roles:
  - name: brief-author
    grants:
      - brief-draft@1       # risk_tier: low
      - cite-verify@1       # risk_tier: low
      # no filing grant: the author cannot submit to the court

  - name: supervising-attorney
    grants:
      - court-file-verified@1   # risk_tier: high -> forces the gate

skills:
  - name: brief-draft@1
    risk_tier: low
  - name: cite-verify@1
    risk_tier: low
  - name: court-file-verified@1
    risk_tier: high
  - name: court-file-open@1
    risk_tier: high
```

Flow steps (`flow.yaml`-style). The submission step uses a high-risk skill, so
publishing this flow without the `approval_gate` before it is rejected at publish
time with `high_risk_requires_gate`:

```yaml
name: court-filing
steps:
  - key: draft_and_verify
    agent: brief-author
    skills: [brief-draft@1, cite-verify@1]
    instructions: >-
      Draft or revise the motion and run citation verification, producing a
      verification record bound to this draft version. Do not file.
    timeout_ms: 120000
  - key: filing_review
    type: approval_gate
    title: Named attorney must sign before each submission
    approvals:
      min_approvals: 1
      approver_emails: ["supervising-attorney@example.com"]
      forbid_requester: true
  - key: file
    agent: supervising-attorney
    skills: [court-file-verified@1]
    instructions: >-
      Submit the approved draft version. The skill rejects any submission whose
      arguments lack a passing verification record for that exact version.
    timeout_ms: 120000
```

The gate carries `forbid_requester: true`: the agent that drafted the brief
cannot also sign off on filing it, so a self-issued instruction cannot self-clear.

## What happens

1. The agent drafts the brief and runs `cite-verify@1`, because both are
   reversible and granted. It may still produce a draft containing fabricated
   citations; verification is what surfaces them.
2. The agent attempts to file directly through `court-file-open@1`. The
   brief-author role does not hold that skill, so deny-by-default refuses the
   call before it reaches a tool body. The draft is never submitted on its own
   authority.
3. A legitimate submission proceeds only through the `court-filing` flow, where it
   parks at the `filing_review` gate for the named supervising attorney. Because
   `court-file-verified@1` requires a passing verification record for the exact
   draft version, a revised version with new citations re-triggers verification
   and the gate, so the second filing cannot ride on the first one's sign-off.
4. The gate is identity-mode (`forbid_requester: true`): the author who drafted
   the brief gets a 403 if they try to decide it, and unauthenticated decisions
   are refused outright (fail closed). Sign-off must come from
   `supervising-attorney@example.com`, a different user than the requester.
5. The refused attempt, the verification record, the held filing, the approver's
   identity, and the version filed are written to the hash-chained, Ed25519-signed
   audit, verifiable offline. The per-version record clarifies which draft was
   actually filed, the dispute at the center of the "wrong version" defense.

## What this does not prevent

It does not stop the AI tool from producing fabricated citations. MakerChecker
constrains and records the filing action, not the content of the draft. If the
supervising attorney signs off without reading the verification record, a brief
with bad citations can still reach the docket. The value is narrower: filing is
ungranted to the author, every submission is held for a named human, each version
re-triggers the gate, and who approved which version is recorded. It governs the
act of filing, not whether the citations are real.
