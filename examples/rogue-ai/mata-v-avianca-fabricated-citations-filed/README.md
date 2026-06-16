# Mata v Avianca: A Hallucinated Brief Reached a Federal Court

In 2023, attorneys filed a brief in the Southern District of New York that cited
six cases ChatGPT had fabricated, then doubled down by submitting fake excerpts
when the citations were questioned. Judge Castel found bad faith and sanctioned
the attorneys and their firm 5,000 dollars under Rule 11. Sources:
[Mata v. Avianca, Inc. (Wikipedia)](https://en.wikipedia.org/wiki/Mata_v._Avianca,_Inc.),
[Seyfarth analysis](https://www.seyfarth.com/news-insights/update-on-the-chatgpt-case-counsel-who-submitted-fake-cases-are-sanctioned.html),
[court opinion (PDF)](https://www.law.berkeley.edu/wp-content/uploads/archive/2025/12/Mata-v-Avianca-Inc.pdf).
Full analysis: https://makerchecker.ai/insights/mata-v-avianca-fabricated-citations-filed/.

## The risk

A drafting agent produced a brief and the same actor moved it to filing. The
consequential action is the filing itself: submitting a document to a federal
court docket. That submission is a representation to the court under Rule 11, and
once on the docket it cannot be quietly withdrawn. The drafter both wrote the
brief and controlled the path that put it before the judge, with no separate
party accountable for the version that was filed.

## The MakerChecker configuration

Split the work by reversibility. Drafting and internal citation lookup are
reversible and stay with the drafting role, which can run them before any gate.
Filing to the court docket is the irreversible action, so it is a high-risk skill
the drafter does not hold and the flow grammar forces through an approval gate.
The named supervising attorney who clears the gate is the actor granted the
filing skill, and the gate is segregated so the drafter cannot clear their own
work.

Skills (`name@version`, `risk_tier`):

- `brief-draft@1`, `risk_tier: low`. Compose and revise the brief; produces a
  document, files nothing.
- `citation-lookup@1`, `risk_tier: low`. Query the internal case database for
  candidate authorities. Reversible reads, no external effect.
- `court-file@1`, `risk_tier: high`. Submit a specific brief version to the
  court docket. **Granted only to the supervising attorney, through the gated
  flow below.**

Roles and grants (deny by default; only listed grants exist):

```yaml
roles:
  - name: drafting-attorney
    grants:
      - brief-draft@1        # risk_tier: low
      - citation-lookup@1    # risk_tier: low
      # no court-file grant: the drafter cannot file to the docket

  - name: supervising-attorney
    grants:
      - court-file@1         # risk_tier: high -> forces the gate

skills:
  - name: brief-draft@1
    risk_tier: low
  - name: citation-lookup@1
    risk_tier: low
  - name: court-file@1
    risk_tier: high

sod_constraints:
  - [drafting-attorney, supervising-attorney]
```

Flow steps (`flow.yaml`-style). The filing step uses a high-risk skill, so
publishing this flow without the `approval_gate` before it is rejected at publish
time with `high_risk_requires_gate`:

```yaml
name: gated-court-filing
steps:
  - key: draft
    agent: drafting-attorney
    skills: [brief-draft@1, citation-lookup@1]
    instructions: >-
      Draft the brief and assemble its authorities for review. Identify the
      exact version intended for filing. Do not file.
    timeout_ms: 120000
  - key: filing_review
    type: approval_gate
    title: Approve the brief version before filing
    approvals:
      min_approvals: 1
      approver_emails: ["supervising-attorney@example.com"]
      forbid_requester: true
  - key: file
    agent: supervising-attorney
    skills: [court-file@1]
    instructions: >-
      File the approved brief version to the court docket exactly as reviewed.
    timeout_ms: 120000
```

## What happens

1. The drafting agent writes the brief and looks up authorities through
   `brief-draft@1` and `citation-lookup@1`. Both are reversible and granted, so
   they run pre-gate.
2. The agent then attempts to file through `court-file@1`. The drafting role does
   not hold that skill, so deny-by-default refuses the call before anything
   reaches the docket. The brief cannot be filed by the actor that drafted it.
3. Filing only proceeds through the `gated-court-filing` flow, where it parks at
   the `filing_review` gate for the named supervising attorney. The gate is
   identity-mode (`forbid_requester: true`): the user who triggered the run gets
   a 403 if they try to decide it, and unauthenticated decisions are refused
   outright (fail closed). Sign-off must come from
   `supervising-attorney@example.com`, a different user than the requester.
4. The refused attempt and the gate decision are written to the hash-chained,
   Ed25519-signed audit. The record shows the filing was attempted, that it was
   held, who approved it, which brief version was cleared, and which skill
   version acted.

## What this does not prevent

This intercepts the filing and makes a named human accountable for the version
that goes out; it does not check the brief. It does not stop the hallucination,
verify that the cited cases exist, or detect the fabricated excerpts. If the
supervising attorney rubber-stamps the gate, the bad filing still reaches the
docket. The guarantee is narrower and concrete: the drafter cannot file their own
work, a named approver must sign before the docket is touched, and the signed
audit records who approved which version.
