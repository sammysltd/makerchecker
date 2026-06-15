import { describe, expect, it } from "vitest";

import { isApprovalGate, validateFlowDefinition } from "./flow-definition.js";

const VALID = {
  name: "daily-cash-reconciliation",
  steps: [
    {
      key: "prepare",
      agent: "recon-preparer",
      skills: ["csv-ingest@1", "txn-match@1"],
      instructions: "Match transactions, list exceptions.",
      retries: { max_attempts: 3, backoff: "exponential" },
      timeout_ms: 120_000,
    },
    { key: "exception_review", type: "approval_gate", title: "Review exceptions" },
    { key: "report", agent: "recon-reporter", skills: ["notify@1"] },
  ],
};

describe("validateFlowDefinition", () => {
  it("accepts a well-formed definition", () => {
    const result = validateFlowDefinition(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.definition.steps).toHaveLength(3);
  });

  it("rejects unknown keys (typo protection)", () => {
    const result = validateFlowDefinition({
      ...VALID,
      steps: [{ ...VALID.steps[0], timeout: 5000 }],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects malformed and non-canonical skill references", () => {
    for (const bad of [
      "csv-ingest",
      "csv-ingest@",
      "csv-ingest@v1",
      "@1",
      "Csv@1",
      // non-canonical version spellings that resolve to the same skill but would
      // miss the limit-map key (must be rejected, not silently accepted):
      "csv-ingest@01", // leading zero
      "csv-ingest@0", // version 0 is not a real version
      "csv-ingest@1@2", // extra @-segment
      "csv-ingest@1 ", // trailing whitespace
    ]) {
      const result = validateFlowDefinition({
        name: "f",
        steps: [{ key: "s", agent: "a", skills: [bad] }],
      });
      expect(result.ok, `should reject ${bad}`).toBe(false);
    }
  });

  it("accepts canonical multi-digit versions", () => {
    const result = validateFlowDefinition({
      name: "f",
      steps: [{ key: "s", agent: "a", skills: ["csv-ingest@10"] }],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate step keys", () => {
    const result = validateFlowDefinition({
      name: "f",
      steps: [
        { key: "same", agent: "a", skills: ["x@1"] },
        { key: "same", agent: "b", skills: ["y@1"] },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("duplicate step key");
  });

  it("rejects flows with no agent steps", () => {
    const result = validateFlowDefinition({
      name: "f",
      steps: [{ key: "gate", type: "approval_gate", title: "T" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("at least one agent step");
  });

  it("rejects consecutive approval gates", () => {
    const result = validateFlowDefinition({
      name: "f",
      steps: [
        { key: "a", agent: "x", skills: ["s@1"] },
        { key: "g1", type: "approval_gate", title: "One" },
        { key: "g2", type: "approval_gate", title: "Two" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("consecutive approval gates");
  });

  it("rejects empty steps, bad names, and non-objects", () => {
    expect(validateFlowDefinition({ name: "f", steps: [] }).ok).toBe(false);
    expect(validateFlowDefinition({ name: "Bad Name", steps: VALID.steps }).ok).toBe(false);
    expect(validateFlowDefinition(null).ok).toBe(false);
    expect(validateFlowDefinition("steps: []").ok).toBe(false);
  });

  it("reports structural errors with paths", () => {
    const result = validateFlowDefinition({ name: "f", steps: [{ key: "s" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("approval gate approvals object (n-of-m)", () => {
  const gated = (approvals: Record<string, unknown>) => ({
    name: "f",
    steps: [
      { key: "work", agent: "a", skills: ["s@1"] },
      { key: "gate", type: "approval_gate", title: "T", approvals },
    ],
  });

  it("accepts min_approvals, approver_emails and forbid_requester", () => {
    const result = validateFlowDefinition(
      gated({
        min_approvals: 2,
        approver_emails: ["alice@bank.example", "bob@bank.example"],
        forbid_requester: true,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts an empty approvals object and forbid_requester alone", () => {
    expect(validateFlowDefinition(gated({})).ok).toBe(true);
    expect(validateFlowDefinition(gated({ forbid_requester: false })).ok).toBe(true);
  });

  it("rejects min_approvals greater than the named approver list", () => {
    const result = validateFlowDefinition(
      gated({ min_approvals: 3, approver_emails: ["a@b.co", "c@d.co"] }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("min_approvals");
  });

  it("rejects malformed emails, zero quorums, empty lists and unknown keys", () => {
    expect(validateFlowDefinition(gated({ approver_emails: ["not-an-email"] })).ok).toBe(false);
    expect(validateFlowDefinition(gated({ approver_emails: ["a b@c.co"] })).ok).toBe(false);
    expect(validateFlowDefinition(gated({ min_approvals: 0 })).ok).toBe(false);
    expect(validateFlowDefinition(gated({ approver_emails: [] })).ok).toBe(false);
    expect(validateFlowDefinition(gated({ minApprovals: 2 })).ok).toBe(false);
  });
});

describe("isApprovalGate", () => {
  it("discriminates gates from agent steps", () => {
    const ok = validateFlowDefinition(VALID);
    if (!ok.ok) throw new Error("fixture invalid");
    expect(ok.definition.steps.map(isApprovalGate)).toEqual([false, true, false]);
  });
});
