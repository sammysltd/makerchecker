# Control mapping

MakerChecker is self-hosted software. It provides enforcement and audit controls
and the evidence artifacts those controls produce. In a self-hosted deployment
the controls run inside the operator's own perimeter, and their evidence —
signed export bundles, the access-review report, run evidence packs, audit
events — becomes input to the operator's own SOC 2 or ISO audit program.

This document is a control-to-clause crosswalk, not a certification. MakerChecker
is not itself certified or attested against SOC 2, ISO/IEC 27001, or
ISO/IEC 42001. The mappings below name the framework clauses each shipped control
speaks to; an assessor confirms the operator's posture against their own scope.

How to read it:

- **Evidence** names a real command, audit event, report, or database object. A
  reviewer can run the command, query the event type, open the report, or read
  the SQL. Enforcement event types (`enforcement.blocked`,
  `enforcement.sod_violation`, `enforcement.limit_violation`) are string literals
  emitted from the orchestrator, executors, and proxy, paired with an
  `EnforcementError` code; both are cited.
- **partial** marks a mapping where the control provides part of what the clause
  requires and the remainder is the operator's process or deployment choice.
- Several controls are deployment-conditional or gated by an environment
  variable. Those conditions are stated in the row; a default image does not turn
  them on.

CLI commands are invoked as `node dist/cli.js <command>` inside the server
container (for example `docker compose exec server node dist/cli.js audit verify`).
Rows write `cli.js <command>` for brevity.

## Logical access

| Control | What it does | Evidence | SOC 2 TSC | ISO 27001:2022 Annex A | ISO 42001 |
|---|---|---|---|---|---|
| Deny-by-default skill grants | An agent runs a skill only with an exact, unrevoked grant of that name@version to its role. No grant, no execution; there is no bypass. | `EnforcementError` code `skill_not_granted` (`packages/server/src/engine/enforcement.ts`), surfaced as audit event `enforcement.blocked`; `cli.js audit access-review` lists active grants per role and prints "no active grants (deny by default)" when empty. | CC6.1, CC6.3 | A.5.15, A.8.2, A.8.3 | A.9.2, A.6.2.6 |
| Enforcement at decision and invocation time | A grant revoked or agent suspended between scheduling and execution is still denied; the second block records `payload.at = "invocation"`. | Audit event `enforcement.blocked` with `payload.at == "invocation"` (`engine/orchestrator.ts`). | CC6.1, CC6.3 | A.5.15, A.8.2 | A.6.2.4 |
| Segregation of duties | A run is blocked if any role that already acted forms an active SoD constraint pair with the candidate role, evaluated against the frozen role snapshot. | `EnforcementError` code `sod_violation` (`engine/enforcement.ts`), audit event `enforcement.sod_violation` (orchestrator and `proxy/service.ts`); `cli.js audit access-review` "Segregation of duties" section lists constraint pairs including revoked. | CC6.3 | A.5.15, A.8.2 | A.9.2, A.6.2.6 |
| High-risk skill gate | A high-risk skill runs only in a step preceded by a separation-enforcing approval gate; denied categorically in proxy mode. | `EnforcementError` code `high_risk_requires_gate` (`engine/enforcement.ts`), surfaced as `enforcement.blocked`; publish-time check in `engine/flows.ts`. | CC6.3 | A.5.15, A.8.2 | A.6.2.4 |
| Named approval gates, four-eyes identity | n-of-m gates fail closed: decisions need authenticated, listed approvers; the run's requester cannot decide; no double-decide. | Audit events `approval.requested`, `approval.decided`, `approval.decision_denied`, `approval.resolved` (`engine/orchestrator.ts`); `cli.js audit report --run <id>` "Approvals" section shows each decision with decider and reason. | CC6.1, CC6.3 | A.5.15, A.8.2 | A.6.2.4, A.9.2 |
| Strict identity-gate mode (partial) | `MAKERCHECKER_REQUIRE_IDENTITY_GATES=1` rejects publishing any self-approvable gate and denies the requester (admin included) at decision time, even on a legacy gate. A default deployment leaves legacy gates with their prior behavior. | Publish 400 (`engine/flows.ts`); audit event `approval.decision_denied` (`engine/orchestrator.ts`, `checkDecisionIdentity`). Config flag `MAKERCHECKER_REQUIRE_IDENTITY_GATES` (`config.ts`). | CC6.3 | A.5.15, A.8.2 | A.9.2 |
| API-key authentication, hashed at rest | Keys are `mk_<32 hex>`; only `sha256(plaintext)` plus an 8-char prefix is stored; plaintext is returned once. Auth resolves only unrevoked keys. | `auth/api-keys.ts` (`hashApiKey`, `revoked_at IS NULL`); audit event `api_key.created` carries prefix and name only; `cli.js create-api-key --email <e>`. | CC6.1, CC6.2 | A.5.16, A.8.5 | — |
| First admin by explicit command | A default image seeds nothing; the first identity is minted by `bootstrap-admin`, which refuses a second admin for an existing email. No boot-time auto-provisioning. | Audit events `user.created`, `api_key.created`; `cli.js bootstrap-admin --email <e> --name <n>` (`cli.ts`); `docs/security-model.md`. | CC6.2, CC6.3 | A.5.16, A.8.2 | — |
| Admin-only mutation routes | Administrative writes (roles, skills, grants, constraints) return 403 unless the caller is an admin. | `requireAdmin` 403 preHandler on admin mutation routes (`api/admin-routes.ts`). | CC6.1, CC6.3 | A.8.2, A.8.3 | A.9.2 |
| Fail-closed role limits and budgets | Per-skill invocation count, per-invocation amount (negative and unreadable denied), destination allowlist, traversal-proof path scope, run-level invocation and token ceilings, all enforced before each call. | `EnforcementError` surfaced as audit event `enforcement.limit_violation` (`engine/llm-executor.ts`, `skills/sequential-executor.ts`, `proxy/service.ts`); `engine/limits.ts` (`assertSkillLimits`, `checkTokenBudget`). | CC6.1, CC6.3 | A.8.2, A.8.3 | A.9.2 |
| Frozen per-run limits and role | A mid-run edit cannot widen an in-flight run's ceiling or change who-acted-as-what; enforcement reads the frozen `limits_snapshot`, not live roles. | `engine/limits.ts` (`getEnforcedLimits` reads `limits_snapshot`); migration `0006_limits_snapshot.sql`. | CC6.3, CC8.1 | A.8.2 | A.6.2.6 |
| Auth-disabled mode refuses a reachable bind | With `MAKERCHECKER_AUTH_DISABLED=1` the server fails closed at startup unless it binds loopback; an unrecognized host counts as reachable. | `assertAuthBindSafe` (`boot/bind-guard.ts`); `docs/security-model.md`. | CC6.1, CC6.6 | A.8.5, A.8.20 | — |

## Monitoring and audit

| Control | What it does | Evidence | SOC 2 TSC | ISO 27001:2022 Annex A | ISO 42001 |
|---|---|---|---|---|---|
| Hash-chained append-only audit log | A single writer (`recordEvent`), serialized by a transaction advisory lock, is the only insert path. Each event hash is SHA-256 over RFC 8785 canonical JSON, chained through `prev_hash` from a genesis event tied to the instance. | `audit/writer.ts`; `docs/audit-spec.md`. Verify with `cli.js audit verify` (returns `{ ok, count, headHash }` or `{ ok: false, failedSeq, reason }`) or `GET /api/audit/verify`. | CC7.2, CC7.3 | A.8.15, A.8.16 | A.6.2.8 |
| Full-chain verification | Recomputes every hash and `prev_hash` linkage in order, names the first tampered or missing row, batched for constant memory. | `audit/verify.ts`; `cli.js audit verify` (exits non-zero on failure); the run evidence pack embeds a "Chain verification: PASSED/FAILED" statement (`reports/run-report.ts`). | CC7.2, CC7.3 | A.8.15, A.8.16 | A.6.2.8 |
| Database-level append-only enforcement (partial) | `BEFORE UPDATE/DELETE` and statement `TRUNCATE` triggers reject any in-band edit to `audit_events`; the `instance` row is write-once. Effective against a compromised application credential only when the server connects as the non-owner role; the default single-role quickstart owns the tables and can disable its own triggers. | `migrations/0001_init.sql` (`audit_events_append_only`, no-update-delete and no-truncate triggers); `migrations/0007_instance_immutable.sql`; hardening in `ops/harden-db.sql` (`REVOKE UPDATE, DELETE, TRUNCATE ON audit_events`); `docs/security-model.md`. | CC7.2 | A.8.15, A.8.16 | A.6.2.8 |
| State writes in the same transaction as their audit event | A state mutation commits with its audit event in one transaction, so the chain cannot silently lag reality. | `audit/writer.ts`; `auth/api-keys.ts` (BEGIN, INSERT, `recordEvent`, COMMIT). | CC7.2 | A.8.15 | A.6.2.8 |
| Structured logs with secret redaction | Pino emits one access line per request; `redact` masks `authorization`, `cookie`, `token`, `apiKey`, `password`, `secret`; the access line never logs the body or Bearer token. `x-request-id` flows through as an opaque correlation id. Error text is scrubbed through the redaction hook. | `boot/logger.ts`; `app.ts`; `docs/security-model.md`. `MAKERCHECKER_LOG_LEVEL` sets verbosity. | CC7.2 | A.8.15, A.8.16 | A.6.2.8 |
| Overdue-approval signal (partial) | A boot-scheduled sweep flags approvals pending past `MAKERCHECKER_APPROVAL_OVERDUE_MINUTES` (default 60) and emits exactly one `approval.overdue` audit event and webhook per approval. Alert routing is the operator's consumer; there is no built-in alerting engine. | Audit event `approval.overdue`, webhook event `approval.overdue` (`engine/watchdog.ts`). | CC7.2, CC7.3 | A.8.16 | A.6.2.6 |
| Prometheus metrics (partial) | Exposes runs-by-status, pending approvals, total audit events, webhook failures, and proxy decisions allowed/denied (both series emitted at zero so a scrape can alert on a denial spike). Opt-in via `MAKERCHECKER_METRICS=1`; the `/metrics` endpoint has no auth and is for in-perimeter scrapers. | `metrics.ts`; `GET /metrics` (`makerchecker_proxy_decisions_total{decision="denied"}`, `makerchecker_approvals_pending`, `makerchecker_audit_events_total`). | CC7.2 | A.8.16 | A.6.2.6 |
| Proxy-session governance record | Every external tool-call check (allowed or denied) records a frozen role snapshot and an audit event, so a framework-run agent still produces an evidentiary record. Denied checks never enter the SoD actor set. | Audit events `proxy.session.opened`, `proxy.check.allowed`, `proxy.result.recorded`, `proxy.session.closed`, and `enforcement.*` on denial (`proxy/service.ts`); `proxy_actions` rows; metric `makerchecker_proxy_decisions_total`. | CC7.2, CC7.3 | A.8.15, A.8.16 | A.6.2.6, A.6.2.8 |

## Change management

| Control | What it does | Evidence | SOC 2 TSC | ISO 27001:2022 Annex A | ISO 42001 |
|---|---|---|---|---|---|
| Immutable published skills | A trigger rejects any update except `published`→`deprecated`; PATCH returns 405; deprecated skills no longer execute. Changed behavior requires a new version. | `migrations/0001_init.sql` (`skills_immutable` trigger); enforcement refuses non-published in `engine/enforcement.ts`. Audit events `skill.published`, `skill.deprecated`. | CC8.1 | A.8.32 | — |
| Immutable published flow versions | A trigger allows only `published`→`archived`; definitions are validated at publish time, never at run time. Drafts are freely editable. | `migrations/0001_init.sql` (`flow_versions_immutable` trigger). Audit event `flow.published`; PATCH on a published version rejected. | CC8.1 | A.8.32 | — |
| Append-only grant and constraint ledger | Grants and SoD constraints are revoked (`revoked_at`), never deleted, so any past permission state is reconstructable; roles cannot be deleted. | `migrations/0001_init.sql` (partial unique index, `revoked_at`). Audit events `grant.created`, `grant.revoked`, `sod_constraint.created`, `sod_constraint.revoked`, `role.created`; `cli.js audit access-review` "Grant history (including revocations)" table. | CC8.1, CC6.3 | A.5.18, A.8.32 | A.9.2, A.6.2.8 |
| Signed export bundles | `audit export` produces `{ manifest, events }` signed with the instance Ed25519 key (private key never leaves the deployment); the manifest carries count, first/last seq, head hash, and an event-hash digest. A **full** bundle proves genesis-rooted completeness; a **run** bundle binds events to one run but does not prove completeness against omission. Retaining bundles off-box anchors chain height so truncation is detectable. | `cli.js audit export [--run <id>] [--out <file>]`; `docs/audit-spec.md`; `docs/security-model.md`. | CC7.2, CC8.1 | A.8.15, A.8.16 | A.6.2.8 |
| Offline bundle verification | Verifies signature, count, hash-set digest, per-event hashes, linkage (full bundles) or run_id binding (run bundles), and head, with no database access; `--key` pins the expected instance public key so a re-signed bundle is rejected. | `cli.js audit verify-bundle --in <file> [--key <pubkey.pem>]` (`cli.ts`, `audit/export.ts`); `docs/audit-spec.md`. | CC7.2 | A.8.15, A.8.16 | A.6.2.8 |
| Access-review report | Per role: which agents hold it, current active grants, full grant history with revocations (who, when), and SoD constraints. The periodic "who can do what right now" artifact. | `cli.js audit access-review [--out <file.html>]` (`reports/access-review.ts`); `GET /api/reports/access-review`. | CC6.3, CC8.1 | A.5.18, A.8.2 | A.9.2 |
| Run evidence pack | A self-contained HTML file: run header, step timeline with redacted I/O, approvals with verbatim decider and reason, audit-event list, and a live chain-verification statement with the instance public-key fingerprint. States "must not be relied on as evidence" if verification fails. | `cli.js audit report --run <id> [--out <file.html>]` (`reports/run-report.ts`). | CC7.3, CC8.1 | A.8.15, A.8.16 | A.6.2.8 |
| Versioned migrations | Plain-SQL numbered migrations apply controlled schema change; immutability triggers make published artifacts append-only. | `packages/server/migrations/0001..0007`; `db/migrate.ts`. | CC8.1 | A.8.32 | — |

## Data protection

| Control | What it does | Evidence | SOC 2 TSC | ISO 27001:2022 Annex A | ISO 42001 |
|---|---|---|---|---|---|
| Redaction hook (partial) | `MAKERCHECKER_REDACTION=example` masks emails and long digit runs on the write path (before `llm.call` and `skill.invoked` payloads are hashed) and the read path (`GET /api/runs/:id`, the evidence pack). Opt-in; the shipped redactor is an example, deployments supply their own. At-rest `flow_runs`/`step_runs` rows stay raw; database encryption is a deployment concern. | `llm/redaction.ts`; applied in `reports/run-report.ts` and `app.ts`. | CC6.1, CC6.7 | A.8.11 | — |
| Hardened non-owner database role (partial) | `ops/harden-db.sql` provisions `mc_app_runtime` (NOSUPERUSER, NOINHERIT) with UPDATE/DELETE/TRUNCATE revoked on `audit_events` and `instance`, so a compromised application credential can append audit rows but cannot rewrite, delete, or disable their triggers. Not the default: the quickstart connects as the table owner. | `ops/harden-db.sql` (`CREATE ROLE`, `REVOKE` on `audit_events`/`instance`, superuser/role-membership precondition); `docker-compose.hardened.yml`; `docs/security-model.md`. Confirm with `SELECT has_table_privilege('mc_app_runtime','audit_events','UPDATE')` → false. | CC6.1, CC6.7 | A.8.3, A.8.4 | — |
| SSRF and DNS-rebinding guard | Static host validation rejects literal private, loopback, link-local IPs and metadata hostnames; connect-time IP pinning re-checks every resolved A/AAAA address with the same ruleset and pins the socket to the validated address, closing the rebinding window. Unrecognized addresses fail closed. Applies to HTTP skill fetch, webhook dispatch, and MCP transport. | `skills/ssrf-guard.ts` (`resolveAndCheckHost`, `createPinnedFetch`); `docs/security-model.md`. `MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS=1` is dev/test only. | CC6.6, CC6.7 | A.8.20, A.8.21, A.8.23 | — |
| stdio-skill command allowlist | Registering a stdio skill is admin-only; the validator denies shells, package-fetching launchers (npx, uvx, pip), and code-evaluating interpreter flags by default. Production sets `MAKERCHECKER_STDIO_ALLOWED_COMMANDS` to a hard exact allowlist. | `skills/invoker.ts` (stdio command validator, `MAKERCHECKER_STDIO_ALLOWED_COMMANDS`); `docs/security-model.md`. | CC6.1, CC6.6 | A.8.19, A.8.20 | — |
| Role-limits write-time validation | `POST /roles` rejects a malformed `roles.limits` with 400 (strict non-coercing schema check) so a string is not silently coerced; runtime checks additionally fail closed on any uninterpretable ceiling. | `validateRoleLimitsHook` (`api/admin-routes.ts`); fail-closed runtime in `engine/limits.ts`; `docs/security-model.md`. | CC6.1 | A.8.2 | A.9.2 |
| Cryptographic key handling (partial) | The instance Ed25519 signing key is stored on the deployment (file, mode 0600) and `instance.public_key_pem` is write-once with no in-place rotation. Cryptography is used; there is no external key-management service or managed key lifecycle. | `audit/export.ts` (signing); `migrations/0007_instance_immutable.sql` (write-once `public_key_pem`); `docs/audit-spec.md`. | CC6.1 | A.8.24, A.5.17 | — |

## AI-specific

| Control | What it does | Evidence | SOC 2 TSC | ISO 27001:2022 Annex A | ISO 42001 |
|---|---|---|---|---|---|
| One role per agent, deny-by-default grants | Each agent holds exactly one role; skills are deny-by-default and version-pinned, defining the agent's operational constraints. | `migrations/0001_init.sql` (one `role_id` per agent); `engine/enforcement.ts`. | CC6.1, CC6.3 | A.5.15, A.8.2 | A.9.2, A.6.2.6 |
| Re-checked enforcement | Enforcement runs at both decision and invocation time, so an in-flight change cannot widen what an agent does. | `engine/enforcement.ts` (deny by default, twice); audit event `enforcement.blocked`. | CC6.3 | A.8.2 | A.6.2.4 |
| Frozen as-run enforcement | Role limits are frozen into `limits_snapshot` at scheduling, so a live config edit cannot widen what an in-flight run executes; the record reflects what was enforced. | `engine/limits.ts` (`getEnforcedLimits` reads `limits_snapshot`); `migrations/0006_limits_snapshot.sql`. | CC6.3, CC8.1 | A.8.2 | A.6.2.6 |
| Enforcement-filtered tool resolution | The LLM tool-use loop presents only the step's enforcement-filtered granted skills; an unknown or hallucinated tool is rejected and cannot negotiate with an enforcement result. Token and per-skill budgets are enforced fail-closed before each call. | `engine/llm-executor.ts` (filtered tools, unknown-tool rejection); `engine/limits.ts` (`checkTokenBudget`, `assertSkillLimits`). | CC6.1, CC6.3 | A.8.2 | A.9.2, A.6.2.6 |
| Agent-action records (partial) | Every `llm.call` and `skill.invoked` is recorded into the hash-chained log after redaction, supplying records of AI-system operation. This is the technical substrate for ISO 42001 records and logging controls; impact assessment (A.5.x), data-for-AI governance (A.7.x), and transparency-to-users (A.8.x) are management-system process controls MakerChecker does not itself produce. | Audit events `llm.call`, `skill.invoked` (`engine/llm-executor.ts`); chained log in `audit/writer.ts` and `migrations/0001_init.sql`. | CC7.2 | A.8.15 | A.6.2.7, A.6.2.8 |

## Producing the evidence

The four commands that emit assessor-facing artifacts:

- `cli.js audit verify` — recompute and verify the live chain; returns
  `{ ok, count, headHash }` or names the first broken row.
- `cli.js audit export [--run <id>] [--out <file>]` — write a signed bundle for
  off-box retention.
- `cli.js audit verify-bundle --in <file> [--key <pubkey.pem>]` — verify a bundle
  offline, with no database access.
- `cli.js audit access-review [--out <file.html>]` — render the role, grant, and
  SoD review (also at `GET /api/reports/access-review`).
- `cli.js audit report --run <id> [--out <file.html>]` — render a self-contained
  run evidence pack with an embedded chain-verification statement.

The chain format and offline verification steps are specified in
[audit-spec.md](audit-spec.md), reimplementable in any language. Deployment
hardening that backs the immutability and egress controls above —
the non-owner database role, signed-bundle retention, key pinning, the SSRF
guard, the stdio allowlist, and strict segregation of duties — is in
[security-model.md](security-model.md). The governed primitives are described in
[concepts.md](concepts.md).
