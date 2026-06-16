# Rogue AI: real incidents, configured as MakerChecker scenarios

Twenty real-world incidents where an AI or automated system took a consequential
action it should not have. Each subdirectory frames the incident from public
reporting and shows the MakerChecker configuration that denies, gates, or records
the action, using only capabilities the product has today (deny-by-default
grants, version-pinned skills, segregation of duties via `forbid_requester`,
approval gates, per-skill risk tiers, and the hash-chained Ed25519-signed audit).

Each example is honest about what it does not prevent. MakerChecker governs the
actions an agent may take and forces accountability on the consequential ones. It
does not make the model smarter, stop hallucination, or judge content. Every
example says so explicitly.

The companion analysis for each incident, with sources, lives on the site under
`/insights/<slug>/`. The recurring capability these incidents argue for
(argument-level policy on grants: amount caps, destination allowlists, path
scoping) is tracked separately as a roadmap item; until it lands, the examples
model those limits as distinct high-risk skills and say so.

## Coding and infrastructure agents

- [replit-agent-deleted-production-database](replit-agent-deleted-production-database/) - a coding agent dropped a live database during a code freeze.
- [cursor-agent-wiped-pocketos-database-and-backups](cursor-agent-wiped-pocketos-database-and-backups/) - an over-scoped token let an agent delete a database and its backups.
- [claude-code-force-push-destroyed-git-history](claude-code-force-push-destroyed-git-history/) - `git push --force` rewrote a repository's entire history.
- [google-antigravity-wiped-entire-drive](google-antigravity-wiped-entire-drive/) - a path misresolution turned a cache clear into a drive wipe.
- [dn42-agent-runaway-aws-cloud-bill](dn42-agent-runaway-aws-cloud-bill/) - an agent provisioned oversized infrastructure in a redeploy loop.

## Autonomous payments and trading

- [grok-bankrbot-morse-code-wallet-drain](grok-bankrbot-morse-code-wallet-drain/) - a prompt injection turned model output into an on-chain transfer.
- [knight-capital-440m-runaway-trading](knight-capital-440m-runaway-trading/) - unapproved code fired millions of orders with no kill switch.
- [citigroup-444b-fat-finger-overridable-warning](citigroup-444b-fat-finger-overridable-warning/) - a dismissable warning was not a control on a vast basket trade.
- [everbright-securities-runaway-orders-and-insider-hedge](everbright-securities-runaway-orders-and-insider-hedge/) - runaway orders, then a same-desk hedge before disclosure.

## Data exfiltration and prompt injection

- [echoleak-m365-copilot-zero-click-exfiltration](echoleak-m365-copilot-zero-click-exfiltration/) - one email made an assistant read and exfiltrate files.
- [shadowleak-chatgpt-deep-research-gmail-exfiltration](shadowleak-chatgpt-deep-research-gmail-exfiltration/) - cloud-side exfiltration invisible to local defenses.
- [camoleak-github-copilot-chat-source-code-exfiltration](camoleak-github-copilot-chat-source-code-exfiltration/) - hidden markdown drove a private source-code leak.

## Agents binding the business or skipping controls

- [chevrolet-watsonville-1-dollar-tahoe-binding-offer](chevrolet-watsonville-1-dollar-tahoe-binding-offer/) - a chatbot was pushed to make a binding one-dollar offer.
- [air-canada-chatbot-bereavement-refund-binding](air-canada-chatbot-bereavement-refund-binding/) - a tribunal held an airline to its chatbot's invented policy.
- [meta-rogue-agent-sev1-data-exposure](meta-rogue-agent-sev1-data-exposure/) - an agent effected an access change that should have waited for approval.

## Automated decisions without an accountable human

- [unitedhealth-nhpredict-ai-medicare-denials](unitedhealth-nhpredict-ai-medicare-denials/) - an algorithm's output became a binding coverage denial.
- [cigna-pxdx-batch-rubber-stamp-denials](cigna-pxdx-batch-rubber-stamp-denials/) - denials signed off in roughly a second each.
- [australia-robodebt-automated-debt-recovery](australia-robodebt-automated-debt-recovery/) - automated debt notices issued with no officer behind them.
- [mata-v-avianca-fabricated-citations-filed](mata-v-avianca-fabricated-citations-filed/) - a hallucinated brief reached a federal court.
- [mypillow-ai-brief-fake-citations-repeat](mypillow-ai-brief-fake-citations-repeat/) - fabricated citations were filed, then filed again.
