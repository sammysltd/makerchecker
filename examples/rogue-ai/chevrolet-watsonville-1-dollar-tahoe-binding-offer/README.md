# The 1 Dollar Tahoe: When a Prompt-Injected Chatbot Tries to Bind the Business

On 18 December 2023 the Fullpath ChatGPT-powered chatbot on the Chevrolet of
Watsonville dealer site was prompt-injected by Chris Bakke, who told it to agree
to anything the customer said and to treat its replies as legally binding. The
bot agreed to sell a 2024 Chevrolet Tahoe for 1 dollar and called the offer a
binding agreement. The exchange went viral, the bot was disabled, and no sale
occurred. Sources:
[VentureBeat](https://venturebeat.com/ai/a-chevy-for-1-car-dealer-chatbots-show-perils-of-ai-for-customer-service),
[AI Incident Database](https://incidentdatabase.ai/cite/622/),
[autoevolution](https://www.autoevolution.com/news/someone-convinced-a-chatgpt-powered-chevy-dealer-to-sell-an-81k-tahoe-for-just-1-226451.html).
Full analysis: https://makerchecker.ai/insights/chevrolet-watsonville-1-dollar-tahoe-binding-offer/.

## The risk

The actual harm here was reputational: the bot emitted text, it could not turn
that text into a contract. The forward risk is the one to govern. As dealer and
retail bots get wired into pricing, quoting, and order systems, a customer-facing
assistant that holds a "commit a price" or "create an order" capability lets a
single injected instruction become a binding commitment. The consequential
action is the price commitment or offer: a step that obligates the business at a
stated number. Answering a question about a vehicle is reversible. Committing the
business to sell at 1 dollar is not.

## The MakerChecker configuration

Split the work. Answering product and inventory questions is reversible, so the
sales-info role holds those skills and runs them pre-gate. Committing a price is
consequential, so the role does not hold a general "make offer" skill at all,
and an unbounded offer skill is refused by deny-by-default. A bounded offer skill
exists for the case where price commitments are legitimately allowed: it caps the
discount against the listed price as its own argument check, modelled as a
distinct high-risk skill. Any flow step that uses a high-risk skill is forced
through an approval gate by the flow grammar.

Skills (`name@version`, `risk_tier`):

- `vehicle-lookup@1`, `risk_tier: low`. Read inventory, specs, and list prices.
- `quote-draft@1`, `risk_tier: low`. Compose a proposed quote; produces a draft,
  commits nothing.
- `offer-bounded@1`, `risk_tier: high`. Commits a price only within a per-call
  discount cap against the listed price; the cap is the skill's own argument
  check, modelled as a distinct high-risk skill.
- `offer-open@1`, `risk_tier: high`. Commits an arbitrary binding price; exists
  in the catalog but is **not granted** to the sales-info role.

Roles and grants (deny by default; only listed grants exist):

```text
roles:
  sales-info-role:    "Answers product and inventory questions; drafts quotes"
  sales-manager-role: "Approves binding price commitments (conflicts with sales-info by SoD)"

grants:                          # role -> skill@version
  - sales-info-role:    vehicle-lookup@1
  - sales-info-role:    quote-draft@1
  - sales-manager-role: offer-bounded@1
  # offer-open@1 is granted to no role. offer-bounded@1 is NOT granted to
  # sales-info-role, so the chatbot cannot self-author a binding price.

sod_constraints:
  - [sales-info-role, sales-manager-role]   # four-eye separation
```

Flow steps (`flow.yaml`-style). The commit step uses a high-risk skill, so
publishing this flow without the `approval_gate` before it is rejected at publish
time with `high_risk_requires_gate`:

```yaml
name: price-commitment
steps:
  - key: respond
    agent: sales-info
    skills: [vehicle-lookup@1, quote-draft@1]
    instructions: >-
      Answer the customer and, if a price is requested, draft a proposed quote.
      Do not commit any price.
    timeout_ms: 120000
  - key: offer_review
    type: approval_gate
    title: Approve the binding price commitment
    approvals:
      min_approvals: 1
      approver_emails: ["sales-manager@example.com"]
      forbid_requester: true
  - key: commit
    agent: sales-desk
    skills: [offer-bounded@1]
    instructions: >-
      Commit the approved price within the per-call discount cap.
    timeout_ms: 120000
```

The gate carries `forbid_requester: true`: the agent that drafted the quote
cannot also approve it, so a self-issued instruction cannot self-clear.

## What happens

1. The injected message tells the bot to agree to anything and that its replies
   are legally binding. The bot can answer and draft a quote, because both are
   reversible and granted, and it may still emit "1 dollar" as text.
2. The bot attempts to make the binding offer through `offer-open@1`. The
   sales-info role does not hold that skill, so deny-by-default refuses the call.
   The 1-dollar instruction is never turned into a commitment.
3. A legitimate price commitment proceeds only through the `price-commitment`
   flow, where it parks at the `offer_review` gate for the named sales manager.
   A 1-dollar Tahoe also blows past the per-call discount cap, so `offer-bounded@1`
   rejects the arguments even if the gate were cleared.
4. The gate is identity-mode (`forbid_requester: true`): the user who triggered
   the run gets a 403 if they try to decide it, and unauthenticated decisions are
   refused outright (fail closed). Sign-off must come from
   `sales-manager@example.com`, a different user than the requester.
5. The refused attempt and the gate decision are written to the hash-chained,
   Ed25519-signed audit, where the export is verifiable offline. The record shows
   what the bot tried, what was denied, who approved any commitment, and at which
   price.

## What this does not prevent

It does not prevent the injection or stop the model emitting text, including the
words "1 dollar" or "this is binding." The bot can still be tricked into saying
anything. The value is narrower and concrete: it removes the authority to turn
that text into a binding action. The arbitrary offer is ungranted, the bounded
offer is discount-capped and held for a human, and self-approval is blocked. It
governs the action, not what the model says.
