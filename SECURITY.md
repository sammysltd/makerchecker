# Security Policy

## Supported versions

Security fixes land on the latest 1.x release and the `main` branch.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (the **Report a vulnerability** button under the Security tab), or email **hello@makerchecker.ai**.

Please include a reproduction or proof of concept where possible. You should receive an acknowledgement within 72 hours.

We follow **90-day coordinated disclosure**: we ask that you give us 90 days from your report before public disclosure; we will credit you (unless you prefer otherwise) and aim to ship fixes well inside that window. Good-faith research under this policy will not be met with legal action.

## In scope

Reports in these areas are especially valuable — they attack the product's core claims:

- **Audit chain tamper-evidence.** Any way to modify, remove, insert, or reorder audit events without detection by `audit verify` or bundle verification; any way to forge a bundle that verifies under a key you do not hold; canonicalization ambiguities that let two different events produce the same hash.
- **Enforcement bypasses.** Executing a skill without an active grant, evading a segregation-of-duties constraint, running a high-risk skill without a preceding approval gate, or acting as a suspended/retired agent — at decision time or invocation time.
- **Authentication.** API-key handling, key-hash storage, auth-hook gaps (routes reachable without a valid key when auth is enabled).

Also in scope: SQL injection, SSRF via skill implementations or webhooks, and secrets leaking into logs or audit payloads.

## Out of scope

- Deployments running with `MAKERCHECKER_AUTH_DISABLED=1` (explicitly a local demo mode).
- Denial of service via resource exhaustion on unauthenticated endpoints (`/healthz`).
- Vulnerabilities in dependencies without a demonstrated impact on MakerChecker.

## Security model and hardening

MakerChecker is designed for regulated, adversarial-insider environments. This
section describes the security model and the recommended production
configuration. None of the controls below is reachable by an unauthenticated or
ordinary authenticated caller; the guidance is about deploying for defence in
depth, so the audit and enforcement guarantees hold even against a compromised
application credential or a privileged insider.

- **Run the server as a non-owner database role in production.** The append-only
  `audit_events` triggers and the immutable `instance` row guard are enforced at
  the table level. Because a PostgreSQL table *owner* can disable its own
  triggers, the production-grade configuration runs the application as a role that
  does **not** own those tables and has `UPDATE`/`DELETE`/`TRUNCATE` `REVOKE`d on
  `audit_events` and `instance` — it can append audit rows but never mutate,
  delete, or disable the guards on them. This keeps the append-only guarantee
  intact even if the application credential is compromised. The committed,
  idempotent [`ops/harden-db.sql`](ops/harden-db.sql) provisions exactly this:
  run it once **as the table owner** after migrations (`psql "$DATABASE_URL_OWNER"
  -v mc_runtime_password='<strong>' -f ops/harden-db.sql`), then connect the
  server as `mc_app_runtime`. It is kept out of the normal migrations on purpose:
  `CREATE ROLE` needs elevated privileges that ephemeral test/CI databases do not
  grant, so the single-role `docker compose` default stays simple for evaluation.
  The instance public key is published once (the first key-bearing operation,
  typically the first `audit export`/`audit report`); `ensureInstanceKeys` only
  writes when the key is absent or differs, so steady state needs only `SELECT`
  on `instance`. The script grants the role `UPDATE (public_key_pem)` on
  `instance` just for that first publication (or pre-seed `instance.public_key_pem`
  and drop that grant), after which `SELECT` suffices; the write-once
  `instance_immutable` trigger still blocks any later rotation. The non-owner role
  does not run `migrate()` at boot (it has no `CREATE` on the public schema), so
  the owner runs migrations separately and the server starts with
  `MAKERCHECKER_SKIP_MIGRATE=1`. The ready two-role stack is
  [`docker-compose.hardened.yml`](docker-compose.hardened.yml); the full
  walkthrough is [docs/db-hardening.md](docs/db-hardening.md). The hash chain's
  recompute-on-read detection applies under either configuration.
- **Retain signed export bundles off-box.** `audit verify` proves the live chain
  is internally consistent and rooted at genesis. Periodically running
  `audit export` and retaining the signed bundles off the database gives you an
  independent anchor on the chain's height: each bundle carries the event count,
  head hash, and an Ed25519 signature, so truncating the tail or rolling the
  chain back is detectable as a drop in count or a head that no longer extends a
  retained bundle. This is the standard way to operate a tamper-evident log for
  regulator-grade assurance — keep the bundles where the database role cannot
  reach them.
- **Distribute the instance public key through a trusted channel.** A bundle
  proves integrity and origin under the key embedded in it; pin the instance
  public key once, out of band, so a verifier knows which key is legitimate. The
  `instance` row's `public_key_pem` is write-once (no in-place rotation), so a
  silent key swap in the database is rejected. For adversarial-insider assurance,
  cross-check new bundles against externally retained earlier ones — the
  off-box bundle history is the anchor that an insider holding the signing key
  cannot rewrite.
- **Restrict stdio skills with an allowlist in production.** A `stdio` skill
  spawns a local process (`command` + `args`); registering skills is admin-only.
  By default the validator denies shells, package-fetching launchers
  (`npx`/`uvx`/`pip`/…), and any interpreter flag that evaluates code (it forbids
  passing recognized runtimes like `node`/`python` *any* flag, and rejects the
  `-e`/`-c`/`-m`/`-r`/`--import`/… families for every command). For production,
  set the hard allowlist `MAKERCHECKER_STDIO_ALLOWED_COMMANDS` so only an exact,
  known set of commands may spawn — the strongest control, pinning stdio skills
  to commands you have explicitly approved.
- **SSRF and DNS rebinding are blocked on every outbound path.** Two layers
  defend outbound HTTP. (1) *Static host validation* (`assertSafeHttpUrl`)
  rejects literal private/loopback/link-local IPs and known metadata hostnames,
  and blocks private hosts entirely unless `MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS=1`.
  (2) *Connect-time IP pinning* (`skills/ssrf-guard.ts`) defeats DNS rebinding (a
  public-looking hostname that *resolves* to a private address at connect time):
  an undici `Agent` resolves the host (all A/AAAA records), re-checks each address
  with the same ruleset (`isBlockedIpv4`/`isBlockedIpv6`), and pins the socket to
  the validated address so there is no second, unchecked resolution before the TCP
  connect. Every outbound path runs through this pinned dispatcher — the HTTP
  skill fetch (`skills/invoker.ts`), the outbound webhook fetch
  (`webhooks/dispatcher.ts`), and the MCP `StreamableHTTPClientTransport` (which
  accepts our fetch); the MCP path additionally validates the host before the
  transport is built. The `MAKERCHECKER_ALLOW_PRIVATE_SKILL_HOSTS=1` opt-in
  disables private-IP rejection for localhost dev/test only; leave it unset in
  production and restrict egress at the network layer for defence in depth.
- **Demo seeding is opt-in.** The bundled demo (an admin account, sample
  agents/flows, and the demo local skills) is seeded only when
  `MAKERCHECKER_SEED_DEMO=1`. A default image (the variable unset) seeds nothing,
  so no admin account or admin API key is created on a production deployment. The
  demo local skills read files only within the configured `DEMO_DATA_DIR` tree
  (specifically its parent directory, where the sibling sample data lives); a
  caller-supplied path that escapes that tree is rejected, and with
  `DEMO_DATA_DIR` unset the skills read nothing.
- **Role limits are schema-validated at write time.** `POST /roles` rejects a
  malformed `roles.limits` object with a 400 before the role is saved
  (`validateRoleLimitsHook` in `api/admin-routes.ts`, a strict non-coercing ajv
  check against the `RoleLimits` TypeBox schema that mirrors `RoleLimits`/
  `SkillLimitConfig` in `engine/limits.ts`). Coercion is deliberately off so a
  value like `"7"` is not silently rewritten to `7` and a ceiling cannot be
  retargeted by a type change. This is defense in depth on top of the last line:
  the runtime checks in `engine/limits.ts` fail **closed** (deny rather than
  pass) on any limit they cannot interpret, so a malformed ceiling that reached
  the database some other way is still denied at decision time.
- **Run limits are pinned per run.** A run's role limits are frozen once per
  `(run, role)`, so a mid-run edit to `roles.limits` cannot raise an in-flight
  run's ceiling. Reassigning the *agent* to a different role (`PATCH /agents/:id`,
  admin-only) resolves the new role's limits on the next step; since an
  administrator can already set limits for future runs, this is admin-controlled
  determinism within the same trust boundary, not a privilege escalation.

## Auditing the audit chain

The audit chain's verification is fully specified in the [audit spec](docs/audit-spec.md) and designed to be reproduced offline, in any language, by anyone — no access to our systems required. Attacks on its tamper-evidence are the most valuable reports we can receive: that open, reproducible spec is the review. Findings against the chain, the canonicalization, or the signed export bundles are explicitly in scope above.
