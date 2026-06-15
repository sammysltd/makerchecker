import {
  makeWorkerUtils,
  run,
  type ParsedCronItem,
  type Runner,
  type WorkerUtils,
} from "graphile-worker";
import type { Pool } from "pg";

import type { EnqueueOptions, ExecutionBackend, TaskHandler } from "./backend.js";

/** Cron schedules registered at start (built by src/boot/cron.ts). */
export interface GraphileStartOptions {
  parsedCronItems?: ParsedCronItem[];
}

/**
 * graphile-worker implementation. LISTEN/NOTIFY wakeups give sub-second step
 * latency. Queue-level maxAttempts is pinned to 1: retries are ENGINE-managed
 * so every attempt is individually audited — the queue must never silently
 * re-run a task and bypass the audit trail.
 */
export class GraphileWorkerBackend implements ExecutionBackend {
  private runner: Runner | null = null;
  private utils: WorkerUtils | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly concurrency = 5,
  ) {}

  async start(
    handlers: Record<string, TaskHandler>,
    options?: GraphileStartOptions,
  ): Promise<void> {
    if (this.runner) throw new Error("backend already started");
    const taskList = Object.fromEntries(
      Object.entries(handlers).map(([name, handler]) => [
        name,
        async (payload: unknown) => {
          await handler(payload);
        },
      ]),
    );
    this.runner = await run({
      pgPool: this.pool,
      taskList,
      concurrency: this.concurrency,
      ...(options?.parsedCronItems ? { parsedCronItems: options.parsedCronItems } : {}),
    });
  }

  async stop(): Promise<void> {
    await this.runner?.stop();
    this.runner = null;
    await this.utils?.release();
    this.utils = null;
  }

  async enqueue(task: string, payload: unknown, opts?: EnqueueOptions): Promise<void> {
    if (!this.utils) {
      this.utils = await makeWorkerUtils({ pgPool: this.pool });
    }
    await this.utils.addJob(task, payload, {
      maxAttempts: 1,
      ...(opts?.runAt ? { runAt: opts.runAt } : {}),
      ...(opts?.jobKey ? { jobKey: opts.jobKey, jobKeyMode: "replace" as const } : {}),
    });
  }
}
