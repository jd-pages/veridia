import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { E2E_OWNERSHIP_SCOPE, enforcePostE2eProcessQuiescence, validatePostE2eReceipts, validateStoredQuiescenceReceipts } from "../../scripts/testing/post-e2e-process-quiescence.mjs";

function fixture() {
  const root = process.cwd();
  const head = "a".repeat(40), sourceFingerprint = "b".repeat(64);
  const receipt = { schemaVersion: 1, status: "PASSED", runId: "fixture-owned-run", group: "AUTOMATION", port: 41001,
    runDirectory: path.join(root, ".playwright/e2e-runs/fixture-owned-run"), head, sourceFingerprint,
    observedAt: "2026-10-01T00:00:02.000Z", ownershipScope: E2E_OWNERSHIP_SCOPE,
    observation: { status: "PASSED", sampleCount: 2, intervalMs: 1000, maxGapMs: 1012, coverage: "SAMPLED_NOT_EXHAUSTIVE" },
    logicalIdleStatus: "PASSED", capturedBeforePhysicalTeardown: true, finalOwnedProcessCount: 0, portCount: 0,
    unknownResidualCount: 0, profilesRemoved: true, nextEnvRestored: true, typeCleanupPass: true, elapsedMs: 100, deadlineMs: 3000,
    allCapturedIdentities: [{ pid: 100, parentPid: 99, name: "node.exe", createdAt: "2026-10-01T00:00:00.0000000Z" }],
    retiredProcessTrees: [{ rootPid: 100, retiredAt: "2026-10-01T00:00:02.000Z", ownedProcessCount: 0,
      identities: [{ pid: 100, parentPid: 99, name: "node.exe", createdAt: "2026-10-01T00:00:00.0000000Z" }] }] };
  return { root, head, sourceFingerprint, startedAt: "2026-10-01T00:00:01.000Z", now: "2026-10-01T00:00:03.000Z", groups: ["AUTOMATION"], receipts: [receipt] };
}

describe("POST_E2E_PROCESS_QUIESCENCE receipt binding", () => {
  it("validates exact same-run receipts without inventing a fresh native fence", () => {
    expect(validatePostE2eReceipts(fixture())).toMatchObject({
      status: "RECEIPTS_VALIDATED_REQUIRES_FRESH_NATIVE_FENCE", coverage: "SAMPLED_NOT_EXHAUSTIVE", ports: [41001] });
  });
  it.each(["head", "sourceFingerprint", "group"] as const)("rejects stale or foreign %s", key => {
    const input = fixture(); input.receipts[0][key] = "foreign";
    expect(() => validatePostE2eReceipts(input)).toThrow("IDENTITY_OR_WINDOW_MISMATCH");
  });
  it.each(["2026-10-01T00:00:00.000Z", "2026-10-01T00:00:04.000Z"])("rejects out-of-window receipt %s", observedAt => {
    const input = fixture(); input.receipts[0].observedAt = observedAt;
    expect(() => validatePostE2eReceipts(input)).toThrow("IDENTITY_OR_WINDOW_MISMATCH");
  });
  it("rejects paths outside exact isolated run storage", () => {
    const input = fixture(); input.receipts[0].runDirectory = path.join(input.root, "fixture-owned-run");
    expect(() => validatePostE2eReceipts(input)).toThrow("IDENTITY_OR_WINDOW_MISMATCH");
  });
  it.each(["finalOwnedProcessCount", "portCount", "unknownResidualCount"] as const)("rejects live %s", key => {
    const input = fixture(); input.receipts[0][key] = 1;
    expect(() => validatePostE2eReceipts(input)).toThrow("CONDITION_FAILED_OR_UNMEASURED");
  });
  it.each(["profilesRemoved", "nextEnvRestored", "typeCleanupPass", "capturedBeforePhysicalTeardown"] as const)("rejects missing or failed %s", key => {
    const input = fixture(); input.receipts[0][key] = false;
    expect(() => validatePostE2eReceipts(input)).toThrow("CONDITION_FAILED_OR_UNMEASURED");
  });
  it("rejects an exhaustive claim made by a sampled observer", () => {
    const input = fixture(); input.receipts[0].observation.coverage = "EXHAUSTIVE";
    expect(() => validatePostE2eReceipts(input)).toThrow("CONDITION_FAILED_OR_UNMEASURED");
  });
  it("rejects absent observation, ownership history, or imprecise birth", () => {
    const input = fixture(); input.receipts[0].observation.sampleCount = 0;
    expect(() => validatePostE2eReceipts(input)).toThrow("CONDITION_FAILED_OR_UNMEASURED");
    const missing = fixture(); missing.receipts[0].allCapturedIdentities = [];
    expect(() => validatePostE2eReceipts(missing)).toThrow("OWNERSHIP_HISTORY_UNAVAILABLE");
    const invalid = fixture(); invalid.receipts[0].allCapturedIdentities[0].createdAt = "2026-10-01T00:00:00.000Z";
    expect(() => validatePostE2eReceipts(invalid)).toThrow("NATIVE_BIRTH_IDENTITY_INVALID");
  });
  it("rejects incomplete and duplicate group receipts", () => {
    expect(() => validatePostE2eReceipts({ ...fixture(), receipts: [] })).toThrow("CONTEXT_UNAVAILABLE");
    const input = fixture(); input.groups = ["AUTOMATION", "DATA_RULES"]; input.receipts.push(input.receipts[0]);
    expect(() => validatePostE2eReceipts(input)).toThrow("IDENTITY_OR_WINDOW_MISMATCH");
  });
  it("rejects a receipt whose measurement exceeded its actual budget", () => {
    const input = fixture(); input.receipts[0].elapsedMs = input.receipts[0].deadlineMs + 1;
    expect(() => validatePostE2eReceipts(input)).toThrow("CONDITION_FAILED_OR_UNMEASURED");
  });
  it("rejects retired trees not bound to captured native identities", () => {
    const input = fixture(); input.receipts[0].retiredProcessTrees[0].identities[0].createdAt = "2026-10-01T00:00:00.0000001Z";
    expect(() => validatePostE2eReceipts(input)).toThrow("RETIRED_TREE_UNBOUND");
  });
  it("binds the stdout receipt to the same completed regular run.json", () => {
    const input = fixture();
    input.root = path.join(process.cwd(), ".playwright/post-e2e-receipt-tests", randomUUID());
    const receipt = input.receipts[0];
    receipt.runDirectory = path.join(input.root, ".playwright/e2e-runs", receipt.runId);
    fs.mkdirSync(receipt.runDirectory, { recursive: true });
    const file = path.join(receipt.runDirectory, "run.json");
    const metadata = { runId: receipt.runId, isolationGroup: receipt.group, cleaned: true, cleanupReason: "completed", postE2eQuiescence: receipt };
    fs.writeFileSync(file, JSON.stringify(metadata), { flag: "wx" });
    expect(validateStoredQuiescenceReceipts(input).status).toBe("RECEIPTS_VALIDATED_REQUIRES_FRESH_NATIVE_FENCE");
    fs.writeFileSync(file, JSON.stringify({ ...metadata, cleaned: false }));
    expect(() => validateStoredQuiescenceReceipts(input)).toThrow("STORED_RECEIPT_MISMATCH");
  });
});

describe("POST_E2E_PROCESS_QUIESCENCE fresh native fence", () => {
  const wrapper = { pid: process.pid, parentPid: 99, name: "node.exe", createdAt: "2026-10-01T00:00:00.0000000Z" };
  function adapters() {
    return { platform: "win32", capture: () => ({ processes: [wrapper], ports: [] }),
      scoped: () => ({ wrapperIdentityVerified: true, ownedProcesses: [], unknownProcesses: [] }), exists: () => false,
      readIdentity: () => ({ head: "a".repeat(40), sourceFingerprint: "b".repeat(64) }) };
  }
  it("reobserves actual ports, identities and profiles instead of accepting a receipt alone", async () => {
    const ports: number[] = [], profiles: string[] = [];
    const hooks = adapters();
    hooks.capture = (port?: number) => { ports.push(port!); return { processes: [wrapper], ports: [] }; };
    hooks.exists = (profile?: string) => { profiles.push(profile!); return false; };
    expect(await enforcePostE2eProcessQuiescence(fixture(), hooks)).toMatchObject({ status: "PASSED", portsChecked: [3100, 41001], capturedIdentityCount: 1 });
    expect(ports).toEqual([3100, 41001]); expect(profiles).toHaveLength(2);
  });
  it("fails unknown residuals without terminating or adopting them", async () => {
    const hooks = { ...adapters(), scoped: () => ({ wrapperIdentityVerified: true, ownedProcesses: [], unknownProcesses: [wrapper] }) };
    await expect(enforcePostE2eProcessQuiescence(fixture(), hooks)).rejects.toThrow("UNKNOWN_PROJECT_OR_PROFILE_RESIDUAL");
  });
  it("does not treat a classifier's historical reference without affinity as a project residual", async () => {
    const hooks = { ...adapters(), scoped: () => ({ wrapperIdentityVerified: true, ownedProcesses: [], unknownProcesses: [],
      historicalParentReferences: [{ pid: 9000, parentPid: 100, name: "ExternalSecurityAgent.exe",
        createdAt: "2026-10-01T00:00:01.5000000Z", classification: "HISTORICAL_PARENT_REFERENCE_WITHOUT_PROJECT_AFFINITY",
        ownershipGranted: false, terminationAuthorized: false }] }) };
    expect(await enforcePostE2eProcessQuiescence(fixture(), hooks)).toMatchObject({ status: "PASSED", unknownProcessCount: 0 });
  });
  it.each(["PROJECT_OR_RUN_PROFILE_MATCH", "RUN_PORT_LISTENER", "CURRENT_CAPTURED_ANCESTRY_MATCH"])(
    "the same external name remains blocking with actual %s affinity", async scopeReason => {
      const hooks = { ...adapters(), scoped: () => ({ wrapperIdentityVerified: true, ownedProcesses: [],
        unknownProcesses: [{ ...wrapper, pid: 9000, name: "ExternalSecurityAgent.exe", scopeReason }] }) };
      await expect(enforcePostE2eProcessQuiescence(fixture(), hooks)).rejects.toThrow("UNKNOWN_PROJECT_OR_PROFILE_RESIDUAL");
    });
  it("fails if a cleaned profile reappears", async () => {
    await expect(enforcePostE2eProcessQuiescence(fixture(), { ...adapters(), exists: () => true })).rejects.toThrow("PROFILE_REAPPEARED");
  });
  it("does not forge native PASS on other platforms", async () => {
    expect(await enforcePostE2eProcessQuiescence(fixture(), { platform: "linux" })).toMatchObject({ status: "NOT_APPLICABLE", ownedProcessCount: null });
  });
  it("requires the current verifier wrapper's measured birth", async () => {
    await expect(enforcePostE2eProcessQuiescence(fixture(), { ...adapters(), capture: () => ({ processes: [], ports: [] }) })).rejects.toThrow("CURRENT_WRAPPER_UNAVAILABLE");
  });
  it("fails incomplete measurements and deadline exhaustion", async () => {
    await expect(enforcePostE2eProcessQuiescence(fixture(), { ...adapters(), scoped: () => ({}) })).rejects.toThrow("SCOPED_SNAPSHOT_UNAVAILABLE");
    let elapsed = 0;
    await expect(enforcePostE2eProcessQuiescence({ ...fixture(), deadlineMs: 10 }, { ...adapters(), now: () => elapsed++,
      capture: () => { elapsed = 11; return { processes: [wrapper], ports: [] }; } })).rejects.toThrow("DEADLINE_EXHAUSTED");
  });
  it("cannot accept a stale receipt even if the native snapshot is empty", async () => {
    const input = fixture(); input.receipts[0].head = "c".repeat(40);
    await expect(enforcePostE2eProcessQuiescence(input, adapters())).rejects.toThrow("IDENTITY_OR_WINDOW_MISMATCH");
  });
  it("rejects a source edit occurring while the actual async fence is awaited", async () => {
    const input = fixture();
    let current = { head: input.head, sourceFingerprint: input.sourceFingerprint };
    let release!: (value: unknown) => void;
    const fence = new Promise(resolve => { release = resolve; });
    const pending = enforcePostE2eProcessQuiescence(input, { ...adapters(), readIdentity: () => current,
      wait: async () => fence });
    current = { ...current, sourceFingerprint: "c".repeat(64) };
    release({ observations: 1 });
    await expect(pending).rejects.toThrow("SOURCE_CHANGED_DURING_BUILD_HANDOFF_FENCE");
  });
});
