import type { Pool } from "pg";

import { webhookFailureCount } from "./webhooks/dispatcher.js";

/**
 * Hand-rolled Prometheus text exposition (no client library — boring tech).
 * Served at /metrics (root, no auth) when MAKERCHECKER_METRICS=1; the
 * endpoint is for scrapers inside the deployment perimeter, so enabling it
 * is an explicit operator decision.
 */
export async function renderMetrics(pool: Pool): Promise<string> {
  const runs = await pool.query<{ status: string; n: string }>(
    "SELECT status, count(*) AS n FROM flow_runs GROUP BY status ORDER BY status",
  );
  const approvals = await pool.query<{ n: string }>(
    "SELECT count(*) AS n FROM approvals WHERE status = 'pending'",
  );
  const audit = await pool.query<{ n: string }>("SELECT count(*) AS n FROM audit_events");

  const lines = [
    "# HELP makerchecker_runs_total Flow runs by current status.",
    "# TYPE makerchecker_runs_total gauge",
    ...runs.rows.map((r) => `makerchecker_runs_total{status="${r.status}"} ${r.n}`),
    "# HELP makerchecker_approvals_pending Approvals currently awaiting a human decision.",
    "# TYPE makerchecker_approvals_pending gauge",
    `makerchecker_approvals_pending ${approvals.rows[0]!.n}`,
    "# HELP makerchecker_audit_events_total Events recorded in the hash-chained audit log.",
    "# TYPE makerchecker_audit_events_total counter",
    `makerchecker_audit_events_total ${audit.rows[0]!.n}`,
    "# HELP makerchecker_webhook_failures_total Webhook deliveries that exhausted every retry attempt since process start.",
    "# TYPE makerchecker_webhook_failures_total counter",
    `makerchecker_webhook_failures_total ${webhookFailureCount()}`,
  ];
  return `${lines.join("\n")}\n`;
}
