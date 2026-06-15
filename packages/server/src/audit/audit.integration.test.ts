import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_VERSION } from "@makerchecker/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDb, withTransaction, type TestDb } from "../../test/test-db.js";
import {
  exportBundle,
  manifestSigningString,
  verifyBundle,
  type AuditBundle,
} from "./export.js";
import { sha256Hex } from "@makerchecker/shared";
import { recomputeHash } from "./verify.js";
import { ensureInstanceKeys, signPayload, verifySignature } from "./keys.js";
import { verifyChain } from "./verify.js";
import { genesisPrevHash, recordEvent } from "./writer.js";

let db: TestDb;
let keyDir: string;

beforeAll(async () => {
  db = await createTestDb();
  keyDir = mkdtempSync(join(tmpdir(), "mc-keys-"));
}, 60_000);

afterAll(async () => {
  await db.drop();
  rmSync(keyDir, { recursive: true, force: true });
});

function record(eventType: string, payload: Record<string, unknown> = {}, runId?: string) {
  return withTransaction(db.pool, (client) =>
    recordEvent(client, {
      eventType,
      actor: { type: "system" },
      payload,
      ...(runId !== undefined ? { runId } : {}),
    }),
  );
}

describe("audit chain — happy path", () => {
  it("lazily writes a genesis event rooted in the instance id", async () => {
    const first = await record("test.first", { n: 1 });
    const { rows } = await db.pool.query(
      "SELECT event_type, prev_hash FROM audit_events ORDER BY seq ASC",
    );
    const instance = await db.pool.query<{ id: string }>("SELECT id FROM instance");
    expect(rows[0].event_type).toBe("audit.genesis");
    expect(rows[0].prev_hash).toBe(genesisPrevHash(instance.rows[0]!.id));
    expect(first.prev_hash).not.toBe(rows[0].prev_hash);
  });

  it("links each event to the previous head and verifies end-to-end", async () => {
    await record("test.second", { n: 2 });
    await record("test.third", { n: 3 });
    const result = await verifyChain(db.pool);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.count).toBeGreaterThanOrEqual(4); // genesis + 3
      expect(result.headHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("survives concurrent writers without forking the chain", async () => {
    const before = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM audit_events");
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => record("test.concurrent", { i })),
    );
    const after = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM audit_events");
    expect(Number(after.rows[0]!.n) - Number(before.rows[0]!.n)).toBe(25);

    const result = await verifyChain(db.pool);
    expect(result).toMatchObject({ ok: true });

    // No two events share a prev_hash (a fork would reuse one).
    const { rows } = await db.pool.query(
      "SELECT prev_hash, count(*) FROM audit_events GROUP BY prev_hash HAVING count(*) > 1",
    );
    expect(rows).toEqual([]);
  });

  it("rolls back the audit event together with the caller's transaction", async () => {
    const before = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM audit_events");
    await expect(
      withTransaction(db.pool, async (client) => {
        await recordEvent(client, {
          eventType: "test.doomed",
          actor: { type: "system" },
          payload: {},
        });
        throw new Error("business logic failed after audit write");
      }),
    ).rejects.toThrow("business logic failed");
    const after = await db.pool.query<{ n: string }>("SELECT count(*) AS n FROM audit_events");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
    expect((await verifyChain(db.pool)).ok).toBe(true);
  });
});

describe("audit chain — adversarial", () => {
  it("blocks UPDATE, DELETE, and TRUNCATE on audit_events", async () => {
    await expect(
      db.pool.query("UPDATE audit_events SET payload = '{}' WHERE seq = 1"),
    ).rejects.toThrow(/append-only/);
    await expect(db.pool.query("DELETE FROM audit_events WHERE seq = 1")).rejects.toThrow(
      /append-only/,
    );
    await expect(db.pool.query("TRUNCATE audit_events")).rejects.toThrow(/append-only/);
  });

  it("detects out-of-band payload tampering via hash recomputation", async () => {
    const victim = await record("test.victim", { amount: 100 });
    // Simulate an attacker with superuser access who disables the guard.
    await db.pool.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete");
    await db.pool.query(
      "UPDATE audit_events SET payload = jsonb_set(payload, '{amount}', '999') WHERE id = $1",
      [victim.id],
    );
    await db.pool.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete");

    const result = await verifyChain(db.pool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failedSeq).toBe(victim.seq);
      expect(result.reason).toContain("tampered");
    }

    // Restore for subsequent tests.
    await db.pool.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete");
    await db.pool.query(
      "UPDATE audit_events SET payload = jsonb_set(payload, '{amount}', '100') WHERE id = $1",
      [victim.id],
    );
    await db.pool.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete");
    expect((await verifyChain(db.pool)).ok).toBe(true);
  });

  it("detects a deleted row via broken linkage", async () => {
    const doomed = await record("test.to-delete", {});
    await record("test.after-deletion", {});
    await db.pool.query("ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update_delete");
    await db.pool.query("DELETE FROM audit_events WHERE id = $1", [doomed.id]);
    await db.pool.query("ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update_delete");

    const result = await verifyChain(db.pool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("broken linkage");
  });
});

describe("export bundles", () => {
  let bundleDb: TestDb;

  beforeAll(async () => {
    // Fresh database: the deletion test above intentionally broke db's chain.
    bundleDb = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await bundleDb.drop();
  });

  function recordIn(eventType: string, payload: Record<string, unknown>, runId?: string) {
    return withTransaction(bundleDb.pool, (client) =>
      recordEvent(client, {
        eventType,
        actor: { type: "system" },
        payload,
        ...(runId !== undefined ? { runId } : {}),
      }),
    );
  }

  it("full bundle round-trips and verifies offline", async () => {
    await recordIn("test.a", { n: 1 });
    await recordIn("test.b", { n: 2 });
    const keys = await ensureInstanceKeys(bundleDb.pool, keyDir);
    const bundle = await exportBundle(bundleDb.pool, keys, { schemaVersion: SCHEMA_VERSION });

    // Offline: serialize/deserialize, no DB involved in verification.
    const rehydrated = JSON.parse(JSON.stringify(bundle)) as AuditBundle;
    await expect(verifyBundle(rehydrated)).resolves.toEqual({
      ok: true,
      count: bundle.manifest.count,
    });
    expect(bundle.manifest.bundleKind).toBe("full");
    expect(bundle.manifest.count).toBeGreaterThanOrEqual(3); // genesis + 2
  });

  it("run-filtered bundle contains only that run and verifies", async () => {
    const runId = "33333333-3333-3333-3333-333333333333";
    await recordIn("run.step.completed", { step: 1 }, runId);
    await recordIn("run.step.completed", { step: 2 }, runId);
    await recordIn("other.event", {});
    const keys = await ensureInstanceKeys(bundleDb.pool, keyDir);
    const bundle = await exportBundle(bundleDb.pool, keys, {
      schemaVersion: SCHEMA_VERSION,
      runId,
    });
    expect(bundle.manifest.bundleKind).toBe("run");
    expect(bundle.events).toHaveLength(2);
    expect(bundle.events.every((e) => e.run_id === runId)).toBe(true);
    await expect(verifyBundle(bundle)).resolves.toEqual({ ok: true, count: 2 });
  });

  it("rejects a bundle whose event payload was tampered", async () => {
    const keys = await ensureInstanceKeys(bundleDb.pool, keyDir);
    const bundle = await exportBundle(bundleDb.pool, keys, { schemaVersion: SCHEMA_VERSION });
    const tampered = JSON.parse(JSON.stringify(bundle)) as AuditBundle;
    tampered.events[1]!.payload = { n: 999 };
    const result = await verifyBundle(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("tampered");
  });

  it("rejects a bundle with an event silently removed", async () => {
    const keys = await ensureInstanceKeys(bundleDb.pool, keyDir);
    const bundle = await exportBundle(bundleDb.pool, keys, { schemaVersion: SCHEMA_VERSION });
    const tampered = JSON.parse(JSON.stringify(bundle)) as AuditBundle;
    tampered.events.splice(1, 1);
    tampered.manifest.count -= 1;
    const result = await verifyBundle(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("signature");
  });

  it("rejects a bundle with an event removed even when the manifest is untouched", async () => {
    const keys = await ensureInstanceKeys(bundleDb.pool, keyDir);
    const bundle = await exportBundle(bundleDb.pool, keys, { schemaVersion: SCHEMA_VERSION });
    const tampered = JSON.parse(JSON.stringify(bundle)) as AuditBundle;
    tampered.events.splice(1, 1); // count left as-is: signature stays valid
    const result = await verifyBundle(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("count");
  });

  it("rejects a key holder's forged bundle whose chain linkage is broken", async () => {
    // Threat model: an insider WITH the signing key edits an event, recomputes
    // its hash and the digest, and re-signs the manifest. Linkage still betrays them.
    const keys = await ensureInstanceKeys(bundleDb.pool, keyDir);
    const bundle = await exportBundle(bundleDb.pool, keys, { schemaVersion: SCHEMA_VERSION });
    const forged = JSON.parse(JSON.stringify(bundle)) as AuditBundle;

    const victim = forged.events[2]!;
    victim.prev_hash = "f".repeat(64);
    victim.hash = recomputeHash(victim);

    const { signature: _drop, ...unsigned } = forged.manifest;
    unsigned.eventHashesDigest = sha256Hex(forged.events.map((e) => e.hash).join("\n"));
    unsigned.headHash = forged.events[forged.events.length - 1]!.hash;
    forged.manifest = {
      ...unsigned,
      signature: signPayload(keys.privateKey, manifestSigningString(unsigned)),
    };

    const result = await verifyBundle(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("linkage");
  });

  it("rejects a key holder's bundle whose manifest head hash is wrong", async () => {
    const keys = await ensureInstanceKeys(bundleDb.pool, keyDir);
    const bundle = await exportBundle(bundleDb.pool, keys, { schemaVersion: SCHEMA_VERSION });
    const forged = JSON.parse(JSON.stringify(bundle)) as AuditBundle;

    const { signature: _drop, ...unsigned } = forged.manifest;
    unsigned.headHash = "a".repeat(64);
    forged.manifest = {
      ...unsigned,
      signature: signPayload(keys.privateKey, manifestSigningString(unsigned)),
    };

    const result = await verifyBundle(forged);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("head hash");
  });

  it("rejects a bundle signed by a different key", async () => {
    const keys = await ensureInstanceKeys(bundleDb.pool, keyDir);
    const bundle = await exportBundle(bundleDb.pool, keys, { schemaVersion: SCHEMA_VERSION });
    const otherKeyDir = mkdtempSync(join(tmpdir(), "mc-keys2-"));
    // Mint the "other" key on a SEPARATE instance: instance.public_key_pem is
    // now write-once (0007_instance_immutable), so we cannot swap bundleDb's key.
    const otherDb = await createTestDb();
    try {
      const otherKeys = await ensureInstanceKeys(otherDb.pool, otherKeyDir);
      const forged = JSON.parse(JSON.stringify(bundle)) as AuditBundle;
      forged.manifest.publicKeyPem = otherKeys.publicKeyPem;
      const result = await verifyBundle(forged);
      expect(result.ok).toBe(false);
    } finally {
      await otherDb.drop();
      rmSync(otherKeyDir, { recursive: true, force: true });
    }
  });
});

describe("audit chain — misuse and bootstrap failures", () => {
  it("exports and verifies an empty bundle from a virgin database", async () => {
    const fresh = await createTestDb();
    try {
      const keys = await ensureInstanceKeys(fresh.pool, keyDir);
      const bundle = await exportBundle(fresh.pool, keys, { schemaVersion: SCHEMA_VERSION });
      expect(bundle.manifest.count).toBe(0);
      expect(bundle.manifest.headHash).toBeNull();
      await expect(verifyBundle(bundle)).resolves.toEqual({ ok: true, count: 0 });
    } finally {
      await fresh.drop();
    }
  });

  it("verifyChain refuses to run without an instance row", async () => {
    const fresh = await createTestDb();
    try {
      // The instance row is immutable (0007); forcibly remove it to simulate the
      // missing-row error path, as the audit-tamper tests disable their trigger.
      await fresh.pool.query("ALTER TABLE instance DISABLE TRIGGER instance_immutable_guard");
      await fresh.pool.query("DELETE FROM instance");
      await expect(verifyChain(fresh.pool)).rejects.toThrow(/instance row missing/);
    } finally {
      await fresh.drop();
    }
  });

  it("verifyChain rejects a chain whose first event is not genesis", async () => {
    const fresh = await createTestDb();
    try {
      const instance = await fresh.pool.query<{ id: string }>("SELECT id FROM instance");
      const instanceId = instance.rows[0]!.id;
      // Bypass the writer: insert a correctly-hashed but non-genesis first event.
      const { randomUUID } = await import("node:crypto");
      const { hashAuditEvent } = await import("@makerchecker/shared");
      const id = randomUUID();
      const occurredAt = new Date().toISOString();
      const prevHash = genesisPrevHash(instanceId);
      const hash = hashAuditEvent({
        id,
        occurredAt,
        actor: { type: "system" },
        eventType: "evil.first",
        entityType: null,
        entityId: null,
        runId: null,
        payload: {},
        prevHash,
      });
      await fresh.pool.query(
        `INSERT INTO audit_events (id, occurred_at, actor, event_type, payload, prev_hash, hash)
         VALUES ($1, $2, '{"type":"system"}', 'evil.first', '{}', $3, $4)`,
        [id, occurredAt, prevHash, hash],
      );
      const result = await verifyChain(fresh.pool);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("genesis");
    } finally {
      await fresh.drop();
    }
  });

  it("recordEvent refuses to run without an instance row", async () => {
    const fresh = await createTestDb();
    try {
      await fresh.pool.query("ALTER TABLE instance DISABLE TRIGGER instance_immutable_guard");
      await fresh.pool.query("DELETE FROM instance");
      await expect(
        withTransaction(fresh.pool, (client) =>
          recordEvent(client, { eventType: "test.x", actor: { type: "system" }, payload: {} }),
        ),
      ).rejects.toThrow(/instance row missing/);
    } finally {
      await fresh.drop();
    }
  });
});

describe("instance keys", () => {
  it("persists the keypair and republishes the public key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-keys3-"));
    try {
      const first = await ensureInstanceKeys(db.pool, dir);
      const second = await ensureInstanceKeys(db.pool, dir);
      expect(second.publicKeyPem).toBe(first.publicKeyPem);
      const { rows } = await db.pool.query<{ public_key_pem: string }>(
        "SELECT public_key_pem FROM instance",
      );
      expect(rows[0]!.public_key_pem).toBe(first.publicKeyPem);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("signs and verifies; rejects forged signatures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-keys4-"));
    // Fresh instance: the shared db's key is already published and now write-once
    // (0007), so mint this test's keypair on its own instance.
    const fresh = await createTestDb();
    try {
      const keys = await ensureInstanceKeys(fresh.pool, dir);
      const sig = signPayload(keys.privateKey, "attest this");
      expect(verifySignature(keys.publicKeyPem, "attest this", sig)).toBe(true);
      expect(verifySignature(keys.publicKeyPem, "attest THAT", sig)).toBe(false);
    } finally {
      await fresh.drop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
