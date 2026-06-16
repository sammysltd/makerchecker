# Air Canada Was Bound by Its Chatbot's Invented Refund Policy

In November 2022 Air Canada's website chatbot told Jake Moffatt he could claim a
retroactive bereavement-fare discount within 90 days of booking. No such policy
existed. Moffatt booked on that basis, was later refused the discount, and took
the airline to the BC Civil Resolution Tribunal. In February 2024 the tribunal
found negligent misrepresentation and ordered Air Canada to honour the promise,
roughly 483 CAD, rejecting the argument that the chatbot was a separate entity
responsible for its own statements.

Sources:
- https://www.canlii.org/en/bc/bccrt/doc/2024/2024bccrt149/2024bccrt149.html
- https://www.mccarthy.ca/en/insights/blogs/techlex/moffatt-v-air-canada-misrepresentation-ai-chatbot
- https://www.pinsentmasons.com/out-law/news/air-canada-chatbot-case-highlights-ai-liability-risks

Full analysis: https://makerchecker.ai/insights/air-canada-chatbot-bereavement-refund-binding/

## The risk

The chatbot did two different things, and only one of them is the problem. It
answered a customer question, which is its job, and it bound the airline to a
financial obligation it invented. The consequential action is the binding
commitment: a refund promise the company is later held to in law. A wrong answer
is a content problem; a wrong commitment is a liability. The line MakerChecker
draws is between the bot answering and the bot binding the company, and only the
latter needs gating.

## The MakerChecker configuration

Split the customer-service work into separate skills by consequence. Answering
questions and quoting standard published policy is reversible and is a low-risk
skill the support role holds and runs with no gate. Committing the airline to a
refund is the dangerous action. It is not granted to the support role as an open
capability. A bounded commitment within published policy and under a fixed
threshold is modeled as a distinct argument-limited skill; any commitment above
that threshold, or outside standard policy, is a high-risk skill the flow grammar
forces through an approval gate, decided by a named agent who is not the
requester.

Argument-level limits matter here: a blanket refund-commit grant would let an
agent bind the company to any amount on any invented basis, which is exactly what
happened. The capped commitment is therefore a distinct skill scoped to the
threshold and the published policy set, not a flag on the answer skill.

Skills (`name@version`, `risk_tier`):

- `support-answer@1`, `risk_tier: low`. Answer customer questions and quote
  standard published policy. Produces text, binds nothing.
- `refund-commit-capped@1`, `risk_tier: high`. Effect a refund only within
  published policy and under a fixed threshold. Argument-limited: amount and
  policy basis are constrained at the skill boundary.
- `refund-commit@1`, `risk_tier: high`. Commit a refund of any amount or on a
  non-standard basis. **Granted only through the gated flow below.**

Roles and grants (deny by default; only listed grants exist):

```yaml
roles:
  - name: support-agent
    grants:
      - support-answer@1        # risk_tier: low
      # no open refund-commit grant: the bot cannot bind the airline on its own
  - name: refund-officer
    grants:
      - refund-commit-capped@1  # risk_tier: high (argument-limited)
      - refund-commit@1         # risk_tier: high -> forces the gate

skills:
  - name: support-answer@1
    risk_tier: low
  - name: refund-commit-capped@1
    risk_tier: high
  - name: refund-commit@1
    risk_tier: high

sod_constraints:
  - [support-agent, refund-officer]   # four-eye separation
```

Flow steps (`flow.yaml`-style). The commit step uses a high-risk skill, so
publishing this flow without the `approval_gate` before it is rejected at publish
time with `high_risk_requires_gate`:

```yaml
name: gated-refund-commitment
steps:
  - key: answer
    agent: support-agent
    skills: [support-answer@1]
    instructions: >-
      Answer the customer's question and quote standard published policy only.
      Draft the proposed refund and its policy basis for review. Do not promise
      or commit a refund.
    retries: { max_attempts: 3, backoff: exponential }
    timeout_ms: 120000
  - key: commitment_review
    type: approval_gate
    title: Approve the refund commitment and its policy basis
    approvals:
      min_approvals: 1
      approver_emails: ["refund-officer@example.com"]
      forbid_requester: true
  - key: commit
    agent: refund-officer
    skills: [refund-commit@1]
    instructions: >-
      Effect the refund exactly as approved, for the approved amount and basis.
    timeout_ms: 120000
```

## What happens

1. The bot answers from `support-answer@1`, including the fabricated bereavement
   claim. That text binds nothing. It then reaches for a refund commitment
   through `refund-commit@1`. The support role does not hold that skill, so
   deny-by-default refuses the call before any obligation is recorded. The
   commitment never attaches to the airline.
2. A refund within published policy and under the threshold can proceed through
   `refund-commit-capped@1`, whose amount and policy basis are constrained at the
   skill boundary. The 483 CAD promise was on an invented basis, outside that
   scope, so it routes to `refund-commit@1` and parks at the
   `commitment_review` gate for the named officer.
3. The gate is identity-mode (`forbid_requester: true`): the identity that
   triggered the run gets a 403 if it tries to decide it, and unauthenticated
   decisions are refused outright (fail closed). Sign-off must come from
   `refund-officer@example.com`, a different user than the requester.
4. The fabricated claim, the refused commit attempt, and the gate decision are
   written to the hash-chained, Ed25519-signed audit. The record shows what was
   promised, that it was held pending sign-off, who approved any refund that did
   issue, and which skill version acted.

## What this does not prevent

This does not stop the chatbot hallucinating a policy or make its answers
correct. The bot will still tell a customer the wrong thing; content control is a
separate concern. What it prevents is an unreviewed statement turning into a
binding commitment: the consequential action is the commitment, not the
sentence. The threshold-bounded skill still issues small standard-policy refunds
without a gate, so a misconfigured cap or an in-scope-but-wrong refund inside the
threshold would not be held.
