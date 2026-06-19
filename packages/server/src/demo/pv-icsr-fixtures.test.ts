/**
 * PV ICSR demo fixtures — capture + drift guard.
 *
 * The marketing "live demo" (makerchecker-site/public/demo) replays a real
 * PV ICSR-processing run through the REAL product components. Its data is NOT
 * hand-written: it is captured from a genuine seeded run against real Postgres
 * with auth ENABLED (see test/demo-capture.ts), so the maker-checker block is
 * the product's actual forbid_requester rejection — the run's requester being
 * refused at the medical-review gate that guards the high-risk seriousness-
 * assess and e2b-submit skills.
 *
 * This test is the anti-drift guarantee: every CI run captures afresh and
 * asserts the behaviour invariants plus the normalised SHAPE against the
 * committed fixture the demo ships. If the API shape changes, this fails until
 * the fixture is regenerated — so the demo can never silently diverge.
 *
 * Regenerate the committed fixture:
 *   CAPTURE_WRITE=1 pnpm --filter @makerchecker/server vitest run src/demo/pv-icsr-fixtures.test.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { captureGatedFlow, normalize, withoutRunning } from "../../test/demo-capture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES = join(HERE, "../../../../examples/pv-icsr-processing/icsr_cases.csv");
const FIXTURE = join(HERE, "../../../web/src/demo/fixtures/pv.json");
// The demo ingest skills confine reads to the parent of DEMO_DATA_DIR; with it
// pointed inside examples/, the bundled scenario fixtures resolve in-root.
const DEMO_DATA_DIR = join(HERE, "../../../../examples/daily-cash-reconciliation");

interface CapturedStep {
  step_key: string;
  status: string;
  output: { expeditedCount: number; expedited: { caseId: string }[] };
}
interface Captured {
  scenes: {
    waiting: { run: { status: string }; steps: CapturedStep[] };
    completed: { run: { status: string } };
  };
  blockedDecision: { status: number; message: string };
  approvedDecision: { status: number };
  verify: { ok: boolean };
}

describe("PV ICSR demo fixtures", () => {
  it(
    "match a freshly-captured real run (drift guard)",
    async () => {
      const savedDataDir = process.env.DEMO_DATA_DIR;
      process.env.DEMO_DATA_DIR = DEMO_DATA_DIR;
      let fresh: Captured;
      try {
        fresh = (await captureGatedFlow({
          flowName: "pv-icsr-processing",
          input: { casesPath: CASES },
          requesterEmail: "admin@makerchecker.local",
          officerEmail: "officer@makerchecker.local",
          officerReason:
            "P-4003 (Cardevol, acute liver failure) and P-4009 (Gastrelin, anaphylaxis) are serious and unexpected; file 15-day expedited ICSRs per 21 CFR 314.80.",
        })) as unknown as Captured;
      } finally {
        if (savedDataDir !== undefined) process.env.DEMO_DATA_DIR = savedDataDir;
        else delete process.env.DEMO_DATA_DIR;
      }

      if (process.env.CAPTURE_WRITE === "1") {
        if (!existsSync(dirname(FIXTURE))) mkdirSync(dirname(FIXTURE), { recursive: true });
        writeFileSync(FIXTURE, JSON.stringify(fresh, null, 2) + "\n");
      }

      // Behaviour invariants — the real product, not the fixture.
      expect(fresh.scenes.waiting.run.status).toBe("waiting_approval");
      // The pre-gate step PROPOSES the expedited cases (advisory, low risk).
      const triage = fresh.scenes.waiting.steps.find((s) => s.step_key === "intake_triage")!;
      expect(triage.status).toBe("completed");
      expect(triage.output.expeditedCount).toBe(2);
      expect(triage.output.expedited.map((e) => e.caseId)).toContain("P-4003");
      // The high-risk submit step must NOT have run before the gate.
      expect(fresh.scenes.waiting.steps.some((s) => s.step_key === "submit")).toBe(false);

      // The run's requester is refused at the gate (forbid_requester) — the
      // product's real maker-checker block, here guarding the high-risk
      // seriousness-assess and e2b-submit skills.
      expect(fresh.blockedDecision.status).toBeGreaterThanOrEqual(400);
      expect(String(fresh.blockedDecision.message).toLowerCase()).toMatch(/approve|request|own/);
      // A separate, authenticated medical reviewer approves; the run completes.
      expect(fresh.approvedDecision.status).toBe(200);
      expect(fresh.scenes.completed.run.status).toBe("completed");
      expect(fresh.verify.ok).toBe(true);

      // Shape drift — normalised fresh capture must equal the committed fixture.
      // The `running` snapshot is timing-dependent, so it is excluded; the
      // deterministic scenes guard the RunDetail shape.
      expect(existsSync(FIXTURE)).toBe(true);
      const committed = JSON.parse(readFileSync(FIXTURE, "utf8"));
      expect(withoutRunning(normalize(fresh))).toEqual(withoutRunning(normalize(committed)));
    },
    90_000,
  );
});
