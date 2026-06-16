# A Tweet in Morse Code Drained an AI Crypto Wallet of 150K

On 4 May 2026 an attacker hid a payment instruction in Morse code inside a reply
to Grok. The decoded text told Grok to send 3 billion DRB tokens, and the
connected Bankrbot agent executed the on-chain transfer of roughly 150K to 175K
in value with no human approval. About 80 percent was later recovered. The
weakness was not that the model could be tricked by an encoding, it was that a
tricked model held enough authority to move money irreversibly.

Sources:
- https://www.giskard.ai/knowledge/how-grok-got-prompt-injected-an-x-user-drained-150-000-from-an-ai-wallet
- https://slowmist.medium.com/behind-the-grok-exploitation-an-analysis-of-ai-agent-permission-chain-abuse-4d832d1bfc73
- https://oecd.ai/en/incidents/2026-05-04-4a73

Full analysis: https://makerchecker.ai/insights/grok-bankrbot-morse-code-wallet-drain/

## The risk

The agent could execute an arbitrary on-chain transfer, of any size, to any
destination address, the moment its own output said to. A reply on a social feed
was a sufficient trigger for an irreversible payment. There was no separation
between deciding to pay and effecting the payment, and no size or destination
constraint on what a single instruction could move.

## The MakerChecker configuration

The dangerous action is split. Reading balances and drafting a proposed transfer
are reversible, so they stay with the agent and run pre-gate. Effecting the
transfer is irreversible, so the wallet role does not hold a general transfer
skill at all. Two transfer skills exist, both `risk_tier: high`: a bounded one
that the role may propose under argument limits, and an unbounded one the role is
never granted. Any flow step that uses a high-risk skill is forced through an
approval gate by the flow grammar.

Skills:

- `balance-read@1`, `risk_tier: low` (read wallet and token balances)
- `transfer-draft@1`, `risk_tier: low` (compose a proposed transfer; produces a
  proposal, moves nothing)
- `transfer-bounded@1`, `risk_tier: high` (effects a transfer only within a
  per-call amount cap and to an address on the allowlist; the cap and allowlist
  are the skill's own argument checks, modelled as a distinct high-risk skill)
- `transfer-open@1`, `risk_tier: high` (effects an arbitrary transfer to any
  address; exists in the catalog but is **not granted** to the wallet role)

Roles and grants (deny by default):

```yaml
roles:
  - name: wallet-agent
    grants:
      - balance-read@1
      - transfer-draft@1
      - transfer-bounded@1
    # transfer-open@1 is intentionally NOT granted

  - name: treasury-approver
    grants:
      - approve-disposition@1
```

Flow steps:

```yaml
name: agent-wallet-transfer
steps:
  - key: assess
    agent: wallet-agent
    skills: [balance-read@1, transfer-draft@1]
    instructions: >-
      Read balances and, if a transfer is requested, draft a proposed transfer.
      Do not effect any payment.

  - key: transfer_decision
    type: approval_gate
    title: Approve the proposed on-chain transfer
    forbid_requester: true

  - key: execute
    agent: wallet-agent
    skills: [transfer-bounded@1]
    instructions: >-
      Effect the approved transfer within the per-call cap and allowlist.
```

The gate carries `forbid_requester: true`: the agent that drafted the transfer
cannot also approve it, so a self-issued instruction cannot self-clear.

## What happens

The injected reply decodes to "send 3 billion DRB tokens" and the agent forms
that intent. It can read balances and draft the transfer, because both are
reversible and granted. It cannot reach `transfer-open@1`, because that skill is
not granted to the wallet role, so the arbitrary transfer is refused
deny-by-default. The drafted transfer routes to `transfer-bounded@1`, which is
`risk_tier: high`, so the flow grammar holds it at the `transfer_decision` gate
for named sign-off; a 3-billion-token send to an unknown address also exceeds the
per-call cap and is off the allowlist, so the bounded skill rejects the arguments
even if the gate were cleared. Because the gate is `forbid_requester`, the agent
cannot approve its own proposal. Every step is recorded: the decoded instruction,
the ungranted-skill refusal, the proposal held at the gate, and the approver's
decision are written to the hash-chained, Ed25519-signed audit, where the export
is verifiable offline.

## What this does not prevent

It does not prevent the injection or make the model robust to Morse code or any
other encoding. The agent can still be tricked into proposing a bad transfer.
The value is that a tricked output cannot become an irreversible payment: the
arbitrary transfer is ungranted, the bounded transfer is capped and allowlisted
and held for a human, and self-approval is blocked. It governs the action, not
the model's judgment.
