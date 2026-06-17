# MakerChecker Helm chart

Deploy the MakerChecker server (Fastify on Postgres) to Kubernetes. The chart is
at [`makerchecker/`](makerchecker). Ready-made value sets are in
[`examples/`](examples).

```bash
helm install makerchecker deploy/helm/makerchecker -f deploy/helm/examples/values-external-db.yaml
```

## What it deploys

- A single Deployment running the server image as non-root uid 1000 under the
  restricted PodSecurity profile (drop all capabilities, no privilege
  escalation, read-only root filesystem with a `/tmp` tmpfs, seccomp
  RuntimeDefault).
- A PersistentVolumeClaim mounted at `MAKERCHECKER_DATA_DIR` (`/data`) for the
  instance signing key, with `fsGroup: 1000` so uid 1000 can write it.
- A ClusterIP Service, an optional Ingress, a PodDisruptionBudget, a
  ServiceAccount, a ConfigMap (non-secret config), and a Secret (DATABASE_URL
  and optional provider keys).
- In hardened mode, a pre-install/pre-upgrade Job that migrates and applies
  `ops/harden-db.sql` as the database owner before the server rolls out.

## The signing key must persist

On the first key-bearing operation the server writes an Ed25519 private key to
`/data` and publishes the matching public key to the database exactly once
(write-once, frozen by a trigger). If that private key is lost on a restart, the
instance can never again produce a verifiable signed export bundle. So `/data`
is a PersistentVolumeClaim, never an emptyDir. The chart refuses to render unless
`persistence.enabled=true` or `persistence.existingClaim` is set. Back the volume
up and escrow the key as covered in [docs/backup-restore.md](../../docs/backup-restore.md).

## Probes

`livenessProbe` hits `GET /healthz` (no database call, stays green during a
transient database outage so the pod is not restarted). `readinessProbe` hits
`GET /readyz` (runs `SELECT 1`, returns 503 while draining or when the database
is unreachable). Both are unauthenticated and rate-limit-exempt.

## Database: external vs bundled

Set `postgresql.enabled=false` (the default) and point the chart at an external
managed Postgres. The connection string is read from a Secret you create out of
band; the chart never templates a connection string into a rendered Secret.

```bash
kubectl create secret generic makerchecker-db \
  --from-literal=DATABASE_URL='postgres://mc_app_runtime:<runtime-pw>@db.internal:5432/makerchecker' \
  --from-literal=DATABASE_URL_OWNER='postgres://makerchecker:<owner-pw>@db.internal:5432/makerchecker' \
  --from-literal=MC_RUNTIME_PASSWORD='<runtime-pw>'

helm install makerchecker deploy/helm/makerchecker \
  --set database.existingSecret=makerchecker-db
```

`postgresql.enabled=true` ships a single-replica Postgres for evaluation only. It
has no HA and no backups. Do not use it for anything you need to keep. See
[`examples/values-bundled-eval.yaml`](examples/values-bundled-eval.yaml).

## Single-role vs hardened (two-role)

`hardened.enabled=true` (default) runs the two-role model. A pre-install Job runs
`node dist/cli.js migrate` then `psql -f ops/harden-db.sql` as the database
owner; `harden-db.sql` provisions the non-owner `mc_app_runtime` role and revokes
UPDATE/DELETE/TRUNCATE on `audit_events` and `instance`. The Job is ordered
before the rollout with a Helm hook; the migrate step is an initContainer that
must exit 0 before the harden container runs. The server Deployment then connects
as `mc_app_runtime` with `MAKERCHECKER_SKIP_MIGRATE=1`, because that role lacks
CREATE on the public schema and cannot run migrations.

The hardened mode needs two distinct connection strings and the runtime password:

| Key | Role | Used by |
|---|---|---|
| `DATABASE_URL` | `mc_app_runtime` (non-owner) | server Deployment |
| `DATABASE_URL_OWNER` | owner | migrate + harden Job |
| `MC_RUNTIME_PASSWORD` | runtime password | harden Job (sets the role password) |

When you supply `database.existingSecret`, that Secret must carry all three keys.
`MC_RUNTIME_PASSWORD` is set once: `harden-db.sql` does not reset the role
password on re-runs, so rotate it out of band with `ALTER ROLE mc_app_runtime
PASSWORD ...` if needed.

`hardened.enabled=false` is the single-role eval path: the server connects as the
owner and runs migrations at boot. The owner can disable the append-only audit
triggers, so use it only for evaluation. See
[`examples/values-single-role.yaml`](examples/values-single-role.yaml).

## First admin

Nothing is seeded by default. After install, mint the first admin and its API key
(printed once):

```bash
kubectl exec deploy/makerchecker -- \
  node dist/cli.js bootstrap-admin --email admin@your-org.example --name 'Platform Admin'
```

Verify the audit chain at any time:

```bash
kubectl exec deploy/makerchecker -- node dist/cli.js audit verify
```

## Values reference

| Key | Default | Purpose |
|---|---|---|
| `image.repository` / `image.tag` / `image.digest` | `ghcr.io/sammysltd/makerchecker-server` / chart appVersion / "" | Server image; digest wins over tag when set |
| `replicaCount` | `1` | Server replicas |
| `hardened.enabled` | `true` | Two-role migrate + harden vs single-role eval |
| `hardened.postgresImage` | `postgres:17-alpine` | Image with psql for the harden step |
| `database.existingSecret` | `""` | Secret holding DATABASE_URL (and owner URL + runtime password in hardened mode) |
| `database.runtimeUrlKey` / `database.ownerUrlKey` | `DATABASE_URL` / `DATABASE_URL_OWNER` | Keys read from `existingSecret` |
| `database.runtimeUrl` / `database.ownerUrl` / `database.runtimePassword` | `""` | Used only when the chart creates the Secret |
| `secrets.anthropicApiKey` / `secrets.geminiApiKey` | `""` | Optional model provider keys |
| `config.*` | see [values.yaml](makerchecker/values.yaml) | Non-secret server config (port, dataDir, logLevel, redaction, ...) |
| `persistence.enabled` / `persistence.existingClaim` / `persistence.size` | `true` / `""` / `1Gi` | Signing-key PVC |
| `service.type` / `service.port` | `ClusterIP` / `80` | Service |
| `ingress.enabled` / `ingress.className` / `ingress.hosts` | `false` / `""` / `makerchecker.local` | Ingress |
| `podDisruptionBudget.enabled` / `minAvailable` | `true` / `1` | PDB |
| `postgresql.enabled` | `false` | Bundled eval-only Postgres |

## Render the chart locally

```bash
helm lint deploy/helm/makerchecker -f deploy/helm/examples/values-external-db.yaml
helm template makerchecker deploy/helm/makerchecker -f deploy/helm/examples/values-external-db.yaml
```
