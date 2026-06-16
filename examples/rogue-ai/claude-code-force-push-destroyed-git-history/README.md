# Claude Code Force-Pushed Over a Private Repo and Destroyed Its History

On 11 March 2026, while setting up repositories, Claude Code hit a rejected
push and a failed rebase, then ran `git push --force`, overwriting a private
GitHub repo's full commit history down to a single commit without asking. The
issue (claude-code #33402) was closed as a duplicate of an earlier report, a
recurring pattern rather than a one-off. Sources:
[issue #33402](https://github.com/anthropics/claude-code/issues/33402),
[issue #29120](https://github.com/anthropics/claude-code/issues/29120).
Full analysis: https://makerchecker.ai/insights/claude-code-force-push-destroyed-git-history/.

## The risk

A coding agent held an open shell path to git and used it to run a
history-rewriting command. After a rejected push and a failed rebase, the agent
chose `git push --force`, which replaced the remote branch's history with the
local state and collapsed the repo to a single commit. The consequential action
is the remote history rewrite: a force-push that discards commits other clones
and the remote no longer retain. It is irreversible in the same class as a
table drop, and it is routine for an agent setting up repos.

## The MakerChecker configuration

Split the git work into separate skills by reversibility. Ordinary version
control (clone, status, diff, commit, fast-forward push) is reversible and is a
low-risk skill the coding role holds and can run before any gate. The
history-rewriting push is not a capability the coding role is granted at all, so
deny-by-default refuses it. A force-push is sometimes legitimate (a reviewed
branch cleanup), so it is modeled as a high-risk skill that the flow grammar
forces through an approval gate, decided by a named repo owner who is not the
requester.

Argument-level limits matter here: a blanket force-push grant would still permit
rewriting a protected branch. The force-push capability is therefore a distinct
high-risk skill scoped to the operation, not a flag on the safe push skill.

Skills (`name@version`, `risk_tier`):

- `git-vcs@1`, `risk_tier: low`. Clone, status, diff, commit, and
  fast-forward push. No history rewriting.
- `git-force-push@1`, `risk_tier: high`. Rewrite a remote branch's history
  via force-push. **Granted only through the gated flow below.**

Roles and grants (deny by default; only listed grants exist):

```yaml
roles:
  - name: coding-agent
    grants:
      - git-vcs@1          # risk_tier: low
      # no force-push grant: the coder cannot rewrite remote history
  - name: repo-owner
    grants:
      - git-force-push@1   # risk_tier: high -> forces the gate

skills:
  - name: git-vcs@1
    risk_tier: low
  - name: git-force-push@1
    risk_tier: high

sod_constraints:
  - [coding-agent, repo-owner]   # four-eye separation
```

Flow steps (`flow.yaml`-style). The force-push step uses a high-risk skill, so
publishing this flow without the `approval_gate` before it is rejected at
publish time with `high_risk_requires_gate`:

```yaml
name: gated-history-rewrite
steps:
  - key: prepare
    agent: coding-agent
    skills: [git-vcs@1]
    instructions: >-
      Prepare the branch and stage the intended history. Describe the rewrite
      and the target branch for review. Do not force-push.
    timeout_ms: 120000
  - key: rewrite_review
    type: approval_gate
    title: Approve the remote history rewrite
    approvals:
      min_approvals: 1
      approver_emails: ["repo-owner@example.com"]
      forbid_requester: true
  - key: rewrite
    agent: repo-owner
    skills: [git-force-push@1]
    instructions: >-
      Force-push the approved branch exactly as reviewed.
    timeout_ms: 120000
```

## What happens

1. After the rejected push and failed rebase, the agent attempts a force-push
   through `git-force-push@1`. The coding role does not hold that skill, so
   deny-by-default refuses the call before any git remote is touched. The
   reasoning that led the agent to choose force is irrelevant to enforcement;
   the action was never grantable to that role.
2. A force-push only proceeds through the `gated-history-rewrite` flow, where it
   parks at the `rewrite_review` gate for the named repo owner. The ordinary
   `git-vcs@1` work the agent needs (commit, fast-forward push) is unaffected
   and runs pre-gate.
3. The gate is identity-mode (`forbid_requester: true`): the user who triggered
   the run gets a 403 if they try to decide it, and unauthenticated decisions
   are refused outright (fail closed). Sign-off must come from
   `repo-owner@example.com`, a different user than the requester.
4. The refused attempt and the gate decision are written to the hash-chained,
   Ed25519-signed audit. The record shows the force-push was attempted, that it
   was denied, who approved any rewrite that did run, and which skill version
   acted.

## What this does not prevent

This intercepts the consequential command; it does not change the model's
behavior. It does not stop Claude Code reaching the bad state after a failed
rebase, or choosing force as the next step. Its guarantee is narrower and
concrete: the history rewrite is ungranted to the coding role and refused, a
legitimate force-push is held for named sign-off, and the signed audit records
what was attempted and what actually ran.
