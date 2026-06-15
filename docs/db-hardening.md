# Database hardening: the non-owner runtime role

By default MakerChecker connects to Postgres as the table **owner** and runs
migrations at boot. That is the simplest quickstart, but it has a gap: a
PostgreSQL table owner can `ALTER TABLE ... DISABLE TRIGGER` on its own tables.
The append-only `audit_events` triggers and the write-once `instance` guard bind
at the table level, so an owner credential, if compromised, could disable them
and rewrite the audit log.

The hardening is to run the long-lived server as a **non-owner runtime role**
that can append audit rows but cannot mutate, delete, truncate, or disable the
guards on the tamper-evident tables. This is the "Run the server as a non-owner
DB role" item in [SECURITY.md](../SECURITY.md).

## What the runtime role can and cannot do

After [`ops/harden-db.sql`](../ops/harden-db.sql) runs, the `mc_app_runtime` role:

**Can**
- `CONNECT` to the database and `USAGE` on the `public` schema.
- `SELECT`/`INSERT`/`UPDATE`/`DELETE` on the mutable run-state tables
  (`flow_runs`, `step_runs`, `approvals`, ...) and every other application table.
- `SELECT` and `INSERT` (append) on `audit_events`.
- `SELECT` on `instance`, plus a single `UPDATE (public_key_pem)` for first-boot
  publication of the instance signing key.

**Cannot**
- `UPDATE`, `DELETE`, or `TRUNCATE` `audit_events`: rewriting or removing audit
  history is rejected at the privilege level, before the trigger even fires.
- `UPDATE` (any other column), `DELETE`, or `TRUNCATE` `instance`.
- `ALTER TABLE ... DISABLE TRIGGER` on `audit_events` or `instance`: it does not
  own the tables, so the append-only and write-once guards cannot be turned off.
- `CREATE` shadow tables or functions in `public`, or escalate (`NOSUPERUSER`,
  `NOCREATEDB`, `NOCREATEROLE`).

The write-once `instance_immutable` trigger still blocks key rotation even though
the column `UPDATE (public_key_pem)` grant exists: the role can publish the key
once (`NULL -> value`) and never change it.

## Why it is not a migration

`CREATE ROLE` needs elevated privileges (a superuser, or a `CREATEROLE` role).
The test suite, CI, and the quickstart create ephemeral databases as a single
owner/superuser role and intentionally `DISABLE TRIGGER` in adversarial audit
tests. Running role provisioning inside the normal migrations would break those
flows. So the hardening lives in a separate, idempotent script you run once, as
the owner, after migrations. The default single-role path is untouched.

## Apply it manually

```bash
# 1. Run migrations as the owner (boot does this automatically in single-role,
#    or run it explicitly):
DATABASE_URL="$DATABASE_URL_OWNER" node packages/server/dist/cli.js migrate

# 2. Apply the hardening as the owner (or a superuser). Pass a strong password:
psql "$DATABASE_URL_OWNER" \
  -v mc_runtime_password='<strong-password>' \
  -f ops/harden-db.sql

# 3. Point the server at the runtime role and skip boot-time migrate (the
#    non-owner role has no CREATE on the public schema, so it cannot migrate):
DATABASE_URL="postgres://mc_app_runtime:<strong-password>@HOST:5432/DB" \
  MAKERCHECKER_SKIP_MIGRATE=1 \
  node packages/server/dist/index.js
```

The script is idempotent: re-running it re-asserts the grants/revokes. It does
**not** reset the password on re-run (that needs superuser/ADMIN on the role);
rotate it out of band with `ALTER ROLE mc_app_runtime PASSWORD '<new>'`.

## Apply it with Docker Compose

[`docker-compose.hardened.yml`](../docker-compose.hardened.yml) wires the whole
flow: `postgres` -> `migrate` (owner) -> `harden` (owner runs `ops/harden-db.sql`)
-> `server` (runtime role, `MAKERCHECKER_SKIP_MIGRATE=1`).

```bash
MC_RUNTIME_PASSWORD=<strong-password> \
  docker compose -f docker-compose.hardened.yml up --build
```

The default `docker-compose.yml` stays single-role for the quickstart.

## Verify

Connected as `mc_app_runtime`:

```sql
SELECT has_table_privilege('audit_events', 'INSERT');  -- t
SELECT has_table_privilege('audit_events', 'UPDATE');  -- f
SELECT has_table_privilege('audit_events', 'DELETE');  -- f
```

```sql
-- All rejected:
UPDATE audit_events SET event_type = 'x';                       -- permission denied
DELETE FROM audit_events;                                       -- permission denied
ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete; -- must be owner
```

The hash chain's recompute-on-read detection applies either way; the runtime
role just removes the in-band path to disabling the table-level guards.
