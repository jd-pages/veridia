import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { request } from "playwright";
import ts from "typescript";
import {
  captureWindowsRuntime,
  captureWindowsScopedResiduals,
  closeWithinDeadline,
  evaluateGenerationIdleSnapshot,
  extendOwnedProcessIdentities,
  matchingOwnedProcesses,
  normalizeUniqueFormalCaseEvidence,
  orderOwnedProcessesLeafFirst,
  parseRepeatEach,
  planWindowsTreeTermination,
  redactE2eDiagnosticText,
  redactE2eDiagnosticValue,
  selectOwnedProcessTree,
  selectNewOwnedBrowserRoot,
  startRuntimeObservation,
  summarizeRepeatedExecutions,
  terminateWindowsOwnedProcesses,
  validateInitialOwnedRoot,
  waitForOwnedProcessQuiescence,
} from "../../scripts/testing/e2e-server-infrastructure.mjs";
import { readPlaywrightCaseEvidence, summarizePlaywrightCaseEvidence } from "../../scripts/testing/protected-evidence.mjs";
import { enforcePostE2eProcessQuiescence } from "../../scripts/testing/post-e2e-process-quiescence.mjs";

const processRow = (pid: number, parentPid: number, createdAt = "2026-09-30T12:00:00.1234560Z") => ({
  pid, parentPid, createdAt, name: "node.exe",
});

const fixtureFileTime = (birth: string) => (BigInt(Date.parse(birth)) * 10_000n + 116444736000000000n + BigInt(birth.slice(23, 27))).toString();
function scopedCollectorFixture(wrapper = processRow(900, 1)) {
  const collector = { ...processRow(888, wrapper.pid, "2026-10-01T00:00:00.0000000Z"), name: "powershell.exe",
    nativeCreationFileTime: fixtureFileTime("2026-10-01T00:00:00.0000000Z"), callerIdentity: wrapper,
    callerNativeCreationFileTime: fixtureFileTime(wrapper.createdAt), identityVerified: true, directCallerVerified: true,
    queryStartedAt: "2026-10-01T00:00:01.0000000Z", queryEndedAt: "2026-10-01T00:00:03.0000000Z",
    queryStartedFileTime: fixtureFileTime("2026-10-01T00:00:01.0000000Z"), queryEndedFileTime: fixtureFileTime("2026-10-01T00:00:03.0000000Z"),
    birthPrecision: "CIM_MICROSECOND_MATCH_NATIVE_FILETIME_FLOOR10", ownershipGranted: false, terminationAuthorized: false };
  const row = { ...processRow(777, collector.pid, "2026-10-01T00:00:02.0000000Z"), name: "conhost.exe",
    scopeReason: "DIAGNOSTIC_COLLECTOR_DIRECT_CHILD_CANDIDATE" };
  const candidate = { pid: row.pid, parentPid: row.parentPid, name: row.name, createdAt: row.createdAt,
    nativeCreationFileTime: fixtureFileTime(row.createdAt) as string | null, nativeBirthVerified: true, scopeKnownNonProjectProfile: true };
  return { wrapper, row, candidate, snapshot: { ownedProcesses: [] as typeof row[], unknownProcesses: [row],
    opaqueUnscopedCandidates: [] as typeof row[], opaqueUnscopedCandidateCount: 0, wrapperIdentityVerified: true,
    scopeLimitations: ["SAMPLED_NOT_EXHAUSTIVE"], scope: "NAMED_PROJECT_OR_RUN_PROFILE_OR_EXACT_CAPTURED_BIRTH_OR_UNVERIFIED_HISTORICAL_PARENT",
    diagnosticCollector: collector, diagnosticCollectorCandidates: [candidate] } };
}

function captureCollectorFixture(fixture: ReturnType<typeof scopedCollectorFixture>, identities = [] as ReturnType<typeof processRow>[]) {
  const execute = vi.fn().mockReturnValue({ status: 0, stdout: JSON.stringify(fixture.snapshot) });
  return { result: captureWindowsScopedResiduals({ projectRoot: path.resolve("."), profilePaths: [], identities,
    wrapperIdentity: fixture.wrapper }, execute), execute };
}

function historicalParentEvidenceFixture(count = 1, currentParentRows: { pid: number; parentPid: number; name: string; createdAt: string | null }[] =
  [processRow(37380, 1, "2026-10-01T00:00:01.0000000Z")]) {
  const fixture = scopedCollectorFixture();
  const parent = { ...processRow(37380, 1, "2026-10-01T00:00:01.0000000Z"),
    nativeBirthStamp: fixtureFileTime("2026-10-01T00:00:01.0000000Z") };
  const unknown = Array.from({ length: count }, (_, index) => ({ ...processRow(26796 + index, parent.pid, "2026-10-01T00:00:02.0000000Z"),
    name: "biz_helper.exe", scopeReason: "UNVERIFIED_HISTORICAL_PARENT_CANDIDATE" }));
  const historicalParentObservations = { schemaVersion: 1, scope: "SAME_CIM_SNAPSHOT_HISTORICAL_PARENT_OBSERVATION_ONLY",
    candidateLimit: 16, candidateTotal: count, candidateTruncated: count > 16,
    records: unknown.slice(0, 16).map(row => ({ candidate: { pid: row.pid, parentPid: row.parentPid, name: row.name, createdAt: row.createdAt },
      currentParentRowCount: currentParentRows.length, currentParentRows: currentParentRows.slice(0, 4), currentParentRowsTruncated: currentParentRows.length > 4,
      parentObservation: currentParentRows.length === 0 ? "ABSENT_IN_THIS_SNAPSHOT" : currentParentRows.length === 1 ? "ONE_ROW_IN_THIS_SNAPSHOT" : "MULTIPLE_ROWS_IN_THIS_SNAPSHOT" })),
    queryStartedAt: fixture.snapshot.diagnosticCollector.queryStartedAt, queryEndedAt: fixture.snapshot.diagnosticCollector.queryEndedAt,
    ownershipGranted: false, terminationAuthorized: false };
  const snapshot = { ...fixture.snapshot, unknownProcesses: unknown, diagnosticCollectorCandidates: [], historicalParentObservations };
  const capture = (identities = [parent]) => {
    const execute = vi.fn().mockReturnValue({ status: 0, stdout: JSON.stringify(snapshot) });
    return { execute, result: captureWindowsScopedResiduals({ projectRoot: path.resolve("."), profilePaths: [], identities,
      wrapperIdentity: fixture.wrapper }, execute) };
  };
  return { snapshot, unknown, parent, capture };
}

async function assertUnsupportedNativeMeasurement() {
  const capture = vi.fn(() => { throw new Error("Native capture must not execute on unsupported platform"); });
  const scoped = vi.fn(() => { throw new Error("Native scope must not execute on unsupported platform"); });
  const result = await enforcePostE2eProcessQuiescence({} as never, { platform: process.platform, capture, scoped });
  expect(result).toMatchObject({ status: "NOT_APPLICABLE", reason: "WINDOWS_NATIVE_FENCE_UNAVAILABLE",
    ownedProcessCount: null, portCount: null, unknownProcessCount: null });
  expect(result.status).not.toBe("PASSED");
  expect(capture).not.toHaveBeenCalled();
  expect(scoped).not.toHaveBeenCalled();
}

function idleFixture() {
  const manager = { managerAvailable: true, contextPresent: false, browserConnected: false,
    contextOwnerGeneration: null as number | null, lifecycleGeneration: 0, contextOwnershipKind: "NONE" };
  return {
    runtime: { effectiveRunnerCount: 0, activeExtractionCount: 0, pendingCleanupBarrierCount: 0,
      pendingLifecycleOperationCount: 0, physicalCloseState: null as string | null, physicalCloseFencePresent: false,
      prismaTransactionDiagnostics: { measurement: "AVAILABLE", coverageScope: "APP_LIB_SINGLETON_EXPLICIT_TRANSACTIONS",
        singletonRegistered: true, wrapperIntact: true, pendingTransactionCount: 0, observedTransactionCount: 2,
        settledTransactionCount: 2, observedBatchTransactionCount: 1, observedInteractiveTransactionCount: 1, observedOtherTransactionCount: 0 },
      activeBrowserOwnerGenerations: [] as number[], platformBrowserManagers: { XIAOHONGSHU: { ...manager }, DOUYIN: { ...manager } } },
    sessions: { XIAOHONGSHU: { auditLock: null }, DOUYIN: { auditLock: null } },
    health: { ok: true, service: "VERIDIA", version: "1.1.41" },
  };
}

interface FixtureReady { event: "ready"; pid: number; port: number; }
interface FixtureSnapshot { event: "snapshot"; pid: number; postCount: number; events: { event?: string }[]; }
type FixtureMessage = FixtureReady | FixtureSnapshot;
function childMessage(child: ChildProcess, event: "ready"): Promise<FixtureReady>;
function childMessage(child: ChildProcess, event: "snapshot"): Promise<FixtureSnapshot>;
function childMessage(child: ChildProcess, event: string): Promise<FixtureMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Fixture ${event} deadline`)), 1_000);
    const onMessage = (message: unknown) => {
      if (message && typeof message === "object" && "event" in message && message.event === event) {
        finish(undefined, message as FixtureMessage);
      }
    };
    const onExit = () => finish(new Error("Owned fixture child exited unexpectedly"));
    function finish(error?: Error, message?: FixtureMessage) {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error); else resolve(message!);
    }
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function wrapperFunctionSource(name: string) {
  const source = fs.readFileSync(path.resolve("scripts/testing/run-e2e.mjs"), "utf8");
  const parsed = ts.createSourceFile("run-e2e.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!declaration || !ts.isFunctionDeclaration(declaration)) throw new Error(`Missing actual wrapper function ${name}`);
  return declaration.getText(parsed);
}

function cleanupFunctionLab(failure?: "profile" | "types" | "restore" | "unknown" | "source" | "observation" | "observer-stop" | "observer-unjoined" | "observer-missing-proof" | "observer-late-success" | "retained-close", stoppedObservation = false, logicalFailure = false) {
  const events: string[] = [];
  const output: string[] = [];
  const metadata: Record<string, unknown>[] = [];
  const identity = processRow(20, 1);
  let snapshotCount = 0;
  const deps = {
    process: { platform: "win32", stdout: { write: (value: string) => output.push(value) } },
    fs: { rmSync: (target: string) => { events.push(`remove:${path.basename(target)}`); if (failure === "profile" && target.endsWith("xhs-profile")) throw new Error("profile remains locked"); },
      chmodSync: () => {}, existsSync: () => false },
    path, root: path.resolve("."), runDirectory: path.resolve(".playwright/unit-no-disk-run"), runPort: 3100,
    physicalCleanupDeadlineMs: 45_000, runId: "unit-no-disk-run", isolationGroup: "UNIT", nextDistDir: ".playwright/next-e2e",
    wrapperIdentity: processRow(900, 1), runHead: "a".repeat(40), runSourceFingerprint: "b".repeat(64),
    nextEnvSnapshot: { exists: true, contents: "original" },
    isolatedBaseURL: "http://127.0.0.1:3100", teardownNonce: "private-unit-nonce", warmupStorageState: { cookies: [], origins: [] }, closeWithinDeadline,
    request: { newContext: async () => ({
      post: async (_url: string, options: { maxRetries: number; data: { action: string; teardownNonce: string } }) => {
        events.push("retained-context-close");
        expect(options).toMatchObject({ maxRetries: 0, data: { action: "CLOSE_BROWSERS_FOR_E2E_TEARDOWN", teardownNonce: "private-unit-nonce" } });
        return { ok: () => failure !== "retained-close", json: async () => ({ data: { closed: true } }) };
      }, dispose: async () => { events.push("teardown-api-dispose"); },
    }) },
    retiredProcessTrees: [{ rootPid: 20, identities: [identity], ownedProcessCount: 0 }],
    generationIdleCheck: { status: logicalFailure ? "FAILED" : "PASSED", capturedBeforePhysicalTeardown: true },
    processObserver: { snapshot: () => ({ status: failure === "observer-late-success" ? "PASSED" : "FAILED",
      workerJoined: failure === "observer-late-success" ? ++snapshotCount > 1 : failure !== "observer-unjoined" && failure !== "observer-missing-proof" }),
      stop: async () => { if (failure === "observer-stop" || failure === "observer-unjoined" || failure === "observer-late-success") throw new Error("observer natural join deadline exhausted");
      return { status: failure === "observation" ? "FAILED" : "PASSED", workerJoined: failure === "observer-missing-proof" ? undefined : true,
        error: "observation unavailable", sampleCount: 3, intervalMs: 2_000, coverage: "SAMPLED_NOT_EXHAUSTIVE" }; } },
    serverProcess: { pid: 20 }, testProcess: { pid: 21 }, warmupProcess: undefined,
    captureOwnedRuntime: () => ({ processes: [], ports: [] }),
    captureWindowsRuntime: () => { events.push("native-fence"); return { processes: [], ports: [] }; },
    captureWindowsScopedResiduals: () => { events.push("residual-fence"); return { ownedProcesses: [], unknownProcesses: failure === "unknown" ? [processRow(901, 2)] : [] }; },
    allCapturedIdentities: () => [identity], waitForOwnedProcessQuiescence, matchingOwnedProcesses,
    closeWarmupBrowser: async () => { events.push("warmup-close"); }, stopOwnedProcess: async (child: { pid: number } | undefined) => { if (child) events.push(`owned-stop:${child.pid}`); },
    cleanupTestNextGeneratedTypes: () => { events.push("types-restore"); if (failure === "types") throw new Error("types cleanup failed"); return []; },
    restoreFile: () => { events.push("next-env-restore"); if (failure === "restore") throw new Error("next-env restore failed"); },
    sourceIdentity: () => ({ head: "a".repeat(40), sourceFingerprint: (failure === "source" ? "c" : "b").repeat(64) }),
    preserveFailureDiagnostics: () => {},
    writeMetadata: (value: Record<string, unknown>) => { metadata.push(value); events.push(value.cleaned === true ? "success-receipt" : "metadata"); },
    recordMetadataBestEffort: (value: Record<string, unknown>) => metadata.push(value),
  };
  // Run the actual wrapper cleanup/fence bodies with only explicitly stubbed
  // external dependencies. No top-level wrapper/API/DB/file operations execute.
  const execute = new Function("deps", `
    return (async () => {
    const {${Object.keys(deps).filter(key => key !== "processObserver").join(",")}}=deps;
    let processObserver=deps.processObserver; let processObservation; let runtimeBeforeCleanup; let runtimeAfterCleanup; let cleaned=false;
    ${wrapperFunctionSource("stopPeriodicRuntimeObservation")}
    ${wrapperFunctionSource("captureFinalPhysicalFence")}
    ${wrapperFunctionSource("performCleanup")}
    ${stoppedObservation ? 'await stopPeriodicRuntimeObservation("POST_TEST_PRE_LOGICAL_PROBE");' : ""}
    return performCleanup(${logicalFailure ? '"failed"' : '"completed"'});
    })();
  `);
  return { run: () => execute(deps) as Promise<void>, events, output, metadata };
}

function logicalProbeLab(newContext: () => Promise<unknown>, evaluate = () => ({ idle: true })) {
  const execute = new Function("deps", `
    const { request, warmupStorageState, closeWithinDeadline, evaluateGenerationIdleSnapshot } = deps;
    ${wrapperFunctionSource("captureGroupEndLogicalIdle")}
    return captureGroupEndLogicalIdle("http://127.0.0.1:1");
  `);
  return () => execute({ request: { newContext }, warmupStorageState: { cookies: [], origins: [] },
    closeWithinDeadline, evaluateGenerationIdleSnapshot: evaluate }) as Promise<Record<string, unknown>>;
}

describe("E2E server infrastructure", () => {
  it("closes retained contexts through the authenticated isolated server before native termination, without dropping unknown fences", async () => {
    const lab = cleanupFunctionLab();
    await lab.run();
    expect(lab.events.indexOf("retained-context-close")).toBeLessThan(lab.events.indexOf("owned-stop:20"));
    expect(lab.events.filter(event => event === "residual-fence")).toHaveLength(2);
    expect(lab.metadata).toContainEqual(expect.objectContaining({ retainedBrowserContextClose: expect.objectContaining({ status: "PASSED", beforePhysicalTreeTermination: true }) }));
    const failed = cleanupFunctionLab("retained-close");
    await expect(failed.run()).rejects.toThrow("E2E cleanup");
    expect(failed.events).toEqual(expect.arrayContaining(["teardown-api-dispose", "owned-stop:20", "native-fence"]));
    expect(failed.output).toEqual([]);
    expect(failed.metadata).toContainEqual(expect.objectContaining({ cleaned: false }));
  });
  it("awaits the sampler natural join before the bounded logical probe while preserving later fresh physical captures", () => {
    const source = wrapperFunctionSource("main");
    const stop = source.indexOf('await stopPeriodicRuntimeObservation("POST_TEST_PRE_LOGICAL_PROBE")');
    const probe = source.indexOf("generationIdleCheck = await captureGroupEndLogicalIdle(baseURL)");
    expect(stop).toBeGreaterThan(0);
    expect(stop).toBeLessThan(probe);
    expect(source.indexOf('captureOwnedRuntime("after-tests")')).toBeGreaterThan(probe);
    const cleanup = wrapperFunctionSource("performCleanup");
    expect(cleanup).toContain('captureOwnedRuntime("before-cleanup")');
    expect(cleanup.match(/await captureFinalPhysicalFence\(/gu)).toHaveLength(2);
  });

  it("a sampler join failure preserves FAILED while still tearing down creator-owned processes", async () => {
    const lab = cleanupFunctionLab("observer-stop");
    await expect(lab.run()).rejects.toThrow();
    expect(lab.events).toEqual(expect.arrayContaining(["warmup-close", "owned-stop:20", "owned-stop:21", "native-fence", "residual-fence"]));
    expect(lab.output).toEqual([]);
    expect(lab.metadata).toContainEqual(expect.objectContaining({ cleaned: false,
      processObservation: expect.objectContaining({ status: "FAILED", workerExitVerified: true }) }));
  });

  it("an unjoined collector cannot authorize fresh final fences but still allows creator-owned safety teardown", async () => {
    const lab = cleanupFunctionLab("observer-unjoined");
    await expect(lab.run()).rejects.toThrow();
    expect(lab.events).toEqual(expect.arrayContaining(["warmup-close", "owned-stop:20", "owned-stop:21"]));
    expect(lab.events).not.toContain("native-fence");
    expect(lab.events).not.toContain("residual-fence");
    expect(lab.output).toEqual([]);
    expect(lab.metadata).toContainEqual(expect.objectContaining({ cleaned: false,
      processObservation: expect.objectContaining({ status: "FAILED", workerJoined: false, workerExitVerified: false }) }));
  });

  it("concurrent signal cleanup retains the observer and awaits the same pending natural join", async () => {
    let settle!: (value: unknown) => void;
    const joined = new Promise(resolve => { settle = resolve; });
    const observer = { stop: vi.fn(() => joined) };
    const execute = new Function("initialObserver", `
      let processObserver=initialObserver; let processObservation;
      ${wrapperFunctionSource("stopPeriodicRuntimeObservation")}
      return {stop:stopPeriodicRuntimeObservation, current:()=>processObserver, receipt:()=>processObservation};
    `);
    const lab = execute(observer);
    let firstDone = false, cleanupDone = false;
    const first = lab.stop("POST_TEST_PRE_LOGICAL_PROBE").then(() => { firstDone = true; });
    const cleanup = lab.stop("PHYSICAL_CLEANUP", () => 45_000).then(() => { cleanupDone = true; });
    await Promise.resolve();
    expect(lab.current()).toBe(observer);
    expect(lab.receipt()).toBeUndefined();
    expect(firstDone).toBe(false);
    expect(cleanupDone).toBe(false);
    settle({ status: "PASSED", coverage: "SAMPLED_NOT_EXHAUSTIVE", workerExitVerified: true });
    await Promise.all([first, cleanup]);
    expect(lab.current()).toBeUndefined();
    expect(lab.receipt()).toMatchObject({ status: "PASSED", stopBoundary: "POST_TEST_PRE_LOGICAL_PROBE" });
  });

  it("missing natural join proof cannot clear an observer or authorize fresh native fences", async () => {
    const lab = cleanupFunctionLab("observer-missing-proof");
    await expect(lab.run()).rejects.toThrow();
    expect(lab.events).toEqual(expect.arrayContaining(["warmup-close", "owned-stop:20", "owned-stop:21"]));
    expect(lab.events).not.toContain("native-fence");
    expect(lab.output).toEqual([]);
    expect(lab.metadata).toContainEqual(expect.objectContaining({ cleaned: false,
      processObservation: expect.objectContaining({ status: "FAILED", workerExitVerified: false }) }));
  });

  it("later natural exit proof permits safety fences without overwriting the original failed join", async () => {
    const lab = cleanupFunctionLab("observer-late-success");
    await expect(lab.run()).rejects.toThrow();
    expect(lab.events).toContain("native-fence");
    expect(lab.output).toEqual([]);
    expect(lab.metadata).toContainEqual(expect.objectContaining({ cleaned: false,
      processObservation: expect.objectContaining({ status: "FAILED", workerJoined: true, workerExitVerified: true,
        error: "observer natural join deadline exhausted" }) }));
  });

  it("stores sampler ownership before readiness and assigns only accepted API authentication snapshots", () => {
    const server = wrapperFunctionSource("startNextServer");
    expect(server).toContain("processObserver ??= startWindowsRuntimeObservation(");
    const main = wrapperFunctionSource("main");
    expect(main.indexOf("serverProcess = startNextServer(")).toBeLessThan(main.indexOf("await processObserver?.ready"));
    const warmup = wrapperFunctionSource("warmup");
    expect(warmup.indexOf("await captureWarmupApiAuthCookieSnapshot(context, baseURL)")).toBeGreaterThan(0);
    expect(warmup.indexOf("await captureWarmupApiAuthCookieSnapshot(context, baseURL)")).toBeLessThan(warmup.indexOf("warmupStorageState = snapshot.storageState"));
    expect(warmup).not.toContain("context.storageState()");
    expect(warmup).toContain("warmupAuthSnapshot: snapshot.measurement");
  });

  it("retains a stopped observer failure through mandatory physical cleanup rather than replacing it with NOT_RUN", async () => {
    const lab = cleanupFunctionLab("observation", true);
    await expect(lab.run()).rejects.toThrow();
    expect(lab.events).toEqual(expect.arrayContaining(["warmup-close", "owned-stop:20", "owned-stop:21", "native-fence"]));
    expect(lab.output).toEqual([]);
    expect(lab.metadata).toContainEqual(expect.objectContaining({ cleaned: false }));
  });

  it("logical probe failure cannot prevent physical teardown or turn its receipt into PASS", async () => {
    const lab = cleanupFunctionLab(undefined, true, true);
    await lab.run();
    expect(lab.events.filter(event => event === "native-fence")).toHaveLength(2);
    expect(lab.events).toContain("next-env-restore");
    expect(lab.output).toEqual([]);
    expect(lab.metadata).toContainEqual(expect.objectContaining({ cleaned: true,
      postE2eQuiescence: expect.objectContaining({ status: "FAILED", logicalIdleStatus: "FAILED",
        observation: expect.objectContaining({ status: "PASSED", stopBoundary: "POST_TEST_PRE_LOGICAL_PROBE" }) }) }));
  });

  it("uses the remaining shared3s budget with retry0 for real authenticated idle snapshots", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const get = vi.fn(async () => ({ ok: () => true, status: () => 200, json: async () => ({ success: true, data: {} }) }));
      const dispose = vi.fn(async () => {});
      const result = await logicalProbeLab(async () => { vi.setSystemTime(400); return { get, dispose }; })();
      expect(result).toMatchObject({ status: "PASSED", observations: 1, elapsedMs: 400, deadlineMs: 3_000,
        stageTimings: [{ stage: "CONTEXT_CREATE", elapsedMs: 400 }, { stage: "AUTHENTICATED_IDLE_SNAPSHOT", elapsedMs: 0 }] });
      expect(get).toHaveBeenCalledTimes(3);
      for (const call of get.mock.calls as unknown[][]) expect(call[1]).toEqual({ maxRetries: 0, timeout: 2_600 });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("rejects expired context creation without making a1ms GET and disposes the actual late context", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const get = vi.fn(), dispose = vi.fn(async () => {});
      const result = await logicalProbeLab(async () => { vi.setSystemTime(3_001); return { get, dispose }; })();
      expect(result).toMatchObject({ status: "FAILED", stage: "CONTEXT_CREATE", observations: 0, elapsedMs: 3_001, deadlineMs: 3_000 });
      expect(get).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("bounds a stalled context create and disposes its later resolution without issuing requests", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      let resolve!: (value: unknown) => void;
      const context = new Promise(value => { resolve = value; });
      const run = logicalProbeLab(() => context)();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(run).resolves.toMatchObject({ status: "FAILED", stage: "CONTEXT_CREATE", observations: 0, elapsedMs: 3_000 });
      const get = vi.fn(), dispose = vi.fn(async () => {});
      resolve({ get, dispose });
      await vi.advanceTimersByTimeAsync(0);
      expect(get).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("does not queue unobserved context creation when the initial shared budget check already expired", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(3_001);
    try {
      const newContext = vi.fn(async () => { throw new Error("must never queue this rejected context"); });
      const result = await logicalProbeLab(newContext)();
      expect(result).toMatchObject({ status: "FAILED", stage: "CONTEXT_CREATE", observations: 0, elapsedMs: 3_001 });
      expect(newContext).not.toHaveBeenCalled();
    } finally { now.mockRestore(); }
  });

  it("rejects late successful HTTP snapshots even when event-loop order delivers them before the deadline timer", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const dispose = vi.fn(async () => {}), evaluate = vi.fn(() => ({ idle: true }));
      const get = vi.fn(async () => ({ ok: () => true, status: () => 200,
        json: async () => { vi.setSystemTime(3_001); return { success: true, data: {} }; } }));
      const result = await logicalProbeLab(async () => ({ get, dispose }), evaluate)();
      expect(result).toMatchObject({ status: "FAILED", stage: "AUTHENTICATED_IDLE_SNAPSHOT", observations: 0, elapsedMs: 3_001 });
      expect(evaluate).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("rejects idletrue if evaluation itself exhausts the shared deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const get = vi.fn(async () => ({ ok: () => true, json: async () => ({ success: true, data: {} }) }));
      const result = await logicalProbeLab(async () => ({ get, dispose: async () => {} }),
        () => { vi.setSystemTime(3_001); return { idle: true }; })();
      expect(result).toMatchObject({ status: "FAILED", stage: "IDLE_EVALUATION", observations: 1, elapsedMs: 3_001 });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("keeps ten real repeat executions distinct without inventing NOT_RUN cases", () => {
    // Playwright JSON emits one distinct spec per repeat, without the native
    // repeat index field. Do not model all repeats as one spec.tests array.
    const report = { suites: [{ specs: Array.from({ length: 10 }, (_, index) => ({
      id: `native-spec-${index}`, file: "one.spec.ts", title: "critical",
      tests: [{ timeout: 150000, results: [{ status: "passed", duration: 12, retry: 0 }] }],
    })) }] };
    const executions = summarizeRepeatedExecutions(report, 10);
    expect(executions).toMatchObject({ total: 10, passed: 10, failed: 0, notRun: 0, retryCount: 0 });
    expect(executions.cases.map(item => item.reportExecutionOrdinal)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(executions.cases.every(item => item.repeatEachIndex === null && item.repeatIndexSource === "NOT_SERIALIZED")).toBe(true);
  });

  it("real JSON reporter shape retains two native spec IDs and actual timeouts while producing one unique formal case", () => {
    const fixture = path.resolve("tests/fixtures/playwright/repeat-each-two-passed.json");
    const nativeReport = JSON.parse(fs.readFileSync(fixture, "utf8"));
    const rawCases = readPlaywrightCaseEvidence(fixture);
    expect(rawCases).toHaveLength(2);
    const unique = normalizeUniqueFormalCaseEvidence(rawCases);
    expect(unique).toHaveLength(1);
    expect(summarizePlaywrightCaseEvidence(unique, 1)).toEqual({ total: 1, executed: 1, passed: 1, failed: 0, notRun: 0 });
    const executions = summarizeRepeatedExecutions(nativeReport, 2);
    expect(executions).toMatchObject({ total: 2, executed: 2, passed: 2, failed: 0, notRun: 0, retryCount: 0 });
    expect(executions.cases.map(item => item.reportSpecId)).toEqual(["fixture-distinct-spec-id-first", "fixture-distinct-spec-id-second"]);
    expect(executions.cases.map(item => item.reportExecutionOrdinal)).toEqual([1, 2]);
    for (const item of executions.cases) expect(item).toMatchObject({ timeoutMs: 150000, repeatEachIndex: null, repeatIndexSource: "NOT_SERIALIZED" });
    expect(executions.cases[1].attempts[0]).toEqual({ status: "passed", durationMs: 12, retry: 0, workerIndex: 1, parallelIndex: 0, startTime: "2026-09-30T13:22:02.328Z" });
  });

  it("unique formal cases conservatively preserve a failed or unstarted repeat, independent of duplicate order", () => {
    const base = { file: "tests/e2e/one.spec.ts", title: "critical" };
    for (const duplicate of ["FAILED", "NOT_RUN"] as const) {
      const cases = [{ ...base, status: duplicate }, { ...base, status: "PASSED" as const }];
      expect(normalizeUniqueFormalCaseEvidence(cases)).toEqual([{ ...base, status: duplicate }]);
      expect(normalizeUniqueFormalCaseEvidence([...cases].reverse())).toEqual([{ ...base, status: duplicate }]);
    }
    expect(normalizeUniqueFormalCaseEvidence([{ ...base, status: "NOT_RUN" }, { ...base, status: "FAILED" }])).toEqual([{ ...base, status: "FAILED" }]);
  });

  it("preserves only a real explicit repeat index and marks unavailable timeout/index fields unknown", () => {
    const report = { suites: [{ specs: [{ id: "native-id", title: "critical", tests: [
      { repeatEachIndex: 3, timeout: 5000, results: [{ status: "passed" }] },
      { repeatEachIndex: "0", results: [{ status: "passed" }] },
    ] }] }] };
    const executions = summarizeRepeatedExecutions(report, 2);
    expect(executions.cases[0]).toMatchObject({ repeatEachIndex: 3, repeatIndexSource: "REPORT_FIELD", timeoutMs: 5000 });
    expect(executions.cases[1]).toMatchObject({ repeatEachIndex: null, repeatIndexSource: "INVALID_REPORT_FIELD", timeoutMs: null });
  });

  it("a failed repeat cannot disappear behind a later successful repeat", () => {
    const report = { suites: [{ specs: [
      { id: "failed-repeat", title: "critical", tests: [{ results: [{ status: "failed", duration: 20 }] }] },
      { id: "passed-repeat", title: "critical", tests: [{ results: [{ status: "passed", duration: 12 }] }] },
    ] }] };
    expect(summarizeRepeatedExecutions(report, 2)).toMatchObject({ total: 2, passed: 1, failed: 1, notRun: 0 });
  });

  it("reports an unstarted repeat and detects a replay even if its last attempt passed", () => {
    const report = { suites: [{ specs: [
      { id: "unstarted-repeat", title: "critical", tests: [{ results: [{ status: "skipped" }] }] },
      { id: "retried-repeat", title: "critical", tests: [{ results: [{ status: "failed", retry: 0 }, { status: "passed", retry: 1 }] }] },
    ] }] };
    expect(summarizeRepeatedExecutions(report, 2)).toMatchObject({ total: 2, passed: 0, failed: 1, notRun: 1, retryCount: 1 });
  });

  it("accepts only one safe positive repeat count", () => {
    expect(parseRepeatEach([])).toBe(1);
    expect(parseRepeatEach(["--repeat-each=20"])).toBe(20);
    for (const invalid of ["0", "-1", "1.2", "", "NaN", "9007199254740992"]) {
      expect(() => parseRepeatEach([`--repeat-each=${invalid}`])).toThrow();
    }
    expect(() => parseRepeatEach(["--repeat-each=2", "--repeat-each=3"])).toThrow();
  });

  it("selects only descendants of this run without touching a different Node process", () => {
    const processes = [processRow(20, 1), processRow(21, 20), processRow(22, 21), processRow(40, 1), processRow(41, 40)];
    expect(selectOwnedProcessTree(processes, 20).map(item => item.pid)).toEqual([20, 21, 22]);
  });

  it("cannot adopt an older orphan when its historical parent PID belongs to a freshly born authorized root", () => {
    const root = processRow(20, 1, "2026-10-01T00:00:02.0000000Z");
    const orphan = processRow(21, 20, "2026-10-01T00:00:01.0000000Z");
    expect(selectOwnedProcessTree([root, orphan], 20)).toEqual([root]);
    // Keep full precision: Date.parse alone would collapse these births.
    const earlier = processRow(22, 20, "2026-10-01T00:00:02.0000001Z");
    const laterRoot = { ...root, createdAt: "2026-10-01T00:00:02.0000002Z" };
    expect(selectOwnedProcessTree([laterRoot, earlier], 20)).toEqual([laterRoot]);
  });

  it("grows only below currently live birth-matching parents; absent or reused parent PIDs cannot grant orphan authority", () => {
    const root = processRow(20, 1);
    const child = processRow(21, 20);
    expect(extendOwnedProcessIdentities([child], [root])).toEqual([root]);
    const replacement = { ...root, createdAt: "2026-09-30T12:00:01.0000000Z" };
    expect(extendOwnedProcessIdentities([replacement, child], [root])).toEqual([root]);
    const grandchild = processRow(22, 21);
    expect(extendOwnedProcessIdentities([child, grandchild], [root, child])).toEqual([root, child, grandchild]);
    expect(() => extendOwnedProcessIdentities([root, { ...child, createdAt: "" }], [root])).toThrow("出生身份");
  });

  it("samples actual late descendants during execution and retains their identities after the root exits without claiming exhaustive coverage", async () => {
    vi.useFakeTimers();
    try {
      const root = processRow(20, 1);
      const child = processRow(21, 20);
      let current = [root];
      let captured = [root];
      const observer = startRuntimeObservation({ intervalMs: 10, capture: () => ({ processes: current, ports: [] }),
        record: runtime => { captured = extendOwnedProcessIdentities(runtime.processes, captured); } });
      current = [root, child];
      await vi.advanceTimersByTimeAsync(10);
      current = [child];
      await vi.advanceTimersByTimeAsync(10);
      expect(matchingOwnedProcesses(current, captured)).toEqual([child]);
      expect(observer.stop()).toMatchObject({ status: "PASSED", sampleCount: 3, intervalMs: 10, coverage: "SAMPLED_NOT_EXHAUSTIVE" });
      const capturedCount = captured.length;
      await vi.advanceTimersByTimeAsync(20);
      expect(captured).toHaveLength(capturedCount);
    } finally { vi.useRealTimers(); }
  });

  it("a failed execution-time native sample remains failed rather than turning into a later synthetic zero PASS", async () => {
    vi.useFakeTimers();
    try {
      const capture = vi.fn().mockImplementationOnce(() => { throw new Error("native identity unavailable"); }).mockReturnValue({ processes: [], ports: [] });
      const observer = startRuntimeObservation({ intervalMs: 10, capture, record: () => {} });
      await vi.advanceTimersByTimeAsync(10);
      expect(observer.stop()).toMatchObject({ status: "FAILED", sampleCount: 1, error: "native identity unavailable" });
    } finally { vi.useRealTimers(); }
  });

  it("waits on the whole captured-tree exit condition, not the direct-root exit or Kill return", async () => {
    const root = processRow(20, 1);
    const child = processRow(21, 20);
    let clock = 0;
    const capture = vi.fn().mockReturnValueOnce({ processes: [child], ports: [] }).mockReturnValue({ processes: [], ports: [] });
    const result = await waitForOwnedProcessQuiescence({ identities: [root, child], capture, deadlineMs: 10, intervalMs: 1,
      now: () => clock, sleep: async ms => { clock += ms; } });
    expect(result).toMatchObject({ status: "PASSED", observations: 2, ownedProcessCount: 0, elapsedMs: 1 });
    expect(capture.mock.calls.map(args => args[0])).toEqual([10, 9]);
  });

  it("cannot retire a still-live captured child or a listening run port at the condition deadline", async () => {
    const child = processRow(21, 20);
    for (const runtime of [{ processes: [child], ports: [] }, { processes: [], ports: [{ port: 3100, pid: 99, state: "LISTEN" }] }]) {
      let clock = 0;
      await expect(waitForOwnedProcessQuiescence({ identities: [child], capture: () => runtime, requirePortClosed: true,
        deadlineMs: 3, intervalMs: 1, now: () => clock, sleep: async ms => { clock += ms; } })).rejects.toThrow("未释放");
    }
  });

  it("missing measurements, an over-budget native sample, or a never-resolving probe cannot become process0", async () => {
    await expect(waitForOwnedProcessQuiescence({ identities: [], capture: () => ({}) as never, deadlineMs: 10 })).rejects.toThrow("测量缺失");
    let clock = 0;
    await expect(waitForOwnedProcessQuiescence({ identities: [], now: () => clock, deadlineMs: 3,
      capture: () => { clock = 4; return { processes: [], ports: [] }; } })).rejects.toThrow("未释放");
    await expect(waitForOwnedProcessQuiescence({ identities: [], capture: () => new Promise(() => {}), deadlineMs: 10 })).rejects.toThrow("观测超时");
  });

  it.each(["node.exe", "chrome-headless-shell.exe"])("measures unknown %s project/profile residuals without termination authority or commands", name => {
    const wrapper = processRow(900, 1);
    const unknown = { ...processRow(901, 2), name, scopeReason: "PROJECT_OR_RUN_PROFILE_MATCH" };
    const fixture = scopedCollectorFixture(wrapper);
    fixture.snapshot.unknownProcesses = [unknown];
    fixture.snapshot.diagnosticCollectorCandidates = [];
    const execute = vi.fn().mockReturnValue({ status: 0, stdout: JSON.stringify(fixture.snapshot) });
    const result = captureWindowsScopedResiduals({ projectRoot: path.resolve("."), profilePaths: [path.resolve(".playwright/run/xhs-profile")],
      identities: [], wrapperIdentity: wrapper, timeoutMs: 12 }, execute);
    expect(result.unknownProcesses).toEqual([unknown]);
    expect(result.ownedProcesses).toEqual([]);
    const [command, args, options] = execute.mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(args.join(" ")).toContain("$collectorHandle.Handle");
    expect(args.join(" ")).toContain("$wrapperHandle.Handle");
    expect(args.join(" ")).toContain("WRAPPER_BIRTH_MISMATCH");
    expect(args.join(" ")).not.toMatch(/\.Kill\(|taskkill|rawCommand|EnvironmentVariables/);
    expect(options).toMatchObject({ windowsHide: true, timeout: 12 });
    expect(JSON.parse(options.input).identities).toEqual([]);
    execute.mockReturnValue({ status: 0, stdout: '{"ownedProcesses":[],"unknownProcesses":[]}' });
    expect(() => captureWindowsScopedResiduals({ projectRoot: path.resolve("."), profilePaths: [], identities: [], wrapperIdentity: wrapper }, execute)).toThrow("测量不完整");
    execute.mockReturnValue({ status: 1, stderr: "WRAPPER_BIRTH_MISMATCH" });
    expect(() => captureWindowsScopedResiduals({ projectRoot: path.resolve("."), profilePaths: [], identities: [], wrapperIdentity: wrapper }, execute)).toThrow("禁止猜测0");
  });

  it("excludes only a proven current collector conhost while preserving its raw row and granting no authority", () => {
    const fixture = scopedCollectorFixture();
    const oldParent = processRow(fixture.row.parentPid, 1);
    const { result, execute } = captureCollectorFixture(fixture, [oldParent]);
    expect(result.unknownProcesses).toEqual([]);
    expect(result.ownedProcesses).toEqual([]);
    expect(result.rawUnknownProcesses).toEqual([fixture.row]);
    expect(result.excludedHistoricalParentCandidates).toEqual([]);
    expect(result.excludedDiagnosticCollectorCandidates).toEqual([expect.objectContaining({ ...fixture.row,
      exclusion: "DIAGNOSTIC_COLLECTOR_DIRECT_CHILD_OBSERVATION_ONLY", collectorIdentity: fixture.snapshot.diagnosticCollector,
      nativeCreationFileTime: fixture.candidate.nativeCreationFileTime, ownershipGranted: false, terminationAuthorized: false })]);
    expect(result.diagnosticCollectorObservation).toBe("OBSERVED");
    expect(JSON.parse(execute.mock.calls[0][2].input).identities).toEqual([oldParent]);
    const script = execute.mock.calls[0][1][3] as string;
    expect(script.indexOf("GetCurrentProcess()")).toBeLessThan(script.indexOf("foreach($item in $items)"));
    expect(script.indexOf("$queryEnded=[DateTime]::UtcNow")).toBeGreaterThan(script.indexOf("$childHandle.StartTime"));
    expect(script).not.toMatch(/\.Kill\(|taskkill|EnvironmentVariables/);
  });

  it.each(["present", "missing", "malformed", "truncated"])("records %s historical-parent evidence without reclassifying a newer unknown child", kind => {
    const fixture = historicalParentEvidenceFixture(kind === "truncated" ? 17 : 1, kind === "missing" ? [] : undefined);
    if (kind === "malformed") fixture.snapshot.historicalParentObservations.records[0].candidate.parentPid = 999;
    const { result, execute } = fixture.capture();
    expect(result.unknownProcesses).toEqual(fixture.unknown);
    expect(result.rawUnknownProcesses).toEqual(fixture.unknown);
    expect(result.ownedProcesses).toEqual([]);
    expect(result.excludedHistoricalParentCandidates).toEqual([]);
    expect(result.excludedDiagnosticCollectorCandidates).toEqual([]);
    const evidence = result.historicalParentFailureDiagnostics;
    expect(evidence).toMatchObject({ scope: "SAME_CIM_SNAPSHOT_HISTORICAL_PARENT_OBSERVATION_ONLY", candidateLimit: 16,
      ownershipGranted: false, terminationAuthorized: false, originalUnknownClassificationChanged: false });
    if (kind === "malformed") {
      expect(evidence).toMatchObject({ status: "NOT_MEASURED", reason: "MALFORMED_OR_UNBOUND_DIAGNOSTIC_NOT_TRUSTED", records: [] });
    } else {
      expect(evidence).toMatchObject({ status: "RECORDED", rawCandidateCount: fixture.unknown.length,
        rawCandidatesTruncated: kind === "truncated", unobservedRemainingUnknownCandidateCount: kind === "truncated" ? 1 : 0 });
      expect(evidence.records).toHaveLength(kind === "truncated" ? 16 : 1);
      expect(evidence.records[0]).toMatchObject({ candidate: { pid: 26796, parentPid: 37380, nativeBirthStamp: null },
        parentObservation: kind === "missing" ? "ABSENT_IN_THIS_SNAPSHOT" : "ONE_ROW_IN_THIS_SNAPSHOT",
        capturedParentIdentityCount: 1, capturedParentIdentitiesTruncated: false,
        capturedParentIdentities: [{ ...fixture.parent }], ownershipGranted: false, terminationAuthorized: false });
      expect(evidence.queryStartedAt).toBe(fixture.snapshot.diagnosticCollector.queryStartedAt);
      expect(evidence.queryEndedAt).toBe(fixture.snapshot.diagnosticCollector.queryEndedAt);
    }
    expect(execute).toHaveBeenCalledTimes(1);
    const script = execute.mock.calls[0][1][3] as string;
    expect(script.match(/Get-CimInstance Win32_Process/g)).toHaveLength(1);
    const addedProducer = script.slice(script.indexOf("$historicalCandidates="), script.indexOf("# Observation only: never adopt"));
    expect(addedProducer).not.toMatch(/Get-CimInstance|OpenProcess|GetProcessById|\.Kill\(/);
    const nativeObservation = script.slice(script.indexOf("# Observation only: never adopt"), script.indexOf("$queryEnded="));
    expect(nativeObservation).toContain(".HasExited");
    expect(nativeObservation).not.toMatch(/Get-CimInstance|\.Kill\(|taskkill/);
    expect(result).not.toHaveProperty("historicalParentObservations");
  });

  it("a headless browser predating the captured parent remains UNKNOWN, never excluded or owned", () => {
    const fixture = historicalParentEvidenceFixture();
    Object.assign(fixture.unknown[0], { name: "chrome-headless-shell.exe", createdAt: "2026-09-30T00:00:00.0000000Z" });
    Object.assign(fixture.snapshot.historicalParentObservations.records[0].candidate, {
      name: fixture.unknown[0].name, createdAt: fixture.unknown[0].createdAt });
    const { result } = fixture.capture();
    expect(result.unknownProcesses).toEqual(fixture.unknown);
    expect(result.ownedProcesses).toEqual([]);
    expect(result.excludedHistoricalParentCandidates).toEqual([]);
    expect(result.excludedReusedHistoricalParentCandidates).toEqual([]);
  });

  it("bounds captured parent incarnations and current parent rows without granting authority to any duplicate or replacement", () => {
    const parents = Array.from({ length: 5 }, (_, index) => processRow(37380, 10 + index, `2026-09-30T00:00:0${index}.0000000Z`));
    const fixture = historicalParentEvidenceFixture(1, parents);
    const { result } = fixture.capture(parents.map(parent => ({ ...parent, nativeBirthStamp: fixtureFileTime(parent.createdAt) })));
    expect(result.unknownProcesses).toEqual(fixture.unknown);
    expect(result.excludedHistoricalParentCandidates).toEqual([]);
    expect(result.historicalParentFailureDiagnostics.records[0]).toMatchObject({ currentParentRowCount: 5,
      currentParentRowsTruncated: true, parentObservation: "MULTIPLE_ROWS_IN_THIS_SNAPSHOT",
      capturedParentIdentityCount: 5, capturedParentIdentitiesTruncated: true, ownershipGranted: false, terminationAuthorized: false });
    expect(result.historicalParentFailureDiagnostics.records[0].capturedParentIdentities).toHaveLength(4);
    expect(result.historicalParentFailureDiagnostics.records[0].currentParentRows).toHaveLength(4);
    expect(result.historicalParentFailureDiagnostics.records[0].currentParentRows.every(row => row.nativeBirthStamp === null)).toBe(true);
  });

  it.each(["wrong-query", "authority", "extra-secret", "wrong-parent-row", "order", "false-truncation", "missing"])("rejects %s historical-parent diagnostic while preserving UNKNOWN", kind => {
    const fixture = historicalParentEvidenceFixture(2);
    const raw = fixture.snapshot.historicalParentObservations;
    if (kind === "wrong-query") raw.queryEndedAt = "2026-10-01T00:00:04.0000000Z";
    if (kind === "authority") raw.terminationAuthorized = true;
    if (kind === "extra-secret") Object.assign(raw.records[0].candidate, { commandLine: "SECRET_COMMAND_PATH" });
    if (kind === "wrong-parent-row") raw.records[0].currentParentRows = [processRow(999, 1)];
    if (kind === "order") raw.records.reverse();
    if (kind === "false-truncation") raw.candidateTruncated = true;
    if (kind === "missing") delete (fixture.snapshot as Partial<typeof fixture.snapshot>).historicalParentObservations;
    const { result } = fixture.capture();
    expect(result.unknownProcesses).toEqual(fixture.unknown);
    expect(result.ownedProcesses).toEqual([]);
    expect(result.excludedHistoricalParentCandidates).toEqual([]);
    expect(result.historicalParentFailureDiagnostics).toMatchObject({ status: "NOT_MEASURED", records: [],
      reason: "MALFORMED_OR_UNBOUND_DIAGNOSTIC_NOT_TRUSTED", ownershipGranted: false, terminationAuthorized: false });
    const code = ["wrong-query", "authority", "false-truncation", "missing"].includes(kind) ? "ENVELOPE_CONTRACT" :
      kind === "wrong-parent-row" ? "PARENT_IDENTITY_BINDING_OR_ORDER" : "RECORD_KEYS_CANDIDATE_IDENTITY_OR_BINDING";
    expect(result.historicalParentFailureDiagnostics.rejection).toEqual({ code,
      recordIndex: code === "ENVELOPE_CONTRACT" ? null : 0 });
    expect(result.historicalParentFailureDiagnostics.observationCapture).toMatchObject({
      status: "UNVALIDATED_SAME_SNAPSHOT_CAPTURE", candidateLimit: 16, parentRowLimit: 4, ownershipGranted: false, terminationAuthorized: false });
    expect(JSON.stringify(result)).not.toContain("SECRET_COMMAND_PATH");
  });

  it("uses the actual PS5 hashtable producer expressions for canonical numeric historical candidate order", () => {
    const fixture = historicalParentEvidenceFixture(2);
    const { execute } = fixture.capture();
    const script = execute.mock.calls[0][1][3] as string;
    const producer = script.slice(script.indexOf("$historicalCandidates="), script.indexOf("$historicalObservations="));
    expect(producer).toContain("Sort-Object @{Expression={[int]$_.pid}},@{Expression={[int]$_.parentPid}},@{Expression={[string]$_.createdAt}}");
    if (process.platform !== "win32") return;
    const input = '$unknown=@(@{pid=38232;parentPid=26924;createdAt="c";scopeReason="UNVERIFIED_HISTORICAL_PARENT_CANDIDATE"},' +
      '@{pid=11920;parentPid=5552;createdAt="a";scopeReason="UNVERIFIED_HISTORICAL_PARENT_CANDIDATE"},' +
      '@{pid=18612;parentPid=50848;createdAt="b";scopeReason="UNVERIFIED_HISTORICAL_PARENT_CANDIDATE"});';
    const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      input + producer + '$historicalCandidates | ForEach-Object {[int]$_.pid} | ConvertTo-Json -Compress'],
    { encoding: "utf8", windowsHide: true, timeout: 2000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual([11920, 18612, 38232]);
  });

  it("caps rejected same-snapshot capture without copying unexpected keys or relaxing UNKNOWN", () => {
    const fixture = historicalParentEvidenceFixture(17, Array.from({ length: 5 }, (_, i) => processRow(37380, i)));
    Object.assign(fixture.snapshot.historicalParentObservations, { secret: "SECRET_ENVELOPE" });
    Object.assign(fixture.snapshot.historicalParentObservations.records[0], { commandLine: "SECRET_RECORD" });
    Object.assign(fixture.snapshot.historicalParentObservations.records[0].currentParentRows[0], { commandLine: "SECRET_PARENT" });
    const { result } = fixture.capture();
    expect(result.unknownProcesses).toEqual(fixture.unknown);
    expect(result.ownedProcesses).toEqual([]);
    const capture = result.historicalParentFailureDiagnostics.observationCapture!;
    expect(capture.records).toHaveLength(16);
    expect(capture.records[0].currentParentRows).toHaveLength(4);
    expect(capture.records[0].currentParentRows[0].unexpectedKeys).toBe(true);
    expect(capture.records[0].unexpectedKeys).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/SECRET_ENVELOPE|SECRET_RECORD|SECRET_PARENT/);
    expect(result.historicalParentFailureDiagnostics.rejection).toEqual({ code: "ENVELOPE_CONTRACT", recordIndex: null });
  });

  it("actual ancestry producer rejects known ownership, missing or ambiguous rows, cycles and scope uncertainty", () => {
    const fixture = historicalParentEvidenceFixture();
    const { execute } = fixture.capture();
    const script = execute.mock.calls[0][1][3] as string;
    const fn = script.slice(script.indexOf("function NoKnownOwnedAncestor"), script.indexOf("foreach($candidate"));
    const birthFn = script.slice(script.indexOf("function RowBirth"), script.indexOf("function BirthFileTime"));
    expect(fn).not.toMatch(/Get-CimInstance|GetProcessById|\.Kill\(/);
    if (process.platform !== "win32") return;
    const code = `$scope=@{wrapperIdentity=@{pid=900};profilePaths=@('e:\\isolated-profile')};$marker='e:\\veridia';$historicalParentPids=@{'7000'=$true};
      ${birthFn}${fn}
      function Row($id,$parent,$command='c:\\foreign.exe',$born='2026-10-01T00:00:01Z'){@{ProcessId=$id;ParentProcessId=$parent;Name='foreign.exe';CommandLine=$command;ExecutablePath='c:\\foreign.exe';CreationDate=([DateTimeOffset]::Parse($born).UtcDateTime)}};
      $root=@{ProcessId=4;ParentProcessId=0;Name='System';CommandLine=$null;ExecutablePath=$null};$out=@();
      $items=@((Row 2 4),$root);$out+=NoKnownOwnedAncestor (Row 111 2);
      $out+=NoKnownOwnedAncestor (Row 111 900);$out+=NoKnownOwnedAncestor (Row 111 $PID);$out+=NoKnownOwnedAncestor (Row 111 7000);
      $out+=NoKnownOwnedAncestor (Row 111 2000);
      $items=@((Row 1 2),(Row 2 1));$out+=NoKnownOwnedAncestor (Row 111 1);
      $items=@((Row 2 4 'e:\\veridia\\helper'),$root);$out+=NoKnownOwnedAncestor (Row 111 2);
      $items=@((Row 2 4 'e:\\isolated-profile\\helper'),$root);$out+=NoKnownOwnedAncestor (Row 111 2);
      $items=@((Row 2 4),(Row 2 4),$root);$out+=NoKnownOwnedAncestor (Row 111 2);
      $items=@((Row 2 4 $null),$root);$out+=NoKnownOwnedAncestor (Row 111 2);
      $items=@(1..65|ForEach-Object {Row (1000+$_) (1001+$_)});$out+=NoKnownOwnedAncestor (Row 111 1001);
      $items=@((Row 2 4),$root);$out+=NoKnownOwnedAncestor (Row 111 $null);
      $items=@((Row 2 4 'c:\\foreign.exe' '2026-10-01T00:00:02Z'),$root);$out+=NoKnownOwnedAncestor (Row 111 2);
      $missing=Row 2 4;$missing.CreationDate=$null;$items=@($missing,$root);$out+=NoKnownOwnedAncestor (Row 111 2);
      $items=@(@{ProcessId=4;ParentProcessId=$null;Name='System'});$out+=NoKnownOwnedAncestor (Row 111 4);
      $out|ConvertTo-Json -Compress`;
    const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code],
      { encoding: "utf8", windowsHide: true, timeout: 2000 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout.trim())).toEqual([true, false, false, false, false, false, false, false, false, false, false, false, false, false, false]);
  });

  it.each(["valid", "missing-proof", "duplicate-proof", "parent-exited", "native-unbound", "child-scope", "parent-scope", "parent-named", "parent-headless-shell",
    "parent-after-child", "captured-new-parent", "missing-captured-native", "child-native-mismatch", "parent-native-mismatch", "wrong-ppid", "authority", "extra-secret",
    "owned-ancestor", "wrapper-parent", "collector-parent", "captured-parent-parent"])(
    "%s retained native current-parent proof never grants ownership and rejects incomplete PID-reuse evidence", kind => {
      const fixture = historicalParentEvidenceFixture();
      fixture.snapshot.diagnosticCollector.queryStartedAt = "2026-10-01T00:00:02.5000000Z";
      fixture.snapshot.diagnosticCollector.queryStartedFileTime = fixtureFileTime(fixture.snapshot.diagnosticCollector.queryStartedAt);
      fixture.snapshot.historicalParentObservations.queryStartedAt = fixture.snapshot.diagnosticCollector.queryStartedAt;
      const child = fixture.unknown[0];
      const parent = processRow(child.parentPid, 1, "2026-10-01T00:00:01.0000000Z");
      const proof = { child: { ...child, nativeCreationFileTime: fixtureFileTime(child.createdAt) },
        parent: { ...parent, name: "external_helper.exe", nativeCreationFileTime: fixtureFileTime(parent.createdAt) },
        sameSnapshotUniqueRows: true, childScopeKnownNonProjectProfile: true, parentScopeKnownNonProjectProfile: true,
        noKnownOwnedAncestorSameSnapshot: true,
        sameHandlesLiveAtBothBoundaries: true, nativeIdentityMatchesAtBothBoundaries: true,
        ownershipGranted: false, terminationAuthorized: false };
      delete (proof.child as Partial<typeof proof.child>).scopeReason;
      if (kind === "parent-exited") proof.sameHandlesLiveAtBothBoundaries = false;
      if (kind === "native-unbound") proof.nativeIdentityMatchesAtBothBoundaries = false;
      if (kind === "child-scope") proof.childScopeKnownNonProjectProfile = false;
      if (kind === "parent-scope") proof.parentScopeKnownNonProjectProfile = false;
      if (kind === "parent-named") proof.parent.name = "node.exe";
      if (kind === "parent-headless-shell") proof.parent.name = "chrome-headless-shell.exe";
      if (kind === "parent-after-child") { proof.parent.createdAt = "2026-10-01T00:00:02.5000000Z"; proof.parent.nativeCreationFileTime = fixtureFileTime(proof.parent.createdAt); }
      if (kind === "child-native-mismatch") proof.child.nativeCreationFileTime = (BigInt(proof.child.nativeCreationFileTime) + 10n).toString();
      if (kind === "parent-native-mismatch") proof.parent.nativeCreationFileTime = (BigInt(proof.parent.nativeCreationFileTime) + 10n).toString();
      if (kind === "wrong-ppid") proof.parent.pid = 999;
      if (kind === "authority") proof.terminationAuthorized = true;
      if (kind === "extra-secret") Object.assign(proof.parent, { commandLine: "SECRET_REUSE_PARENT" });
      if (kind === "owned-ancestor") proof.noKnownOwnedAncestorSameSnapshot = false;
      if (kind === "wrapper-parent") proof.parent.parentPid = fixture.snapshot.diagnosticCollector.callerIdentity.pid;
      if (kind === "collector-parent") proof.parent.parentPid = fixture.snapshot.diagnosticCollector.pid;
      if (kind === "captured-parent-parent") proof.parent.parentPid = child.parentPid;
      Object.assign(fixture.snapshot, { historicalParentReuseCandidates: kind === "missing-proof" ? [] : kind === "duplicate-proof" ? [proof, proof] : [proof] });
      const captured = kind === "captured-new-parent" ? fixture.parent : {
        ...processRow(child.parentPid, 1), nativeBirthStamp: fixtureFileTime(processRow(child.parentPid, 1).createdAt) };
      if (kind === "missing-captured-native") Object.assign(captured, { nativeBirthStamp: undefined });
      const { result, execute } = fixture.capture([captured]);
      expect(result.ownedProcesses).toEqual([]);
      expect(result.excludedHistoricalParentCandidates).toEqual([]);
      if (kind === "valid") {
        expect(result.unknownProcesses).toEqual([]);
        expect(result.excludedReusedHistoricalParentCandidates).toMatchObject([{ pid: child.pid,
          exclusion: "CURRENT_NATIVE_PARENT_INCARNATION_PRECEDES_CHILD_BIRTH", ownershipGranted: false, terminationAuthorized: false }]);
      } else {
        expect(result.unknownProcesses).toEqual(fixture.unknown);
        expect(result.excludedReusedHistoricalParentCandidates).toEqual([]);
      }
      expect(execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("SECRET_REUSE_PARENT");
    });

  it.each(["missing-native", "native-mismatch", "unverified-native", "unknown-scope", "project", "opaque", "named", "not-conhost",
    "wrong-parent", "before-collector", "after-query", "duplicate-proof"])("keeps %s collector candidates UNKNOWN", kind => {
    const fixture = scopedCollectorFixture();
    if (kind === "missing-native") fixture.candidate.nativeCreationFileTime = null;
    if (kind === "native-mismatch") fixture.candidate.nativeCreationFileTime = (BigInt(fixture.candidate.nativeCreationFileTime!) + 10n).toString();
    if (kind === "unverified-native") fixture.candidate.nativeBirthVerified = false;
    if (kind === "unknown-scope") fixture.candidate.scopeKnownNonProjectProfile = false;
    if (kind === "project") fixture.row.scopeReason = "PROJECT_OR_RUN_PROFILE_MATCH";
    if (kind === "opaque") {
      fixture.row.scopeReason = "UNSCOPED_OPAQUE_NAMED_CANDIDATE";
      fixture.snapshot.opaqueUnscopedCandidates = [fixture.row]; fixture.snapshot.opaqueUnscopedCandidateCount = 1;
    }
    if (kind === "named" || kind === "not-conhost") fixture.row.name = fixture.candidate.name = kind === "named" ? "node.exe" : "conhost-copy.exe";
    if (kind === "wrong-parent") fixture.row.parentPid = fixture.candidate.parentPid = 887;
    if (kind === "before-collector" || kind === "after-query") {
      fixture.row.createdAt = fixture.candidate.createdAt = kind === "before-collector" ? "2026-09-30T23:59:59.0000000Z" : "2026-10-01T00:00:04.0000000Z";
      fixture.candidate.nativeCreationFileTime = fixtureFileTime(fixture.row.createdAt);
    }
    if (kind === "duplicate-proof") fixture.snapshot.diagnosticCollectorCandidates.push({ ...fixture.candidate });
    const { result } = captureCollectorFixture(fixture);
    expect(result.unknownProcesses).toEqual([fixture.row]);
    expect(result.rawUnknownProcesses).toEqual([fixture.row]);
    expect(result.excludedDiagnosticCollectorCandidates).toEqual([]);
    expect(result.ownedProcesses).toEqual([]);
    expect(result.diagnosticCollectorObservation).toBe("NOT_OBSERVED");
    expect(result.opaqueUnscopedCandidates).toEqual(fixture.snapshot.opaqueUnscopedCandidates);
    expect(result.opaqueUnscopedCandidateCount).toBe(fixture.snapshot.opaqueUnscopedCandidateCount);
  });

  it.each(["missing", "wrong-caller", "native-mismatch", "window-mismatch", "unverified", "authority", "newer-caller-100ns"])("fails closed on %s collector provenance", kind => {
    const fixture = scopedCollectorFixture();
    if (kind === "missing") delete (fixture.snapshot as Partial<typeof fixture.snapshot>).diagnosticCollector;
    else {
      const collector = fixture.snapshot.diagnosticCollector;
      if (kind === "wrong-caller") collector.parentPid = 901;
      if (kind === "native-mismatch") collector.nativeCreationFileTime = (BigInt(collector.nativeCreationFileTime) + 10n).toString();
      if (kind === "window-mismatch") collector.queryEndedFileTime = fixtureFileTime(collector.queryStartedAt);
      if (kind === "unverified") collector.directCallerVerified = false;
      if (kind === "authority") collector.terminationAuthorized = true;
      if (kind === "newer-caller-100ns") {
        fixture.wrapper.createdAt = "2026-10-01T00:00:00.0000001Z";
        collector.callerNativeCreationFileTime = fixtureFileTime(fixture.wrapper.createdAt);
      }
    }
    expect(() => captureCollectorFixture(fixture)).toThrow("测量不完整");
  });

  it("actual cleanup emits a source-bound receipt only after both native fences, profile removal and shared Next restoration", async () => {
    const lab = cleanupFunctionLab();
    await lab.run();
    expect(lab.events.filter(event => event === "native-fence")).toHaveLength(2);
    expect(lab.events.filter(event => event === "residual-fence")).toHaveLength(2);
    expect(lab.events.indexOf("native-fence")).toBeLessThan(lab.events.indexOf("remove:xhs-profile"));
    expect(lab.events.indexOf("next-env-restore")).toBeLessThan(lab.events.lastIndexOf("native-fence"));
    expect(lab.events.at(-1)).toBe("success-receipt");
    expect(lab.output).toHaveLength(1);
    const receipt = JSON.parse(lab.output[0].replace(/^VERIDIA_E2E_QUIESCENCE=/u, ""));
    expect(receipt).toMatchObject({ status: "PASSED", head: "a".repeat(40), sourceFingerprint: "b".repeat(64),
      logicalIdleStatus: "PASSED", finalOwnedProcessCount: 0, portCount: 0, unknownResidualCount: 0,
      profilesRemoved: true, nextEnvRestored: true, typeCleanupPass: true,
      observation: { coverage: "SAMPLED_NOT_EXHAUSTIVE" }, retiredProcessTrees: [{ rootPid: 20, identities: [processRow(20, 1)] }] });
  });

  it("actual cleanup cannot publish PASS for locked profiles, failed shared restoration, unknown residuals, changed source or missing observations", async () => {
    for (const failure of ["profile", "types", "restore", "unknown", "source", "observation"] as const) {
      const lab = cleanupFunctionLab(failure);
      await expect(lab.run()).rejects.toThrow();
      expect(lab.output).toEqual([]);
      expect(lab.metadata).toContainEqual(expect.objectContaining({ cleaned: false, resourceLeakCheck: { status: "FAILED", passed: false } }));
      const failureReceipt = lab.metadata.find(value => value.cleaned === false)!;
      for (const key of ["runtimeAfterCleanup", "processObservation", "retiredProcessTrees", "cleanupElapsedMs", "cleanupDeadlineMs"]) {
        expect(Object.hasOwn(failureReceipt, key)).toBe(true);
      }
      expect(failureReceipt.cleanupDeadlineMs).toBe(45_000);
      expect(failureReceipt.retiredProcessTrees).toEqual([expect.objectContaining({ rootPid: 20 })]);
      if (failure === "unknown") expect(lab.events.some(event => event.startsWith("remove:"))).toBe(false);
      if (failure === "types") expect(lab.events).toContain("next-env-restore");
      if (failure === "observation") expect(lab.events).toEqual(expect.arrayContaining(["warmup-close", "owned-stop:20", "owned-stop:21", "native-fence"]));
    }
  });

  it("initial PID adoption requires the actual direct creator, executable name and synchronous spawn birth window", () => {
    const createdAt = "2026-09-30T12:00:00.1234560Z";
    const actual = processRow(20, 1, createdAt);
    const fence = { pid: 20, parentPid: 1, name: "node.exe", earliestCreationMs: Date.parse(createdAt), latestCreationMs: Date.parse(createdAt) + 1 };
    expect(validateInitialOwnedRoot(actual, fence)).toBe(true);
    expect(validateInitialOwnedRoot(actual, { ...fence, expectedCreatedAt: createdAt })).toBe(true);
    expect(validateInitialOwnedRoot(actual, undefined)).toBe(false);
    expect(validateInitialOwnedRoot({ ...actual, parentPid: 40 }, fence)).toBe(false);
    expect(validateInitialOwnedRoot({ ...actual, name: "unrelated.exe" }, fence)).toBe(false);
    expect(validateInitialOwnedRoot({ ...actual, createdAt: "" }, fence)).toBe(false);
    expect(validateInitialOwnedRoot({ ...actual, createdAt: "invalid" }, { ...fence, expectedCreatedAt: "invalid" })).toBe(false);
    expect(validateInitialOwnedRoot(actual, { ...fence, earliestCreationMs: fence.latestCreationMs + 10 })).toBe(false);
    expect(validateInitialOwnedRoot(actual, { ...fence, latestCreationMs: fence.earliestCreationMs - 10 })).toBe(false);
    expect(validateInitialOwnedRoot(actual, { ...fence, expectedCreatedAt: "later" })).toBe(false);
  });

  it("registers spawn fences before diagnostic I/O and keeps live session prewarm in warmup, never after browser teardown", () => {
    const source = fs.readFileSync(path.resolve("scripts/testing/run-e2e.mjs"), "utf8");
    const parsed = ts.createSourceFile("run-e2e.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const functionBody = (name: string) => {
      const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
      if (!declaration || !ts.isFunctionDeclaration(declaration) || !declaration.body) throw new Error(`Missing wrapper function ${name}`);
      return declaration.body;
    };
    const server = functionBody("startNextServer").getText(parsed);
    expect(server.indexOf("child.e2eOwnershipFence =")).toBeGreaterThanOrEqual(0);
    expect(server.indexOf("serverProcess = child")).toBeLessThan(server.indexOf("child.e2eOwnershipFence ="));
    expect(server.indexOf("child.e2eOwnershipFence =")).toBeLessThan(server.indexOf("recordMetadataBestEffort("));
    expect(server.indexOf("child.e2eOwnershipFence =")).toBeLessThan(server.indexOf("writeMetadata("));
    expect(server.indexOf("child.e2eOwnershipFence =")).toBeLessThan(server.indexOf("captureWindowsRuntime("));
    const warmup = functionBody("warmup").getText(parsed);
    expect(warmup.indexOf("for (const platform of")).toBeGreaterThanOrEqual(0);
    const snapshotCapture = warmup.indexOf("await captureWarmupApiAuthCookieSnapshot(context, baseURL)");
    expect(snapshotCapture).toBeGreaterThanOrEqual(0);
    expect(warmup.indexOf("for (const platform of")).toBeLessThan(snapshotCapture);
    expect(snapshotCapture).toBeLessThan(warmup.indexOf("closeWarmupBrowser()"));
    const closedIdentifiers: string[] = [];
    const visit = (node: ts.Node) => { if (ts.isIdentifier(node)) closedIdentifiers.push(node.text); ts.forEachChild(node, visit); };
    visit(functionBody("closeWarmupBrowser"));
    expect(closedIdentifiers).not.toContain("context");
  });

  it.each(["chrome.exe", "chromium.exe", "headless_shell.exe", "chrome-headless-shell.exe"])("identifies new direct %s child; rejects existing, foreign, ambiguous or missing birth identity", name => {
    const existing = { ...processRow(20, 1), name };
    const fresh = { ...processRow(21, 1, "new"), name };
    const foreign = { ...processRow(22, 40, "new"), name };
    expect(selectNewOwnedBrowserRoot([existing], [existing, fresh, foreign], 1)).toEqual(fresh);
    expect(() => selectNewOwnedBrowserRoot([existing], [existing, foreign], 1)).toThrow("不唯一");
    expect(() => selectNewOwnedBrowserRoot([], [fresh, { ...fresh, pid: 23 }], 1)).toThrow("不唯一");
    expect(() => selectNewOwnedBrowserRoot([], [{ ...fresh, createdAt: "" }], 1)).toThrow("不唯一");
  });

  it("bounds a hung graceful browser close without suppressing its rejection", async () => {
    await expect(closeWithinDeadline(() => new Promise(() => {}), 10)).rejects.toThrow("超时");
    await expect(closeWithinDeadline(() => Promise.reject(new Error("physical close failed")), 10)).rejects.toThrow("physical close failed");
    await expect(closeWithinDeadline(() => Promise.resolve(), 10)).resolves.toBeUndefined();
  });

  it("measures real zero logical counts before teardown and explicitly distinguishes a valid retained idle owner", () => {
    const fixture = idleFixture();
    expect(evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toMatchObject({ idle: true, ownerState: "NONE_RECORDED", isolatedDatabaseResponsive: true });
    fixture.runtime.activeBrowserOwnerGenerations = [3];
    Object.assign(fixture.runtime.platformBrowserManagers.XIAOHONGSHU, { contextPresent: true, browserConnected: true, contextOwnerGeneration: 3, contextOwnershipKind: "EXTRACTION" });
    expect(evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toMatchObject({ idle: true, ownerState: "VALID_RETAINED_OWNER", activeBrowserOwnerGenerations: [3] });
  });

  it("validates extraction owners in both ledger directions, rejects duplicates, and distinguishes explicit interactive launch provenance", () => {
    const fixture = idleFixture();
    const manager = fixture.runtime.platformBrowserManagers.XIAOHONGSHU;
    Object.assign(manager, { contextPresent: true, browserConnected: true, contextOwnershipKind: "EXTRACTION" });
    expect(() => evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toThrow("所有权来源");
    manager.contextOwnerGeneration = 3;
    expect(() => evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toThrow("所有权来源");
    fixture.runtime.activeBrowserOwnerGenerations = [3, 3];
    expect(() => evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toThrow("真实 Browser owner");
    fixture.runtime.activeBrowserOwnerGenerations = [];
    manager.contextOwnerGeneration = null;
    manager.contextOwnershipKind = "INTERACTIVE";
    expect(evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toMatchObject({ idle: true, ownerState: "VALID_RETAINED_INTERACTIVE_CONTEXT" });
    manager.contextPresent = false;
    expect(() => evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toThrow("所有权来源");
  });

  it("cannot invent zero counts from missing managers, missing diagnostics, unhealthy DB/session or failed physical fences", () => {
    const fixture = idleFixture();
    for (const key of ["effectiveRunnerCount", "activeExtractionCount", "pendingCleanupBarrierCount", "pendingLifecycleOperationCount"]) {
      expect(() => evaluateGenerationIdleSnapshot({ ...fixture.runtime, [key]: null }, fixture.sessions, fixture.health)).toThrow("真实整数计数");
    }
    fixture.runtime.platformBrowserManagers.DOUYIN.managerAvailable = false;
    expect(() => evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toThrow("不可验证");
    fixture.runtime.platformBrowserManagers.DOUYIN.managerAvailable = true;
    expect(() => evaluateGenerationIdleSnapshot(fixture.runtime, {}, fixture.health)).toThrow("isolated DB session");
    expect(() => evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, { ok: false })).toThrow("未就绪");
    fixture.runtime.physicalCloseState = "FAILED";
    expect(() => evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toThrow("fence FAILED");
  });

  it("requires measured pending explicit transaction zero before physical teardown, never responsive SQL or transport zero", () => {
    const fixture = idleFixture();
    const observed = fixture.runtime.prismaTransactionDiagnostics;
    expect(evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toMatchObject({
      idle: true, counts: { pendingPrismaTransactionCount: 0 },
      prismaTransactionCheck: { status: "PASSED", coverageScope: "APP_LIB_SINGLETON_EXPLICIT_TRANSACTIONS" },
    });
    Object.assign(observed, { pendingTransactionCount: 1, settledTransactionCount: 1 });
    expect(evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toMatchObject({
      idle: false, prismaTransactionCheck: { status: "PENDING", pendingTransactionCount: 1 },
    });
    for (const invalid of [undefined, null, { ...observed, measurement: "NOT_RUN" },
      { ...observed, measurement: "INVALID" }, { ...observed, wrapperIntact: false },
      { ...observed, coverageScope: "ALL_PRISMA_CONNECTIONS" }]) {
      expect(() => evaluateGenerationIdleSnapshot({ ...fixture.runtime, prismaTransactionDiagnostics: invalid }, fixture.sessions, fixture.health)).toThrow("measurement 不可验证");
    }
    for (const pending of [null, undefined, -1, 0.5, "0"]) {
      expect(() => evaluateGenerationIdleSnapshot({ ...fixture.runtime, prismaTransactionDiagnostics: { ...observed, pendingTransactionCount: pending } }, fixture.sessions, fixture.health)).toThrow("真实整数计数");
    }
    expect(() => evaluateGenerationIdleSnapshot({ ...fixture.runtime, prismaTransactionDiagnostics: { ...observed, pendingTransactionCount: 0 } }, fixture.sessions, fixture.health)).toThrow("ledger 不一致");
  });

  it("observed runner, extraction, barrier, pending operation or physical fence is busy, not a teardown-produced idle PASS", () => {
    const fixture = idleFixture();
    for (const key of ["effectiveRunnerCount", "activeExtractionCount", "pendingCleanupBarrierCount", "pendingLifecycleOperationCount"]) {
      expect(evaluateGenerationIdleSnapshot({ ...fixture.runtime, [key]: 1 }, fixture.sessions, fixture.health).idle).toBe(false);
    }
    expect(evaluateGenerationIdleSnapshot({ ...fixture.runtime, physicalCloseFencePresent: true }, fixture.sessions, fixture.health).idle).toBe(false);
    expect(evaluateGenerationIdleSnapshot({ ...fixture.runtime, physicalCloseState: "PENDING" }, fixture.sessions, fixture.health).idle).toBe(false);
    fixture.runtime.activeBrowserOwnerGenerations = [3];
    expect(() => evaluateGenerationIdleSnapshot(fixture.runtime, fixture.sessions, fixture.health)).toThrow("没有对应存活 context");
  });

  it("a real idle pooled-socket reset cannot replay POST; close transport preserves cookies and HTTP errors with a stable child server", async () => {
    const child = spawn(process.execPath, [path.resolve("tests/fixtures/e2e-idle-http-server.cjs")], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    const exited = new Promise(resolve => child.once("exit", resolve));
    const nativeRequest = http.request;
    const observations: { path: string; reusedSocket?: boolean }[] = [];
    let stallUntil = 0;
    const contexts: Awaited<ReturnType<typeof request.newContext>>[] = [];
    try {
      const ready = await childMessage(child, "ready");
      const baseURL = `http://127.0.0.1:${ready.port}`;
      http.request = function (this: typeof http, ...args: Parameters<typeof http.request>) {
        const pathname = args[0] instanceof URL ? args[0].pathname : String(args[0]);
        // Hold only this intentional baseline request at the native boundary
        // until the observed real idle deadline. The child event loop runs
        // independently and closes the socket; no injected ECONNRESET occurs.
        if (pathname === "/baseline-once") while (Date.now() < stallUntil) {}
        const outgoing = nativeRequest.apply(this, args);
        const observation = { path: pathname, reusedSocket: false };
        observations.push(observation);
        outgoing.once("socket", () => { observation.reusedSocket = outgoing.reusedSocket; });
        return outgoing;
      } as typeof http.request;
      const baseline = await request.newContext({ baseURL });
      contexts.push(baseline);
      const first = await (await baseline.get("/session", { maxRetries: 0 })).json();
      expect(first.pid).toBe(child.pid);
      stallUntil = first.idleDeadline + 30;
      await expect(baseline.post("/baseline-once", { data: { fixture: true }, maxRetries: 0 })).rejects.toThrow(/ECONNRESET|socket hang up|EPIPE/u);
      expect(observations.filter(item => item.path === "/baseline-once")).toEqual([{ path: "/baseline-once", reusedSocket: true }]);
      const baselineSnapshot = childMessage(child, "snapshot");
      child.send("snapshot");
      const baselineEvidence = await baselineSnapshot;
      expect(baselineEvidence).toMatchObject({ pid: ready.pid, postCount: 0 });
      expect(baselineEvidence.events.some(event => event.event === "idle-timeout")).toBe(true);

      // After the same idle boundary the fixed context starts fresh. Every
      // response closes its connection, leaving no pool entry for ANY later
      // idle boundary, while APIRequestContext still owns authentication.
      const fixed = await request.newContext({ baseURL, extraHTTPHeaders: { Connection: "close" } });
      contexts.push(fixed);
      const session = await (await fixed.get("/session", { maxRetries: 0 })).json();
      const post = await fixed.post("/fixed-once", { data: { fixture: true }, maxRetries: 0 });
      expect(post.status()).toBe(200);
      const body = await post.json();
      expect(body).toMatchObject({ pid: ready.pid, authenticated: true, postCount: 1 });
      expect(body.connectionId).not.toBe(session.connectionId);
      expect(observations.filter(item => item.path === "/fixed-once")).toEqual([{ path: "/fixed-once", reusedSocket: false }]);
      const errorResponse = await fixed.get("/http-error", { maxRetries: 0 });
      expect(errorResponse.status()).toBe(409);
      expect(await errorResponse.json()).toMatchObject({ pid: ready.pid, authenticated: true, postCount: 1 });
      expect(child.exitCode).toBeNull();
      const finalSnapshot = childMessage(child, "snapshot");
      child.send("snapshot");
      expect(await finalSnapshot).toMatchObject({ pid: ready.pid, postCount: 1 });
    } finally {
      http.request = nativeRequest;
      await Promise.all(contexts.map(context => context.dispose()));
      if (child.connected) child.send("stop");
      await closeWithinDeadline(() => exited, 1_000).catch(error => { child.kill(); throw error; });
      expect(child.exitCode).toBe(0);
    }
  });

  it("a reused PID is not an owned process identity", () => {
    const identities = [processRow(20, 1), processRow(21, 20)];
    expect(matchingOwnedProcesses([processRow(20, 1, "later"), processRow(21, 20)], identities).map(item => item.pid)).toEqual([21]);
    expect(matchingOwnedProcesses([processRow(20, 1, "")], [processRow(20, 1, "")])).toEqual([]);
  });

  it("matches every exact historical birth of a reused PID independent of retirement-history order", () => {
    const older = processRow(20, 1, "2026-10-01T00:00:01.0000000Z");
    const newer = processRow(20, 1, "2026-10-01T00:00:02.0000000Z");
    const unrelated = processRow(20, 1, "2026-10-01T00:00:03.0000000Z");
    for (const history of [[older, newer], [newer, older]]) {
      expect(matchingOwnedProcesses([older], history)).toEqual([older]);
      expect(matchingOwnedProcesses([newer], history)).toEqual([newer]);
      expect(matchingOwnedProcesses([unrelated], history)).toEqual([]);
    }
  });

  it("actual PowerShell classifies scoped candidates; unsupported platforms explicitly return unmeasured instead of native PASS", async () => {
    if (process.platform !== "win32") { await assertUnsupportedNativeMeasurement(); return; }
    const wrapper = captureWindowsRuntime(3100).processes.find(item => item.pid === process.pid);
    expect(wrapper).toBeDefined();
    const project = path.resolve(".");
    const fixture = (pid: number, command: string | null, executable: string | null = process.execPath, name = "node.exe") => ({
      ProcessId: pid, ParentProcessId: 999, Name: name, birth: processRow(pid, 999).createdAt, CommandLine: command, ExecutablePath: executable,
    });
    const rows = [
      { ...fixture(wrapper!.pid, null, null), ParentProcessId: wrapper!.parentPid, birth: wrapper!.createdAt },
      fixture(100001, `node ${project.replaceAll("\\", "/")}/fixture-forward.mjs`),
      fixture(100002, `node "${project}\\fixture-backward.mjs"`),
      fixture(100003, `chrome --user-data-dir="${project}\\.playwright\\unit-profile"`, process.execPath, "chrome.exe"),
      fixture(100004, "node no-project-args", path.join(project, "desktop-runtime", "node.exe")),
      fixture(100005, `node ${project}-foreign\\fixture.mjs`),
      fixture(100006, "node E:/completely-foreign/fixture.mjs"),
      fixture(100007, `powershell ${project}\\fixture.ps1`, process.execPath, "powershell.exe"),
      fixture(100008, null, null),
      { ...fixture(100009, "foreign child", process.execPath, "conhost.exe"), ParentProcessId: 200000 },
      fixture(100010, null, null),
      fixture(100011, null, "C:/synthetic-global-node/node.exe"),
      { ...fixture(100012, null, null), birth: null },
      { ...fixture(100013, "foreign older child", process.execPath, "picpreview.exe"), ParentProcessId: 200000, birth: "2026-09-29T06:03:32.3757820Z" },
      { ...fixture(100014, "foreign later child", process.execPath, "conhost.exe"), ParentProcessId: 200000, birth: "2026-10-01T00:00:00.0000000Z" },
      { ...fixture(100015, `node ${project}/fixture-older-project.mjs`), ParentProcessId: 200000, birth: "2026-09-29T06:03:32.3757820Z" },
      { ...fixture(100016, "foreign child of uncertain parent", process.execPath, "picpreview.exe"), ParentProcessId: 200001, birth: "2026-09-29T06:03:32.3757820Z" },
      { ...fixture(100017, project, "C:/Windows/System32/conhost.exe", "conhost.exe"), ParentProcessId: -1 },
      { ...fixture(100018, "E:/collector-fixture-profile", "C:/Windows/System32/conhost.exe", "conhost.exe"), ParentProcessId: -1 },
      { ...fixture(100019, null, null, "conhost.exe"), ParentProcessId: -1 },
      { ...fixture(200000, "foreign reused parent"), birth: "2026-10-01T00:00:00.0000000Z" },
      { ...fixture(100020, "foreign executable", "C:/foreign/agent.exe", "ExternalSecurityAgent.exe"), ParentProcessId: 200000 },
      fixture(100021, `${project}\\external-helper.mjs`, "C:/foreign/agent.exe", "ExternalSecurityAgent.exe"),
      fixture(100022, "foreign listener", "C:/foreign/agent.exe", "ExternalSecurityAgent.exe"),
      { ...fixture(100023, "foreign child of captured live parent", "C:/foreign/agent.exe", "ExternalSecurityAgent.exe"), ParentProcessId: 100010,
        birth: "2026-10-01T00:00:00.0000000Z" },
      fixture(100024, "captured exact child", "C:/foreign/agent.exe", "ExternalSecurityAgent.exe"),
      { ...fixture(100025, "PID reuse is not ownership", "C:/foreign/agent.exe", "ExternalSecurityAgent.exe"), ParentProcessId: 200000,
        birth: "2026-10-01T00:00:01.0000000Z" },
      fixture(100026, 'external --profile=E:/collector-fixture-profile', "C:/foreign/agent.exe", "ExternalSecurityAgent.exe"),
      { ...fixture(100027, "weak missing historical parent", "C:/foreign/agent.exe", "ExternalSecurityAgent.exe"), ParentProcessId: 200001,
        birth: "2026-10-01T00:00:01.0000000Z" },
      { ...fixture(100028, "ambient observer child", "C:/foreign/agent.exe", "ExternalSecurityAgent.exe"), ParentProcessId: wrapper!.pid,
        birth: new Date(Date.parse(wrapper!.createdAt) + 1).toISOString().replace("Z", "0000Z") },
      { ...fixture(100029, `${project}\\owned-resource.mjs`, "C:/foreign/agent.exe", "ExternalSecurityAgent.exe"), ParentProcessId: wrapper!.pid,
        birth: new Date(Date.parse(wrapper!.createdAt) + 1).toISOString().replace("Z", "0000Z") },
    ];
    const historical = processRow(200000, 1);
    const knownOpaque = processRow(100010, 999);
    const knownExternal = { ...processRow(100024, 999), name: "ExternalSecurityAgent.exe" };
    const observed = captureWindowsScopedResiduals({ projectRoot: project, profilePaths: [path.join(project, ".playwright", "unit-profile"), "E:/collector-fixture-profile"],
      identities: [historical, knownOpaque, knownExternal, processRow(200001, 1, "invalid-birth")], wrapperIdentity: wrapper!,
      portListeners: [{ pid: 100022, port: 53022 }] }, (command, args, options) => {
      const nativeArgs = args as string[];
      const nativeOptions = options as { input: string };
      const actualScript = nativeArgs[3];
      // Assert the executable argument itself, not JSON-escaped source text.
      expect(actualScript).toContain("-match '^(node|chrome|chromium|headless_shell|chrome-headless-shell|electron|VERIDIA)\\.exe$'");
      expect(actualScript).toContain(".Replace('/','\\')");
      expect(actualScript).not.toContain(".Replace('/','\\\\')");
      const fixtureProvider = `\n$actualSelf=@(Get-CimInstance Win32_Process -Filter "ProcessId=$PID"); $fixtureRows=@($scope.fixtureRows | ForEach-Object { [pscustomobject]@{ProcessId=$_.ProcessId;ParentProcessId=$(if($_.ParentProcessId -eq -1){$PID}else{$_.ParentProcessId});Name=$_.Name;CreationDate=$(if($_.birth){[DateTimeOffset]::Parse($_.birth).UtcDateTime}else{$null});CommandLine=$_.CommandLine;ExecutablePath=$_.ExecutablePath} })+$actualSelf; function Get-CimInstance { $fixtureRows };\n`;
      const script = actualScript.replace("$scope=[Console]::In.ReadToEnd() | ConvertFrom-Json;", "$scope=[Console]::In.ReadToEnd() | ConvertFrom-Json;" + fixtureProvider);
      return spawnSync(command as string, [...nativeArgs.slice(0, 3), script], { ...nativeOptions, encoding: "utf8", windowsHide: true,
        input: JSON.stringify({ ...JSON.parse(nativeOptions.input), fixtureRows: rows }) });
    });
    expect(observed).toMatchObject({ wrapperIdentityVerified: true, ownedProcesses: [knownOpaque, knownExternal], opaqueUnscopedCandidateCount: 3 });
    expect(observed.unknownProcesses.map(item => item.pid)).toEqual([100001, 100002, 100003, 100004, 100007, 100015, 100017, 100018, 100019, 100021, 100022, 100023, 100026, 100029]);
    expect(observed.unknownProcesses.find(item => item.pid === 100028)).toBeUndefined();
    expect(observed.unknownProcesses.find(item => item.pid === 100029)?.scopeReason).toBe("PROJECT_OR_RUN_PROFILE_MATCH");
    expect(observed.rawUnknownProcesses.map(item => item.pid)).not.toContain(100013);
    expect(observed.excludedHistoricalParentCandidates).toEqual([]);
    expect(observed.historicalParentReferences.map(item => item.pid)).toEqual([100009, 100013, 100014, 100016, 100020, 100025, 100027]);
    expect(observed.historicalParentReferences.every(item => item.ownershipGranted === false && item.terminationAuthorized === false)).toBe(true);
    expect(observed.opaqueUnscopedCandidates.map(item => item.pid)).toEqual([100008, 100011, 100012]);
    expect(observed.unknownProcesses.find(item => item.pid === 100011)).toBeUndefined();
    expect(observed.unknownProcesses.find(item => item.pid === 100021)?.scopeReason).toBe("PROJECT_OR_RUN_PROFILE_MATCH");
    expect(observed.unknownProcesses.find(item => item.pid === 100022)?.scopeReason).toBe("RUN_PORT_LISTENER");
    expect(observed.unknownProcesses.find(item => item.pid === 100023)?.scopeReason).toBe("CURRENT_CAPTURED_ANCESTRY_MATCH");
    expect(observed.unknownProcesses.find(item => item.pid === 100026)?.scopeReason).toBe("PROJECT_OR_RUN_PROFILE_MATCH");
    expect(observed.opaqueUnscopedCandidates.find(item => item.pid === 100012)).toMatchObject({ createdAt: null, scopeReason: "UNSCOPED_OPAQUE_NAMED_CANDIDATE" });
    expect(observed.scopeLimitations).toContain("HISTORICAL_PARENT_PID_IS_NOT_TERMINATION_AUTHORITY");
    expect(observed.diagnosticCollectorCandidates.map(item => [item.pid, item.scopeKnownNonProjectProfile])).toEqual([
      [100017, false], [100018, false], [100019, false],
    ]);
    expect(observed.excludedDiagnosticCollectorCandidates).toEqual([]);
    expect(JSON.stringify(observed)).not.toMatch(/fixture-forward|fixture-backward|CommandLine|unit-profile/);
  });

  it("records actual collector birth/direct caller proof and reports a real conhost observation or NOT_OBSERVED without inferring history", async () => {
    if (process.platform !== "win32") { await assertUnsupportedNativeMeasurement(); return; }
    const wrapper = captureWindowsRuntime(3100).processes.find(item => item.pid === process.pid);
    expect(wrapper).toBeDefined();
    const observed = captureWindowsScopedResiduals({ projectRoot: path.resolve("."), profilePaths: [], identities: [], wrapperIdentity: wrapper! });
    expect(observed.diagnosticCollector).toMatchObject({ parentPid: process.pid, identityVerified: true, directCallerVerified: true,
      callerIdentity: { pid: process.pid, createdAt: wrapper!.createdAt }, ownershipGranted: false, terminationAuthorized: false });
    expect(observed.diagnosticCollector.pid).not.toBe(process.pid);
    expect(observed.diagnosticCollectorObservation).toBe(observed.excludedDiagnosticCollectorCandidates.length ? "OBSERVED" : "NOT_OBSERVED");
    for (const row of observed.excludedDiagnosticCollectorCandidates) {
      expect(row).toMatchObject({ name: "conhost.exe", parentPid: observed.diagnosticCollector.pid,
        ownershipGranted: false, terminationAuthorized: false });
      expect(observed.rawUnknownProcesses).toContainEqual(expect.objectContaining({ pid: row.pid, createdAt: row.createdAt }));
      expect(observed.ownedProcesses.some(owned => owned.pid === row.pid)).toBe(false);
    }
    process.stdout.write(`COLLECTOR_PRIMITIVE=${JSON.stringify({ status: observed.diagnosticCollectorObservation,
      collector: observed.diagnosticCollector, excluded: observed.excludedDiagnosticCollectorCandidates })}\n`);
  });

  it("actual generated PowerShell rejects a TCP provider permission failure; unsupported platforms cannot claim port0", async () => {
    if (process.platform !== "win32") { await assertUnsupportedNativeMeasurement(); return; }
    expect(() => captureWindowsRuntime(3100, (command, args, options) => {
      const nativeArgs = args as string[];
      const provider = "function Get-CimInstance { @() }; function Get-NetTCPConnection { [CmdletBinding()] param() Write-Error -Message 'SYNTHETIC_NATIVE_PROVIDER_ACCESS_DENIED' -Category PermissionDenied }; ";
      expect(nativeArgs[3]).toContain("Get-NetTCPConnection -ErrorAction Stop");
      expect(nativeArgs[3]).not.toContain("SilentlyContinue");
      return spawnSync(command as string, [...nativeArgs.slice(0, 3), provider + nativeArgs[3]], options as never);
    })).toThrow("进程/端口诊断失败");
  });

  it("actual generated PowerShell validates empty/exact listening results; unsupported platforms remain unmeasured", async () => {
    if (process.platform !== "win32") { await assertUnsupportedNativeMeasurement(); return; }
    const capture = (rows: string) => captureWindowsRuntime(3100, (command, args, options) => {
      const nativeArgs = args as string[];
      const provider = `function Get-CimInstance { @() }; function Get-NetTCPConnection { [CmdletBinding()] param() ${rows} }; `;
      return spawnSync(command as string, [...nativeArgs.slice(0, 3), provider + nativeArgs[3]], options as never);
    });
    expect(capture("@()")).toEqual({ processes: [], ports: [] });
    expect(capture("@([pscustomobject]@{LocalPort=3100;OwningProcess=20;State='Listen'},[pscustomobject]@{LocalPort=3101;OwningProcess=21;State='Listen'},[pscustomobject]@{LocalPort=3100;OwningProcess=22;State='Established'})"))
      .toEqual({ processes: [], ports: [{ port: 3100, pid: 20, state: "LISTEN" }] });
  });

  it("terminates the live root tree before killing its parent, and uses recorded orphan identity after parent exit", () => {
    const identities = [processRow(20, 1), processRow(21, 20), processRow(22, 21)];
    expect(planWindowsTreeTermination(identities, identities, 20)).toEqual([20]);
    expect(planWindowsTreeTermination(identities.slice(1), identities, 20)).toEqual([21]);
    expect(planWindowsTreeTermination([processRow(20, 1, "reused"), ...identities.slice(1)], identities, 20)).toEqual([21]);
    expect(planWindowsTreeTermination([processRow(20, 1, "reused")], identities, 20)).toEqual([]);
  });

  it("orders captured handles leaf-first and rejects unknown, duplicate or wrapper PID identities before native execution", () => {
    const stamp = "2026-09-30T12:00:00.1234560Z";
    const identities = [processRow(20, 1, stamp), processRow(21, 20, stamp), processRow(22, 21, stamp)];
    expect(orderOwnedProcessesLeafFirst(identities, 999).map(item => item.pid)).toEqual([22, 21, 20]);
    const execute = vi.fn();
    for (const invalid of [processRow(0, 1, stamp), processRow(process.pid, 1, stamp), processRow(20, 1, ""), processRow(20, 1, "not-a-date")]) {
      expect(() => terminateWindowsOwnedProcesses([invalid], execute)).toThrow("未知物理身份");
    }
    expect(execute).not.toHaveBeenCalled();
    expect(() => orderOwnedProcessesLeafFirst([identities[0], identities[0]], 999)).toThrow("重复");
    expect(() => orderOwnedProcessesLeafFirst([processRow(20, 21, stamp), processRow(21, 20, stamp)], 999)).toThrow("循环");
  });

  it("retains native handles before birth validation, validates every identity before Kill, and fails closed on a live reused PID", () => {
    const execute = vi.fn().mockReturnValue({ status: 0, stdout: '{"terminatedPids":[20],"exitedPids":[21]}' });
    expect(terminateWindowsOwnedProcesses([processRow(20, 1, "2026-09-30T12:00:00.1234560Z")], execute))
      .toEqual({ terminatedPids: [20], exitedPids: [21] });
    const [command, args] = execute.mock.calls[0];
    expect(command).toBe("powershell.exe");
    const script = Buffer.from(args[3], "base64").toString("utf16le");
    expect(script.indexOf("$process.Handle")).toBeLessThan(script.indexOf("$process.StartTime"));
    expect(script.indexOf("LIVE_PROCESS_BIRTH_MISMATCH")).toBeLessThan(script.indexOf("$process.Kill()"));
    expect(script).toContain("[DateTimeOffset]::ParseExact");
    expect(script).toContain("$exited += [int]$identity.pid; continue");
    expect(script).toContain("finally { foreach ($process in $handles) { $process.Dispose() }");
    expect(script).not.toContain("taskkill");
    execute.mockReturnValue({ status: 1, stderr: "LIVE_PROCESS_BIRTH_MISMATCH" });
    expect(() => terminateWindowsOwnedProcesses([processRow(20, 1, "2026-09-30T12:00:00.1234560Z")], execute)).toThrow("禁止猜测 PID");
  });

  it("captures port ownership and process identity without command lines or environment", () => {
    const execute = vi.fn().mockReturnValue({ status: 0, stdout: '{"processes":[],"ports":[]}', stderr: "" });
    expect(captureWindowsRuntime(3100, execute)).toEqual({ processes: [], ports: [] });
    const [command, args, options] = execute.mock.calls[0];
    expect(command).toBe("powershell.exe");
    expect(args.join(" ")).toContain("Get-NetTCPConnection -ErrorAction Stop");
    expect(args.join(" ")).toContain("[int]$_.LocalPort -eq 3100");
    expect(args.join(" ")).not.toMatch(/CommandLine|EnvironmentVariables/);
    expect(options).toMatchObject({ windowsHide: true, timeout: 15000 });
    expect(() => captureWindowsRuntime(0, execute)).toThrow("无效 E2E 端口");
  });

  it("redacts actual cookies, authentication headers and credential fields from failure logs", () => {
    const log = 'Error\n  - cookie: veridia_local_session=live-session\n  Authorization: Bearer live-auth\npassword: live-password\n{"api_key":"live-key"}\nPOST /health?token=live-query\nactual-env-secret';
    const safe = redactE2eDiagnosticText(log, ["actual-env-secret"]);
    for (const secret of ["live-session", "live-auth", "live-password", "live-key", "live-query", "actual-env-secret"]) expect(safe).not.toContain(secret);
    expect(safe).toContain("Error");
    expect(safe).toContain("/health");
  });

  it("redacts multiline metadata before JSON escapes its header lines", () => {
    const metadata = {
      infrastructureError: "Call log:\n  - authorization: Bearer nested-bearer\n  - cookie: veridia_local_session=nested-session",
      nested: { headers: { authorization: "Bearer header-bearer", cookie: "header-session" }, diagnostic: "safe" },
    };
    const source = JSON.stringify(redactE2eDiagnosticValue(metadata));
    for (const secret of ["nested-bearer", "nested-session", "header-bearer", "header-session"]) expect(source).not.toContain(secret);
    expect(JSON.parse(source).nested.diagnostic).toBe("safe");
  });

  it("server observer records an unhandled rejection without suppressing the real Node failure", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-observer-unit-"));
    try {
      const result = spawnSync(process.execPath, ["--require", path.resolve("scripts/testing/e2e-server-observer.cjs"),
        "-e", "Promise.reject(new Error('secret=observer-private-fixture'));"], {
        env: { ...process.env, VERIDIA_E2E: "true", E2E_PORT: "3100", VERIDIA_E2E_SERVER_DIAGNOSTIC_DIR: directory },
        encoding: "utf8", windowsHide: true, timeout: 3000,
      });
      expect(result.status).toBe(1);
      const files = fs.readdirSync(directory).filter(name => name.endsWith(".json"));
      expect(files).toHaveLength(1);
      const source = fs.readFileSync(path.join(directory, files[0]), "utf8");
      expect(source).not.toContain("observer-private-fixture");
      const diagnostic = JSON.parse(source);
      expect(diagnostic).toMatchObject({ state: "EXITED", exitCode: 1 });
      expect(diagnostic.events.some((event: { event: string }) => event.event === "unhandledRejection" || event.event === "uncaughtException")).toBe(true);
    } finally {
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) throw new Error("Unexpected observer fixture cleanup path");
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
