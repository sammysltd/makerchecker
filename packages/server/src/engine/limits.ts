import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";

/**
 * Role limits & budgets (M11): roles.limits is an ENFORCED contract, checked
 * immediately before every skill invocation (both executors and the proxy)
 * and before every LLM provider call.
 *
 * Shape:
 *   {
 *     skills?: { "<name@version>": { maxInvocationsPerRun?, maxAmountPerInvocation?, amountField? } },
 *     run?:    { maxSkillInvocations?, maxTokens? }
 *   }
 *
 * Counting is conservative: invocation counts come from audit_events
 * `skill.invoked` rows for the run — ALL attempts including errors. Token
 * usage sums the `llm.call` usage payloads for the run. FAIL CLOSED: a
 * configured amount limit with a missing or non-numeric amount field denies
 * the call; an unreadable limit value denies everything it governs.
 */

export type LimitViolationCode =
  | "limit_invocations"
  | "limit_amount"
  | "limit_amount_unreadable"
  | "limit_tokens"
  | "limit_run_invocations";

export class LimitViolationError extends Error {
  override name = "LimitViolationError";
  constructor(
    readonly code: LimitViolationCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SkillLimitConfig {
  maxInvocationsPerRun?: number;
  maxAmountPerInvocation?: number;
  amountField?: string;
}

export interface RoleLimits {
  skills?: Record<string, SkillLimitConfig>;
  run?: { maxSkillInvocations?: number; maxTokens?: number };
}

/** Minimal query surface satisfied by both pg.Pool and pg.PoolClient. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** Loads a role's limits; an unknown role is ambiguity, so it fails closed. */
export async function getRoleLimits(db: Queryable, roleId: string): Promise<RoleLimits> {
  const { rows } = await db.query<{ limits: RoleLimits | null }>(
    "SELECT limits FROM roles WHERE id = $1",
    [roleId],
  );
  if (!rows[0]) {
    throw new Error(`role ${roleId} not found while evaluating limits — failing closed`);
  }
  return rows[0].limits ?? {};
}

/**
 * Loads the limits a step run must be enforced against: the FROZEN copy taken
 * at scheduling time (step_runs.limits_snapshot), NOT the live roles.limits.
 * This is the security boundary — an admin editing roles.limits mid-run must
 * not change what an already-scheduled run enforces. The most recent step_run
 * for the (run, role) pair wins (a retry re-freezes at its own scheduling).
 *
 * Fallback: when no step_run exists for the pair, there is nothing scheduled to
 * govern, so the live limits are read instead — this covers callers that
 * evaluate budgets outside the scheduled step path (e.g. estimate-only token
 * checks) and unknown roles still fail closed via getRoleLimits. The scheduled
 * step path ALWAYS has a step_run, so it always reads the frozen snapshot.
 */
export async function getEnforcedLimits(
  db: Queryable,
  runId: string,
  roleId: string,
): Promise<RoleLimits> {
  const { rows } = await db.query<{ limits_snapshot: RoleLimits | null }>(
    `SELECT limits_snapshot FROM step_runs
      WHERE run_id = $1 AND role_id_snapshot = $2 AND limits_snapshot IS NOT NULL
      ORDER BY started_at DESC NULLS LAST, id DESC
      LIMIT 1`,
    [runId, roleId],
  );
  if (rows[0]) {
    return rows[0].limits_snapshot ?? {};
  }
  return getRoleLimits(db, roleId);
}

/** Parses a configured limit value; unreadable config denies (fail closed). */
function readLimit(value: unknown, code: LimitViolationCode, what: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new LimitViolationError(code, `${what} is set but unreadable — failing closed`);
  }
  return n;
}

/**
 * The single per-skill evaluation shared by both executors and the proxy:
 * the caller supplies how many invocations of this skill ALREADY happened in
 * its scope (run or proxy session); this decides whether one more is allowed.
 */
export function assertSkillLimits(
  cfg: SkillLimitConfig,
  priorInvocations: number,
  input: Record<string, unknown>,
  skillRef: string,
): void {
  if (cfg.maxInvocationsPerRun !== undefined) {
    const max = readLimit(
      cfg.maxInvocationsPerRun,
      "limit_invocations",
      `maxInvocationsPerRun for "${skillRef}"`,
    );
    if (priorInvocations >= max) {
      throw new LimitViolationError(
        "limit_invocations",
        `skill "${skillRef}" has reached its invocation limit (${max}) in this scope`,
      );
    }
  }
  if (cfg.maxAmountPerInvocation !== undefined) {
    const max = readLimit(
      cfg.maxAmountPerInvocation,
      "limit_amount",
      `maxAmountPerInvocation for "${skillRef}"`,
    );
    const field = cfg.amountField ?? "amount";
    const value = input[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new LimitViolationError(
        "limit_amount_unreadable",
        `skill "${skillRef}" has an amount limit but input field "${field}" is missing ` +
          `or non-numeric — denied (fail closed)`,
      );
    }
    // A negative amount must never slip UNDER the ceiling: a "-1,000,000"
    // transfer is below max but is not a benign value, and signed amounts are
    // not a legitimate use of an amount ceiling. Reject anything below zero.
    if (value < 0) {
      throw new LimitViolationError(
        "limit_amount",
        `skill "${skillRef}" amount ${value} is negative — denied (fail closed)`,
      );
    }
    if (value > max) {
      throw new LimitViolationError(
        "limit_amount",
        `skill "${skillRef}" amount ${value} exceeds the per-invocation limit of ${max}`,
      );
    }
  }
}

async function countInvocations(
  db: Queryable,
  runId: string,
  skillRef?: string,
): Promise<number> {
  const { rows } = skillRef
    ? await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events
          WHERE event_type = 'skill.invoked' AND run_id = $1 AND payload->>'skillRef' = $2`,
        [runId, skillRef],
      )
    : await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events
          WHERE event_type = 'skill.invoked' AND run_id = $1`,
        [runId],
      );
  return rows[0]!.n;
}

/**
 * Checks the run-level invocation budget and this skill's per-run limits.
 * Called immediately before EVERY skill invocation in a flow run.
 */
export async function checkSkillLimit(
  db: Pool | PoolClient,
  args: { runId: string; roleId: string; skillRef: string; input: Record<string, unknown> },
): Promise<void> {
  const limits = await getEnforcedLimits(db, args.runId, args.roleId);
  const runMax = limits.run?.maxSkillInvocations;
  const skillCfg = limits.skills?.[args.skillRef];
  if (runMax === undefined && skillCfg === undefined) return;

  if (runMax !== undefined) {
    const max = readLimit(runMax, "limit_run_invocations", "run.maxSkillInvocations");
    const total = await countInvocations(db, args.runId);
    if (total >= max) {
      throw new LimitViolationError(
        "limit_run_invocations",
        `run has reached its skill-invocation budget (${max})`,
      );
    }
  }
  if (skillCfg !== undefined) {
    const prior = await countInvocations(db, args.runId, args.skillRef);
    assertSkillLimits(skillCfg, prior, args.input, args.skillRef);
  }
}

/**
 * Checks the run's token budget against the llm.call usage already audited.
 * Called BEFORE each provider call, so a violation fails the step without
 * spending another model invocation.
 */
export async function checkTokenBudget(
  db: Pool | PoolClient,
  args: { runId: string; roleId: string; nextEstimate?: number },
): Promise<void> {
  const limits = await getEnforcedLimits(db, args.runId, args.roleId);
  const maxTokens = limits.run?.maxTokens;
  if (maxTokens === undefined) return;
  const max = readLimit(maxTokens, "limit_tokens", "run.maxTokens");

  const { rows } = await db.query<{ used: string }>(
    `SELECT coalesce(sum(
              coalesce((payload#>>'{usage,inputTokens}')::numeric, 0)
            + coalesce((payload#>>'{usage,outputTokens}')::numeric, 0)), 0) AS used
       FROM audit_events
      WHERE event_type = 'llm.call' AND run_id = $1`,
    [args.runId],
  );
  const used = Number(rows[0]!.used);
  if (used + (args.nextEstimate ?? 0) >= max) {
    throw new LimitViolationError(
      "limit_tokens",
      `run has used ${used} of its ${max}-token budget — LLM call denied`,
    );
  }
}
