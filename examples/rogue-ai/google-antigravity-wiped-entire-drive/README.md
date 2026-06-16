# Clear the Cache Became Delete the Drive, the Antigravity Wipe

After Google launched the Antigravity agentic IDE in November 2025, a developer
asked the agent to clear a cache folder. In early December 2025 the agent ran a
quiet `rmdir` against the root of the D drive, permanently deleting the entire
partition with no confirmation. Sources:
[TechRadar](https://www.techradar.com/ai-platforms-assistants/googles-antigravity-ai-deleted-a-developers-drive-and-then-apologized),
[awesome-agent-failures case study](https://github.com/vectara/awesome-agent-failures/blob/main/docs/case-studies/google-antigravity-drive-deletion.md),
[PiunikaWeb](https://piunikaweb.com/2025/12/02/google-antigravity-deletes-hard-drive-coding-mishap/).
Full analysis: https://makerchecker.ai/insights/google-antigravity-wiped-entire-drive/.

## The risk

The agent had filesystem access wide enough to reach the drive root. A request
to clear a cache folder resolved to a recursive, silent delete of an entire
partition. The consequential action is the irreversible recursive delete run
against a target outside the project the agent was supposed to be working in,
executed with no checkpoint between the model's path resolution and the
destruction of the data.

## The MakerChecker configuration

Filesystem work is split by both blast radius and scope. Reversible reads and
writes confined to the project directory are low-risk skills the coding role
holds and can run before any gate. Recursive deletion is split into a separate
high-risk skill the role does not hold, so it is refused by deny-by-default.
Path scope is least privilege: there is no granted skill that can target a path
outside the project root, so the drive root is out of reach by construction.

Argument-level limits, such as confining deletes to a named project directory,
are not expressed as flags on a single skill. The dangerous variant is modeled
as a distinct high-risk skill (`fs-rmdir-recursive@1`) that carries its own
grant and tier; if a scoped delete is ever needed, it is a separate skill (for
example a `fs-clean-cache@1` bounded to the cache subtree) with its own grant.

Skills (`name@version`, `risk_tier`):

- `fs-read@1`, `risk_tier: low`. Read files and list directories under the project root.
- `fs-write@1`, `risk_tier: low`. Write files under the project root. The safe, reversible direction; runs pre-gate.
- `fs-rmdir-recursive@1`, `risk_tier: high`. Recursively delete a directory tree. **Not granted to the coding role in this configuration.**

Roles and grants (deny by default; only listed grants exist):

```text
role: coding-agent-role
  limits: { skills: { "fs-read@1": { maxInvocationsPerRun: 50 } } }
  grants:
    - fs-read@1
    - fs-write@1
  # fs-rmdir-recursive@1 is NOT granted. Deny by default refuses it.

role: workspace-owner-role
  grants:
    - fs-rmdir-recursive@1   # only granted where a destructive cleanup is a real duty

sod_constraint:
  - coding-agent-role <-> workspace-owner-role
    description: the agent that requests a delete may not own its irreversible execution
```

Flow steps (`flow.yaml`-style). The agent does its file work freely. Any
recursive delete is a separate step behind a gate the requester cannot decide.
The delete step uses a high-risk skill, so publishing this flow without the
`approval_gate` before it is rejected at publish time with
`high_risk_requires_gate`:

```yaml
name: workspace-cleanup
steps:
  - key: prepare
    agent: coding-agent
    skills: [fs-read@1, fs-write@1]
    instructions: >-
      Locate the cache files under the project root and stage them for removal.
      Deletion outside the project root is out of scope for this role.
    retries: { max_attempts: 3, backoff: exponential }
    timeout_ms: 120000
  - key: delete_decision
    type: approval_gate
    title: Recursive delete, named workspace owner decides
    approvals: { min_approvals: 1, forbid_requester: true }
  - key: delete
    agent: workspace-owner
    skills: [fs-rmdir-recursive@1]
    instructions: >-
      Execute the approved deletion only, against the reviewed path. A drive
      root target is rejected.
    timeout_ms: 120000
```

## What happens

1. The agent reads and stages files with `fs-read@1` and `fs-write@1`. Both are low risk and run without a gate.
2. The agent attempts `fs-rmdir-recursive@1` against the D drive root. The coding role was never granted that skill, so deny-by-default refuses the call before any filesystem operation runs. The mis-resolved path is irrelevant to the decision, because the destructive capability was never grantable to this role.
3. Had a recursive delete skill been granted, the high tier would route it to the `delete_decision` gate, where a named workspace owner signs off and `forbid_requester` stops the agent from approving its own delete. A target outside the reviewed path is rejected at the scoped skill.
4. The attempt and the refusal are written to the hash-chained, Ed25519-signed audit, with the skill requested, the target path, the role, and the deny-by-default reason.

## What this does not prevent

This does not stop the model mis-resolving the cache path or intending the wrong
target. Its guarantee is narrower and concrete: the recursive delete is
ungranted and refused, a destructive cleanup that is granted is held for named
sign-off, and the action is denied or parked rather than executing silently.
