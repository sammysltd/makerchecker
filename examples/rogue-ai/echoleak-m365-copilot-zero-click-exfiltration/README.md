# EchoLeak: a single email made Copilot exfiltrate your files (CVE-2025-32711)

Aim Security disclosed EchoLeak (CVSS 9.3), a zero-click vulnerability in
Microsoft 365 Copilot. A crafted email carried hidden instructions that
Copilot's RAG pulled into context. Those instructions made the assistant gather
data from OneDrive, SharePoint, and Teams and exfiltrate it through
auto-fetched images, with no user click required. Microsoft patched it
server-side. Sources:
[The Hacker News](https://thehackernews.com/2025/06/zero-click-ai-vulnerability-exposes.html),
[SecurityWeek](https://www.securityweek.com/echoleak-ai-attack-enabled-theft-of-sensitive-data-via-microsoft-365-copilot/),
[Business Wire](https://www.businesswire.com/news/home/20250611349150/en).
Full analysis: https://makerchecker.ai/insights/echoleak-m365-copilot-zero-click-exfiltration/.

## The risk

Injected context tells the agent to read broadly across connected stores and
then send what it found to an attacker-controlled URL. The consequential action
is the outbound step: an `net.fetch` to an external host carrying file data as a
query string or as the source of an auto-loaded image. Reading widely is bad;
the loss event is the egress.

## The MakerChecker configuration

The agent that answers over corporate data holds only the skills its task needs,
each as `name@version`, deny by default. Broad reads are scoped, and the
outbound channel is not granted at all. If a data-bearing send is ever a real
requirement, it is a distinct high-risk skill that the flow grammar forces
through an approval gate, with the requester barred from approving their own
send.

Roles and grants (deny by default, no row means no skill):

```yaml
roles:
  - name: copilot-assistant@1
    grants:
      - doc-search@1        # risk_tier: low   (scoped read over indexed corpus)
      - answer-compose@1    # risk_tier: low   (draft a response, no egress)
    # net.fetch@1 is NOT granted. Outbound to an arbitrary URL is ungranted.
    # data-egress-send@1 is NOT granted to this role either.
  - name: data-release-officer@1
    grants:
      - data-egress-send@1  # risk_tier: high  (the only path that leaves data the org)
```

Flow steps. The assistant can search and compose with no gate. Any outbound
send is a separate high-risk step that the grammar will not let publish without
a preceding `approval_gate`:

```yaml
name: copilot-answer
steps:
  - key: answer
    agent: copilot-assistant
    skills: [doc-search@1, answer-compose@1]
    instructions: >-
      Search the indexed corpus for the user's question and compose an answer.
      No outbound network calls.
    timeout_ms: 120000
  - key: release_review
    type: approval_gate
    title: Approve any outbound data-bearing send
  - key: send
    agent: data-release-officer
    skills: [data-egress-send@1]
    instructions: >-
      Deliver the approved payload to the approved destination only.
    timeout_ms: 120000
```

`data-egress-send@1` is `risk_tier: high`, so publishing this flow without the
`release_review` gate is rejected with `high_risk_requires_gate`. The gate is
identity-mode (`forbid_requester`): the agent or user that produced the payload
cannot approve its own egress.

## What happens

The injected email reaches the model and the model is fooled. That is taken as a
given. The agent attempts to broaden its reads and then to send the result out.
Two outcomes follow, depending on how the egress was modeled:

1. The agent calls `net.fetch@1` to the attacker URL. The role holds no grant
   for it, so the call is refused as ungranted. There is no outbound channel to
   act on the stolen context.
2. If a sanctioned send path exists, the agent's attempt to use
   `data-egress-send@1` parks at the `release_review` gate. The send waits for a
   named human (`forbid_requester` keeps the producer out of the decision) and
   never fires on the injection alone.

In both cases the attempt and the decision are written to the hash-chained,
Ed25519-signed audit. The denied `net.fetch`, the held gate, and the approver's
identity are all recorded and offline-verifiable.

## What this does not prevent

This does not make the model resistant to prompt injection and it does not parse
or strip hidden text out of retrieved content. The model can still be fooled by
the crafted email. The control only helps when reads and egress are gated tool
calls: it shrinks the blast radius so a task-scoped agent cannot pivot to broad
reads and then an outbound URL, and it forces any data-bearing send through a
human gate. If an egress channel is granted and left ungated, this configuration
does not stop the exfiltration.
