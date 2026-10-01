import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { beginCiVerificationWindow, exportCiMachineEvidence, projectOwnedRunEvidence, projectPlaywrightEvidence, projectVerificationEvidence,
  projectVitestEvidence, readGitHubVerificationContext, validateOwnedRunEvidence } from "../../scripts/testing/ci-machine-evidence.mjs";
import { NEXT_TRACE_SINGLE_FLIGHT_PATCH } from "../../scripts/testing/next-trace-single-flight.mjs";
import { BUILD_LOCK_DIAGNOSTICS_POLICY } from "../../scripts/testing/build-lock-diagnostics.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const counts = { total: 1, executed: 1, passed: 1, failed: 0, notRun: 0 };
const time = "2026-09-30T10:00:00.000Z";
const context = { source: "SYNTHETIC_UNIT_TEST" as const, runId: "36679749018", runAttempt: 1, sha: "a".repeat(40), job: "verify" };
const markerStart = "2026-09-30T09:59:59.000Z", unitModified = "2026-09-30T10:00:00.010Z";
const processIdentity = { pid: 200, parentPid: 100, name: "node.exe", createdAt: time, workingSetBytes: 1234 };
const nativeBirth = "2026-09-30T10:00:00.0000000Z";
const quiescenceIdentity = { pid: 200, parentPid: 100, name: "node.exe", createdAt: nativeBirth };
const ownershipScope = "CAPTURED_NATIVE_BIRTH_LINEAGES_WITH_LIVE_PARENT_PERIODIC_OBSERVATION";
const runtime = (label: string, capturedAt: string, empty = false) => ({ label, capturedAt,
  processes: empty ? [] : [processIdentity], ports: empty ? [] : [{ port: 32100, pid: 200, state: "Listen" }] });
function runFixture() {
  return { schemaVersion: 2, runId: "2026-09-30T10-00-01-000Z-DATA_RULES-abcdef12", isolationGroup: "DATA_RULES",
    status: "PASSED", cleaned: true, ...counts, executionSummary: { ...counts, retryCount: 0 },
    startedAt: "2026-09-30T10:00:01.000Z", finishedAt: "2026-09-30T10:00:08.000Z", cleanupReason: "completed",
    port: 32100, serverPid: 100, testProcessPid: 300, repeatEach: 1, requestRetries: 0, httpConnection: "close",
    serverExitedDuringTests: false, unexpectedServerOwnershipChange: false,
    cases: [{ file: "tests/e2e/example.spec.ts", title: "example", status: "PASSED" }],
    runtimeBeforeTests: runtime("before-tests", "2026-09-30T10:00:02.000Z"),
    runtimeAfterTests: runtime("after-tests", "2026-09-30T10:00:05.000Z"),
    runtimeBeforeCleanup: runtime("before-cleanup", "2026-09-30T10:00:06.000Z"),
    runtimeAfterCleanup: runtime("after-cleanup", "2026-09-30T10:00:07.000Z", true),
    generationIdleCheck: { status: "PASSED", idle: true, capturedBeforePhysicalTeardown: true,
      observedAt: "2026-09-30T10:00:04.000Z", elapsedMs: 20, observations: 1,
      counts: { effectiveRunnerCount: 0, activeExtractionCount: 0, pendingCleanupBarrierCount: 0, pendingLifecycleOperationCount: 0, pendingPrismaTransactionCount: 0 },
      physicalCloseState: null, physicalCloseFencePresent: false, activeBrowserOwnerGenerations: [],
      ownerState: "NO_RETAINED_OWNER", ownerAfterPhysicalTeardown: "RELEASED_BY_OWNED_TEARDOWN",
      transactionMeasurementScope: "APP_LIB_SINGLETON_EXPLICIT_TRANSACTIONS",
      prismaTransactionCheck: { status: "PASSED", measurement: "AVAILABLE", coverageScope: "APP_LIB_SINGLETON_EXPLICIT_TRANSACTIONS",
        singletonRegistered: true, wrapperIntact: true, pendingTransactionCount: 0, observedTransactionCount: 3,
        settledTransactionCount: 3, observedBatchTransactionCount: 1, observedInteractiveTransactionCount: 2, observedOtherTransactionCount: 0 } },
    resourceLeakCheck: { status: "PASSED", passed: true, ownedProcessCount: 0, listeningPortCount: 0, profilesRemoved: true },
    postE2eQuiescence: { schemaVersion: 1, status: "PASSED", runId: "2026-09-30T10-00-01-000Z-DATA_RULES-abcdef12", group: "DATA_RULES",
      head: context.sha, sourceFingerprint: "b".repeat(64), observedAt: "2026-09-30T10:00:07.000Z", ownershipScope,
      observation: { status: "PASSED", sampleCount: 2, intervalMs: 1000, maxGapMs: 1100, coverage: "SAMPLED_NOT_EXHAUSTIVE" },
      logicalIdleStatus: "PASSED", capturedBeforePhysicalTeardown: true, finalOwnedProcessCount: 0, portCount: 0, unknownResidualCount: 0,
      profilesRemoved: true, nextEnvRestored: true, typeCleanupPass: true, elapsedMs: 100, deadlineMs: 1000,
      allCapturedIdentities: [quiescenceIdentity], retiredProcessTrees: [{ rootPid: 200, retiredAt: "2026-09-30T10:00:07.000Z", ownedProcessCount: 0, identities: [quiescenceIdentity] }] } };
}
function nativeFixture() {
  return { config: { version: "1.0", workers: 2, fullyParallel: false, metadata: { actualWorkers: 2 },
    projects: [{ id: "chromium", name: "chromium", retries: 0, repeatEach: 1, timeout: 45000 }] },
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0, startTime: "2026-09-30T10:00:02.000Z", duration: 2000 },
    errors: [], suites: [{ title: "example.spec.ts", file: "example.spec.ts", specs: [{ id: "native-spec-id", title: "example", file: "example.spec.ts", ok: true,
      tests: [{ projectId: "chromium", projectName: "chromium", status: "expected", expectedStatus: "passed", timeout: 45000,
        results: [{ status: "passed", duration: 2000, retry: 0, startTime: "2026-09-30T10:00:02.000Z", workerIndex: 0, parallelIndex: 0, errors: [] }] }] }] }] };
}
function prepareReceiptFixture(root: string) {
  const invocationId = "fixture-owned-prepare";
  const processQuiescence = { measurement: "NOT_RUN", reason: "NO_CHILD_LAUNCHED", scope: "NOT_RUN", capturedIdentityCount: null, remainingCapturedIdentityCount: null };
  return { schemaVersion: 1, purpose: "FORMAL_NEXT_PREPARE_LIFECYCLE", status: "PASSED", invocationId,
    receiptPath: path.resolve(root, `.playwright/typegen-lifecycle/${invocationId}/receipt.json`), creatorPid: 100,
    head: context.sha, sourceFingerprint: "b".repeat(64), sourceFingerprintAfter: "b".repeat(64),
    startedAt: "2026-09-30T10:00:08.100Z", finishedAt: "2026-09-30T10:00:08.200Z", elapsedMs: 100,
    formalDistDir: ".next", execution: "SKIPPED_NOT_NEEDED", processQuiescence,
    nextTracePatch: { state: "ALREADY_PATCHED", version: NEXT_TRACE_SINGLE_FLIGHT_PATCH.nextVersion, outputSha256: NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256 },
    typegen: { status: "PASSED", execution: "SKIPPED_NOT_NEEDED", executed: false, nativeRoot: null, exitCode: null, processQuiescence } };
}
const diagnosticInvocation = "11111111-1111-4111-8111-111111111111";
const diagnosticNonce = "22222222-2222-4222-8222-222222222222";
const diagnosticRelative = `.playwright/build-lock-diagnostics/run-${diagnosticInvocation}/receipt.json`;
const supportPaths = {
  controller: "scripts/testing/build-lock-diagnostics.mjs",
  declaration: "scripts/testing/build-lock-diagnostics.d.mts",
  watcher: "scripts/testing/windows-trace-rm-watcher.ps1",
  monitor: "scripts/testing/build-trace-failure-monitor.cjs",
  wrapper: "scripts/testing/verify.mjs",
} as const;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function diagnosticReceiptFixture(root: string) {
  // Fully explicit synthetic receipt: this tests reader/export admission only,
  // not actual Windows Build/native-handle or Restart Manager integration.
  const support = Object.fromEntries(Object.entries(supportPaths).map(([key, relativePath]) => [key,
    { relativePath, sha256: digest(fs.readFileSync(path.join(root, relativePath))) }]));
  const reporter = { version: NEXT_TRACE_SINGLE_FLIGHT_PATCH.nextVersion, beginSha256: NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256,
    measurement: "ACTUAL_INSTALLED_COMPILED_REPORTER", endSha256: NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256 };
  const beginReporter = { version: reporter.version, beginSha256: reporter.beginSha256, measurement: reporter.measurement };
  const nativeIdentity = (pid: number) => ({ pid, nativeStartFileTime: "134036136080000001" });
  return { schemaVersion: 1, purpose: "FORMAL_BUILD_FAILURE_ONLY_RM_DIAGNOSTICS", invocationId: diagnosticInvocation, nonce: diagnosticNonce,
    head: context.sha, sourceFingerprint: "b".repeat(64), label: "FORMAL_VERIFY_TRACE", platform: "win32",
    target: path.join(root, ".next/trace"), status: "PASSED", startedAt: "2026-09-30T10:00:08.000Z", endedAt: "2026-09-30T10:00:08.900Z",
    policy: { ...BUILD_LOCK_DIAGNOSTICS_POLICY }, support, supportIdentity: digest(JSON.stringify({ support, reporter: beginReporter })), reporter,
    ready: { worker: nativeIdentity(402), supervisor: nativeIdentity(401), guardian: nativeIdentity(403), creatorNode: nativeIdentity(400),
      readyAt: "2026-09-30T10:00:08.050Z", firstQueryValid: true, targetExistsAtReady: false },
    nativeBuild: { status: "EXIT0", exitStatus: 0, startedAt: "2026-09-30T10:00:08.300Z", endedAt: "2026-09-30T10:00:08.600Z", primaryError: null },
    native: { samples: 2, ownerStateChanges: 1, maxGapMs: 75, maxQueryMs: 1, meanQueryMs: 1, rmQueryErrors: 0, rmEndResult: 0,
      workerStartedAt: "2026-09-30T10:00:08.000Z", workerEndedAt: "2026-09-30T10:00:08.650Z",
      lastQueryEndedAt: "2026-09-30T10:00:08.620Z", workerStopReason: "STOP_SIGNAL",
      workerExitConfirmed: true, workerForced: false, creatorForceStopped: false,
      supervisor: { pid: 401, actualCloseObserved: true, exitCode: 0, signal: null, spawnError: null },
      guardian: { pid: 403, actualCloseObserved: true, exitCode: 0, signal: null, spawnError: null } },
    diagnosticsFailures: [], coverage: BUILD_LOCK_DIAGNOSTICS_POLICY.coverage, originalIncidentHolder: "NOT_OBSERVED_NO_ATTRIBUTION",
    releaseRemoteExport: "NOT_IMPLEMENTED", retention: "COMPACT_SUCCESS", failureMembers: [] as Array<{ relativePath: string; sha256: string; bytes: number; kind: string }> };
}
function diagnosticBinding(receipt: ReturnType<typeof diagnosticReceiptFixture>) {
  return { status: receipt.status, invocationId: receipt.invocationId, receiptRelativePath: diagnosticRelative, receiptSha256: digest(JSON.stringify(receipt)) };
}
function verificationFixture(root = process.cwd()) {
  return { mode: "FULL", passed: true, failures: [], gitHead: context.sha, sourceFingerprint: "b".repeat(64), sourceChangedDuringVerification: false,
    e2eTotal: 1, e2eExecuted: 1, e2ePassed: 1, e2eFailed: 0, e2eNotRun: 0,
    unitTests: { total: 1, passed: 1 }, selectedE2eFiles: ["tests/e2e/example.spec.ts"],
    e2eGroups: [{ name: "DATA_RULES", files: ["tests/e2e/example.spec.ts"], ...counts, status: "PASSED" }],
    protectedRegression: "PASSED", protectedGroups: ["EXAMPLE"],
    protectedBehaviors: [{ key: "EXAMPLE", status: "PASSED", cases: [{ file: "tests/e2e/example.spec.ts", title: "example", status: "PASSED" }] }],
    lint: "PASSED", typecheck: "PASSED", productionBuild: "PASSED", standaloneRuntime: "PASSED", sqliteFreshMigration: "PASSED",
    sqliteLegacyUpgrade: "PASSED", postgresValidate: "PASSED", sensitiveScan: "PASSED", gitDiffCheck: "PASSED",
    postE2eProcessQuiescence: { status: "PASSED", head: context.sha, sourceFingerprint: "b".repeat(64),
      observedAt: "2026-09-30T10:00:08.000Z", ownershipScope, coverage: "SAMPLED_NOT_EXHAUSTIVE", capturedIdentityCount: 1,
      ownedProcessCount: 0, portCount: 0, unknownProcessCount: 0, observations: 1, elapsedMs: 100, deadlineMs: 30000, portsChecked: [3100, 32100] },
    formalNextPreparation: { status: "PASSED", invocationId: "fixture-owned-prepare", head: context.sha, sourceFingerprint: "b".repeat(64),
      execution: "SKIPPED_NOT_NEEDED", receiptSha256: createHash("sha256").update(JSON.stringify(prepareReceiptFixture(root))).digest("hex"), patchedReporterSha256: NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256,
      nativeMeasurement: "NOT_RUN", nativeScope: "NOT_RUN", capturedIdentityCount: null, remainingCapturedIdentityCount: null },
    buildLockDiagnostics: diagnosticBinding(diagnosticReceiptFixture(root)),
    timings: [{ name: "All unit tests", seconds: 1, passed: true }, { name: "E2E DATA_RULES", seconds: 5, passed: true },
      { name: "Desktop health", seconds: 1, passed: true }] };
}
function vitestFixture() {
  return { success: true, numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0,
    numTotalTestSuites: 1, numPassedTestSuites: 1, numFailedTestSuites: 0, numPendingTestSuites: 0, startTime: Date.parse(time),
    testResults: [{ name: "tests/unit/example.test.ts", status: "passed", startTime: Date.parse(time), endTime: Date.parse(time) + 5,
      assertionResults: [{ title: "example", fullName: "example", ancestorTitles: [], status: "passed", duration: 1, failureMessages: [] as string[] }] }] };
}
function sourceRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-ci-machine-")); roots.push(root); return root;
}
function writeJson(root: string, relative: string, value: unknown, modifiedAt = "2026-09-30T10:00:09.000Z") {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value)); fs.utimesSync(file, new Date(modifiedAt), new Date(modifiedAt)); return file;
}
function completeSources(root: string) {
  beginWindow(root);
  // Only the five approved public source files are read/copied. The fake CI root
  // never resolves .env, credentials, business payloads or a database.
  for (const relative of Object.values(supportPaths)) {
    const target = path.join(root, relative); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.resolve(relative), target);
  }
  writeJson(root, ".playwright/vitest-full-all.json", vitestFixture(), unitModified);
  const run = runFixture();
  writeJson(root, `.playwright/e2e-runs/${run.runId}/run.json`, run);
  writeJson(root, `.playwright/e2e-runs/${run.runId}/playwright-results.json`, nativeFixture(), "2026-09-30T10:00:04.010Z");
  writeJson(root, ".playwright/typegen-lifecycle/fixture-owned-prepare/receipt.json", prepareReceiptFixture(root), "2026-09-30T10:00:08.210Z");
  writeJson(root, diagnosticRelative, diagnosticReceiptFixture(root), "2026-09-30T10:00:08.950Z");
  writeJson(root, ".playwright/verification-full.json", verificationFixture(root));
  return run;
}
function beginWindow(root: string, mode: "affected" | "full" = "full") {
  const result = beginCiVerificationWindow({ root, mode, context, now: () => new Date(markerStart) });
  const file = path.join(root, result.relativePath);
  fs.utimesSync(file, new Date(markerStart), new Date(markerStart));
  return file;
}
const exportEvidence = (root: string, mode: "affected" | "full" = "full") => exportCiMachineEvidence({ root, mode, context, secrets: [] });
function writeDiagnosticReceipt(root: string, receipt: ReturnType<typeof diagnosticReceiptFixture>, verification = verificationFixture(root)) {
  verification.buildLockDiagnostics = diagnosticBinding(receipt);
  writeJson(root, diagnosticRelative, receipt, "2026-09-30T10:00:08.950Z");
  writeJson(root, ".playwright/verification-full.json", verification);
}
function failedDiagnosticFixture(root: string) {
  const receipt = diagnosticReceiptFixture(root);
  receipt.retention = "FAILED_EVIDENCE_RETAINED";
  Object.assign(receipt.nativeBuild, { status: "FAILED", exitStatus: 1, primaryError: { name: "Error", code: "EBUSY" } });
  const common = { invocationId: receipt.invocationId, nonce: receipt.nonce, target: receipt.target, label: receipt.label,
    supportIdentity: receipt.supportIdentity, pid: 402, nativeStartFileTime: receipt.ready.worker.nativeStartFileTime,
    emitterRole: "Worker", emitterPid: receipt.ready.worker.pid, emitterNativeStartFileTime: receipt.ready.worker.nativeStartFileTime,
    utc: "2026-09-30T10:00:08.500Z", qpcTicks: "1000", qpcFrequency: "10000000" };
  const nextPid = 404, entry = path.join(root, "node_modules/next/dist/bin/next");
  const monitor = { invocationId: receipt.invocationId, nonce: receipt.nonce, target: receipt.target, pid: nextPid, parentPid: 400,
    observedAt: "2026-09-30T10:00:08.500Z", hrtimeTicks: "1000", clock: "NODE_HRTIME_EXCEPTION_OBSERVATION_NOT_KERNEL_SYSCALL_TIME",
    entry, monitorSha256: receipt.support.monitor.sha256 };
  const members = [
    { name: "owners.jsonl", kind: "RM_OWNER_CHANGES", record: { ...common, event: "state-owner-change", sample: 1, state: "RM_RESOURCE_USERS_OBSERVED",
      queryStartUtc: "2026-09-30T10:00:08.450Z", queryEndUtc: "2026-09-30T10:00:08.500Z", queryElapsedMs: 50,
      queryStartQpcTicks: "500", queryEndQpcTicks: "1000", rmEndResult: 0,
      holders: [{ pid: 405, nativeStartFileTime: "134036136080000002", rmName: "Node", metadata: {
        identity: "MATCHED_RM_PID_AND_NATIVE_FILETIME", processName: "node.exe", parentPid: 400,
        sanitizedCommandLine: "node --token=DO_NOT_EXPORT_TOKEN", error: "authorization=DO_NOT_EXPORT_AUTH" } }],
      env: { arbitrary: "DO_NOT_EXPORT_ENV" }, privateBody: "DO_NOT_EXPORT_BODY" } },
    { name: `monitor-ready-${nextPid}-33333333-3333-4333-8333-333333333333.json`, kind: "OWNED_LIFECYCLE",
      record: { ...monitor, observedAt: "2026-09-30T10:00:08.300Z", kind: "monitor-ready" } },
    { name: `trace-ebusy-${nextPid}-44444444-4444-4444-8444-444444444444.json`, kind: "EXACT_TRACE_FATAL_OBSERVATION",
      record: { ...monitor, kind: "trace-ebusy", code: "EBUSY", errno: -4082, syscall: "open",
        message: "token=DO_NOT_EXPORT_TOKEN", physicalStack: "Authorization: Bearer DO_NOT_EXPORT_BEARER",
        opaqueFailurePayload: "DO_NOT_EXPORT_PAYLOAD" } },
    { name: `monitor-exit-${nextPid}-55555555-5555-4555-8555-555555555555.json`, kind: "OWNED_LIFECYCLE",
      record: { ...monitor, observedAt: "2026-09-30T10:00:08.600Z", kind: "monitor-exit", exitCode: 1 } },
  ];
  for (const member of members) {
    const relativePath = `${path.posix.dirname(diagnosticRelative)}/${member.name}`, file = path.join(root, relativePath);
    const bytes = Buffer.from(JSON.stringify(member.record) + "\n"); fs.writeFileSync(file, bytes);
    fs.utimesSync(file, new Date("2026-09-30T10:00:08.700Z"), new Date("2026-09-30T10:00:08.700Z"));
    receipt.failureMembers.push({ relativePath, kind: member.kind, sha256: digest(bytes), bytes: bytes.length });
  }
  return receipt;
}

describe("CI machine evidence retention", () => {
  it("projects native fields without inherited env, arbitrary payloads, credentials or private paths", () => {
    const native = nativeFixture();
    Object.assign(native.config, { env: { innocentLookingName: "unrecognized-inherited-private-value" },
      webServer: { env: { AUTH_SECRET: "fixture-auth-secret", PRIVATE_KEY_PATH: "private-key-path" } }, stdout: "free-config-payload" });
    Object.assign(native.config.projects[0], { env: { other: "project-private-value" }, use: { extraHTTPHeaders: { Cookie: "private-cookie" } } });
    Object.assign(native.suites[0].specs[0].tests[0].results[0], { stdout: ["Authorization: Bearer private-bearer"],
      stderr: ["fixture-auth-secret"], attachments: [{ body: "private-attachment" }], error: { message: "private-failure-message" } });
    const safe = projectPlaywrightEvidence(native, ["fixture-auth-secret"]), encoded = JSON.stringify(safe);
    for (const value of ["unrecognized-inherited-private-value", "fixture-auth-secret", "private-key-path", "free-config-payload",
      "project-private-value", "private-cookie", "private-bearer", "private-attachment", "private-failure-message"]) expect(encoded).not.toContain(value);
    expect(encoded).toContain("native-spec-id"); expect(encoded).toContain('"workerIndex":0');
    expect(encoded).toContain('"parallelIndex":0'); expect(encoded).toContain('"timeoutMs":45000');
    expect(encoded).toContain('"repeatEachIndex":null'); expect(encoded).toContain("NOT_SERIALIZED");
  });
  it("omits free-text run/unit/verification errors while retaining failed statuses and counts", () => {
    const run = { ...runFixture(), status: "FAILED", infrastructureError: "authorization: Bearer private-bearer\ncookie: private-cookie", arbitrary: "unknown-private-body" };
    const unit = vitestFixture(); unit.testResults[0].assertionResults[0].failureMessages.push("private-unit-payload");
    Object.assign(unit, { message: "private-suite-message", env: { unrecognized: "private-unit-env" } });
    const verification = { ...verificationFixture(), passed: false, failureDetails: [{ summary: "private-verify-message" }] };
    const encoded = JSON.stringify([projectOwnedRunEvidence(run), projectVitestEvidence(unit), projectVerificationEvidence(verification)]);
    for (const secret of ["private-bearer", "private-cookie", "unknown-private-body", "private-unit-payload", "private-suite-message", "private-unit-env", "private-verify-message"]) expect(encoded).not.toContain(secret);
    expect(encoded).toContain('"failureMessageCount":1'); expect(encoded).toContain('"failurePayloadPresent":true'); expect(encoded).toContain('"sourcePassed":false');
  });
  it("distinguishes observed numeric zero from missing, null, strings and booleans", () => {
    for (const invalid of [undefined, null, "0", false, -1, 0.5]) {
      const run = runFixture(); Object.assign(run.resourceLeakCheck, { ownedProcessCount: invalid });
      const safe = projectOwnedRunEvidence(run);
      expect(safe.resourceLeakCheck).toMatchObject({ ownedProcessCount: null });
      expect(validateOwnedRunEvidence(safe, projectPlaywrightEvidence(nativeFixture())).status).toBe("NOT_RUN");
    }
    expect(projectOwnedRunEvidence(runFixture()).resourceLeakCheck).toMatchObject({ ownedProcessCount: 0, listeningPortCount: 0 });
  });
  it("preserves actual prekill balanced transaction and postcleanup physical-zero proof", () => {
    const run = projectOwnedRunEvidence(runFixture()), native = projectPlaywrightEvidence(nativeFixture());
    expect(validateOwnedRunEvidence(run, native)).toEqual({ status: "PASSED", issues: [] });
    expect(run.generationIdleCheck).toMatchObject({ counts: { pendingPrismaTransactionCount: 0 },
      prismaTransactionCheck: { observedTransactionCount: 3, settledTransactionCount: 3, pendingTransactionCount: 0 } });
    expect(run.runtimeAfterCleanup).toMatchObject({ processes: [], ports: [] });
  });
  it("cannot turn missing ledger, changed ownership, leaked resources or postkill observations green", () => {
    const mutations = [
      (r: ReturnType<typeof runFixture>) => { Object.assign(r.generationIdleCheck.prismaTransactionCheck, { settledTransactionCount: 2 }); },
      (r: ReturnType<typeof runFixture>) => { Object.assign(r.generationIdleCheck.prismaTransactionCheck, { pendingTransactionCount: null }); },
      (r: ReturnType<typeof runFixture>) => { r.unexpectedServerOwnershipChange = true; },
      (r: ReturnType<typeof runFixture>) => { r.runtimeAfterCleanup.processes.push(processIdentity); },
      (r: ReturnType<typeof runFixture>) => { r.generationIdleCheck.observedAt = "2026-09-30T10:00:08.000Z"; },
      (r: ReturnType<typeof runFixture>) => { Object.assign(r.runtimeAfterCleanup, { processes: undefined }); },
    ];
    for (const mutate of mutations) { const run = runFixture(); mutate(run); expect(validateOwnedRunEvidence(projectOwnedRunEvidence(run), projectPlaywrightEvidence(nativeFixture())).status).not.toBe("PASSED"); }
  });
  it("cannot hide a failed/skipped/retried native execution or a duplicate native identity", () => {
    for (const change of ["failed", "skipped", "retry", "duplicate"]) {
      const native = nativeFixture(), test = native.suites[0].specs[0].tests[0];
      if (change === "retry") test.results[0].retry = 1;
      else if (change === "duplicate") native.suites[0].specs.push(structuredClone(native.suites[0].specs[0]));
      else test.results[0].status = change;
      expect(validateOwnedRunEvidence(projectOwnedRunEvidence(runFixture()), projectPlaywrightEvidence(native)).status).not.toBe("PASSED");
    }
  });
  it("cannot turn missing quiescence history or an unavailable pre-build fence green", () => {
    const run = runFixture(); Object.assign(run, { postE2eQuiescence: undefined });
    expect(validateOwnedRunEvidence(projectOwnedRunEvidence(run), projectPlaywrightEvidence(nativeFixture())).status).toBe("NOT_RUN");
    const root = sourceRoot(); completeSources(root);
    const verification = verificationFixture(root); verification.postE2eProcessQuiescence.unknownProcessCount = 1;
    writeJson(root, ".playwright/verification-full.json", verification);
    expect(exportEvidence(root).status).toBe("NOT_RUN");
  });
  it("exports only whitelisted completed run reports and keeps raw native hashes unchanged", () => {
    const root = sourceRoot(), run = completeSources(root);
    const nativePath = path.join(root, `.playwright/e2e-runs/${run.runId}/playwright-results.json`);
    const before = fs.readFileSync(nativePath), sha256 = createHash("sha256").update(before).digest("hex");
    fs.writeFileSync(path.join(root, `.playwright/e2e-runs/${run.runId}/private.pem`), "must-not-read-private-key");
    fs.writeFileSync(path.join(root, `.playwright/e2e-runs/${run.runId}/veridia-e2e.db`), "must-not-read-db");
    fs.writeFileSync(path.join(root, ".env"), "must-not-read-env");
    const result = exportEvidence(root);
    expect(result.status).toBe("PASSED"); expect(result.index.files).toHaveLength(7);
    expect(result.index.files.find(value => value.path.endsWith("playwright-results.json"))?.source).toMatchObject({ sha256 });
    expect(fs.readFileSync(nativePath)).toEqual(before);
    expect(JSON.stringify(result.index)).not.toMatch(/must-not-read|private\.pem|veridia-e2e\.db|\.env/u);
    const copy = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, `e2e/${run.runId}/run.json`), "utf8"));
    expect(copy.evidence.resourceLeakCheck).toMatchObject({ ownedProcessCount: 0, listeningPortCount: 0, profilesRemoved: true });
    const diagnostic = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, "build-lock-diagnostics.json"), "utf8"));
    const actualBytes = fs.readFileSync(path.join(root, diagnosticRelative));
    expect(diagnostic.source).toMatchObject({ sha256: digest(actualBytes), bytes: actualBytes.length });
    expect(diagnostic.evidence).toMatchObject({ status: "PASSED", nativeBuild: { status: "EXIT0", exitStatus: 0 },
      readiness: { worker: { pid: 402 }, guardian: { pid: 403 }, creatorNode: { pid: 400 } }, originalIncidentHolder: "NOT_OBSERVED_NO_ATTRIBUTION" });
  });
  it("requires an exact regular Build diagnostic receipt and actual SHA, never a foreign or missing path", () => {
    for (const change of ["missing", "foreign", "wrong-invocation", "changed-bytes", "wrong-hash", "hardlink"]) {
      const root = sourceRoot(); completeSources(root); const verification = verificationFixture(root);
      const receiptPath = path.join(root, diagnosticRelative);
      if (change === "missing") fs.unlinkSync(receiptPath);
      else if (change === "foreign") verification.buildLockDiagnostics.receiptRelativePath = ".playwright/foreign/receipt.json";
      else if (change === "wrong-invocation") verification.buildLockDiagnostics.invocationId = "66666666-6666-4666-8666-666666666666";
      else if (change === "changed-bytes") fs.appendFileSync(receiptPath, "\n");
      else if (change === "wrong-hash") verification.buildLockDiagnostics.receiptSha256 = "c".repeat(64);
      else fs.linkSync(receiptPath, path.join(root, "linked-diagnostic.json"));
      writeJson(root, ".playwright/verification-full.json", verification);
      const result = exportEvidence(root);
      expect(result.status, change).toBe("NOT_RUN");
      expect(result.index.issues, change).toContain("BUILD_LOCK_DIAGNOSTICS_UNIQUE_RECEIPT_OR_MEMBERS_UNAVAILABLE_OR_UNBOUND");
      expect(result.index.files.some(member => member.path === "build-lock-diagnostics.json"), change).toBe(false);
    }
  });
  it("requires all five fixed approved support paths with actual unchanged single-file hashes", () => {
    for (const change of ["missing", "changed", "hardlink", "foreign-canonical-path", "extra-support", "support-binding"]) {
      const root = sourceRoot(); completeSources(root); const receipt = diagnosticReceiptFixture(root);
      const approved = path.join(root, supportPaths.controller);
      if (change === "missing") fs.unlinkSync(approved);
      else if (change === "changed") fs.appendFileSync(approved, "\n// synthetic source drift\n");
      else if (change === "hardlink") fs.linkSync(approved, path.join(root, "linked-support.mjs"));
      else if (change === "foreign-canonical-path") {
        fs.copyFileSync(approved, path.join(root, "scripts/testing/foreign-controller.mjs"));
        Object.assign(receipt.support.controller, { relativePath: "scripts/testing/foreign-controller.mjs" });
        const reporter = { version: receipt.reporter.version, beginSha256: receipt.reporter.beginSha256, measurement: receipt.reporter.measurement };
        receipt.supportIdentity = digest(JSON.stringify({ support: receipt.support, reporter }));
      } else if (change === "extra-support") Object.assign(receipt.support, { arbitrary: receipt.support.controller });
      else receipt.supportIdentity = "c".repeat(64);
      // Preserve the original verification summary if an approved support file
      // is missing, instead of reading or inventing a replacement source.
      const verification = JSON.parse(fs.readFileSync(path.join(root, ".playwright/verification-full.json"), "utf8"));
      writeDiagnosticReceipt(root, receipt, verification);
      expect(exportEvidence(root).status, change).toBe("NOT_RUN");
    }
  });
  it("never accepts missing policy, native identities, close evidence or uncovered/reversed Build windows", () => {
    const mutations: Array<(receipt: ReturnType<typeof diagnosticReceiptFixture>) => void> = [
      receipt => { Reflect.deleteProperty(receipt, "policy"); },
      receipt => { receipt.policy.graceMs++; },
      receipt => { Reflect.deleteProperty(receipt.ready.worker, "nativeStartFileTime"); },
      receipt => { Reflect.deleteProperty(receipt.ready.guardian, "nativeStartFileTime"); },
      receipt => { receipt.native.guardian.actualCloseObserved = false; },
      receipt => { receipt.native.supervisor.exitCode = 1; },
      receipt => { Reflect.deleteProperty(receipt.native, "workerStartedAt"); },
      receipt => { Reflect.deleteProperty(receipt.native, "workerEndedAt"); },
      receipt => { Reflect.deleteProperty(receipt.native, "lastQueryEndedAt"); },
      receipt => { receipt.native.rmQueryErrors = 1; },
      receipt => { receipt.native.workerStopReason = "LEASE_EXPIRED"; },
      receipt => { Object.assign(receipt.nativeBuild, { exitStatus: null }); },
      receipt => { Reflect.deleteProperty(receipt.nativeBuild, "startedAt"); },
      receipt => { receipt.nativeBuild.startedAt = "2026-09-30T10:00:08.010Z"; },
      receipt => { receipt.nativeBuild.endedAt = "2026-09-30T10:00:08.200Z"; },
      receipt => { receipt.nativeBuild.endedAt = "2026-09-30T10:00:09.500Z"; },
      receipt => { receipt.endedAt = "2026-09-30T10:00:09.500Z"; },
      receipt => { receipt.reporter.endSha256 = NEXT_TRACE_SINGLE_FLIGHT_PATCH.originalSha256; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const root = sourceRoot(); completeSources(root); const receipt = diagnosticReceiptFixture(root); mutate(receipt);
      writeDiagnosticReceipt(root, receipt);
      expect(exportEvidence(root).status, `missing or inconsistent diagnostic field ${index}`).toBe("NOT_RUN");
    }
  });
  it("does not equate complete diagnostics with a successful native Build", () => {
    const root = sourceRoot(); completeSources(root); const receipt = failedDiagnosticFixture(root);
    // The collector is complete, but the synthetic native Build failed. An
    // inconsistent PASSED verification must not export this as Build success.
    expect(receipt.status).toBe("PASSED");
    writeDiagnosticReceipt(root, receipt);
    const result = exportEvidence(root);
    expect(result.status).toBe("NOT_RUN");
    expect(result.index.issues).toContain("BUILD_LOCK_DIAGNOSTICS_UNIQUE_RECEIPT_OR_MEMBERS_UNAVAILABLE_OR_UNBOUND");
    expect(result.index.files.some(file => file.path === "build-lock-diagnostics.json")).toBe(false);
  });
  it("retains a synthetic failed Build bundle with safe projections and exact raw member hashes, never sourcePassed=true", () => {
    const root = sourceRoot(); completeSources(root); const receipt = failedDiagnosticFixture(root), verification = verificationFixture(root);
    verification.passed = false; verification.productionBuild = "FAILED";
    writeDiagnosticReceipt(root, receipt, verification);
    const result = exportEvidence(root);
    expect(result.status).toBe("FAILED");
    const exported = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, "verification.json"), "utf8"));
    expect(exported.evidence.sourcePassed).toBe(false);
    expect(result.index.files.some(member => member.path === "build-lock-diagnostics.json")).toBe(true);
    for (const [index, member] of receipt.failureMembers.entries()) {
      const safe = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, `build-lock-failure/${String(index + 1).padStart(2, "0")}.json`), "utf8"));
      expect(safe.source).toMatchObject({ relativePath: member.relativePath, sha256: digest(fs.readFileSync(path.join(root, member.relativePath))), bytes: member.bytes });
      expect(safe.evidence.kind).toBe(member.kind);
      expect(JSON.stringify(safe)).not.toMatch(/DO_NOT_EXPORT|opaqueFailurePayload|privateBody|"env"/u);
    }
    const fatal = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, "build-lock-failure/03.json"), "utf8"));
    expect(fatal.evidence.records[0]).toMatchObject({ code: "EBUSY", errno: -4082, syscall: "open", pid: 404 });
  });
  it("rejects failure members with wrong nonce, kind, window, content hash, monitor or support binding", () => {
    const mutations = [
      ...[0, 1, 2, 3].flatMap(memberIndex => ["nonce", "invocation", "target", "window", "manifest-kind"]
        .map(change => ({ memberIndex, change }))),
      ...[1, 2, 3].flatMap(memberIndex => ["record-kind", "monitor-hash", "entry", "pid", "clock"]
        .map(change => ({ memberIndex, change }))),
      ...["missing", "hash", "hardlink"].map(change => ({ memberIndex: 2, change })),
      { memberIndex: 0, change: "support" },
    ];
    for (const { memberIndex, change } of mutations) {
      const root = sourceRoot(); completeSources(root); const receipt = failedDiagnosticFixture(root);
      const member = receipt.failureMembers[memberIndex], file = path.join(root, member.relativePath), label = `${memberIndex}:${change}`;
      if (change === "missing") fs.unlinkSync(file);
      else if (change === "hash") member.sha256 = "c".repeat(64);
      else if (change === "hardlink") fs.linkSync(file, path.join(root, "linked-member.json"));
      else if (change === "manifest-kind") member.kind = member.kind === "OWNED_LIFECYCLE" ? "RM_OWNER_CHANGES" : "OWNED_LIFECYCLE";
      else {
        const record = JSON.parse(fs.readFileSync(file, "utf8"));
        if (change === "nonce") record.nonce = "66666666-6666-4666-8666-666666666666";
        else if (change === "invocation") record.invocationId = "66666666-6666-4666-8666-666666666666";
        else if (change === "target") record.target = path.join(root, "foreign-trace");
        else if (change === "window") record[memberIndex === 0 ? "utc" : "observedAt"] = "2026-09-30T10:00:10.000Z";
        else if (change === "record-kind") record.kind = record.kind === "monitor-ready" ? "monitor-exit" : "monitor-ready";
        else if (change === "monitor-hash") record.monitorSha256 = "c".repeat(64);
        else if (change === "entry") record.entry = path.join(root, "foreign-next");
        else if (change === "pid") record.pid = 405;
        else if (change === "clock") record.clock = "KERNEL_SYSCALL_TIME";
        else record.supportIdentity = "c".repeat(64);
        const bytes = Buffer.from(JSON.stringify(record) + "\n"); fs.writeFileSync(file, bytes); member.sha256 = digest(bytes); member.bytes = bytes.length;
      }
      const verification = verificationFixture(root); verification.passed = false; verification.productionBuild = "FAILED";
      writeDiagnosticReceipt(root, receipt, verification);
      const result = exportEvidence(root);
      expect(result.status, label).toBe("FAILED");
      expect(result.index.issues, label).toContain("BUILD_LOCK_DIAGNOSTICS_UNIQUE_RECEIPT_OR_MEMBERS_UNAVAILABLE_OR_UNBOUND");
      expect(result.index.files.some(file => file.path.startsWith("build-lock-failure/")), label).toBe(false);
    }
  });
  it("does not normalize missing raw typegen measurements into an explicit native skip", () => {
    for (const field of ["nativeMeasurement", "nativeScope", "capturedIdentityCount", "remainingCapturedIdentityCount"]) {
      const root = sourceRoot(); completeSources(root);
      const verification = verificationFixture(root);
      Reflect.deleteProperty(verification.formalNextPreparation, field);
      writeJson(root, ".playwright/verification-full.json", verification);
      expect(exportEvidence(root).index.issues).toContain("FORMAL_PREPARE_UNIQUE_RECEIPT_UNAVAILABLE_OR_UNBOUND");
    }
  });
  it("requires the actual unique prepare file, unchanged bytes and a single regular ownership path", () => {
    for (const change of ["missing", "changed", "hardlink", "foreign-hash"]) {
      const root = sourceRoot(); completeSources(root);
      const receiptPath = path.join(root, ".playwright/typegen-lifecycle/fixture-owned-prepare/receipt.json");
      if (change === "missing") fs.unlinkSync(receiptPath);
      else if (change === "changed") writeJson(root, path.relative(root, receiptPath), { ...prepareReceiptFixture(root), elapsedMs: 99 }, "2026-09-30T10:00:08.210Z");
      else if (change === "hardlink") fs.linkSync(receiptPath, path.join(path.dirname(receiptPath), "owned-alias.json"));
      else {
        const verification = verificationFixture(root); verification.formalNextPreparation.receiptSha256 = "c".repeat(64);
        writeJson(root, ".playwright/verification-full.json", verification);
      }
      const result = exportEvidence(root);
      expect(result.status).toBe("NOT_RUN");
      expect(result.index.issues).toContain("FORMAL_PREPARE_UNIQUE_RECEIPT_UNAVAILABLE_OR_UNBOUND");
    }
  });
  it("reports missing and ambiguous/stale completed-run bindings NOT_RUN rather than green", () => {
    const missing = sourceRoot(); expect(exportEvidence(missing).status).toBe("NOT_RUN");
    const stale = sourceRoot(), run = completeSources(stale);
    run.startedAt = "2026-09-29T10:00:01.000Z";
    writeJson(stale, `.playwright/e2e-runs/${run.runId}/run.json`, run);
    expect(exportEvidence(stale).status).toBe("NOT_RUN");
    const ambiguous = sourceRoot(), first = completeSources(ambiguous), other = { ...first, runId: `${first.runId}-other` };
    writeJson(ambiguous, `.playwright/e2e-runs/${other.runId}/run.json`, other);
    expect(exportEvidence(ambiguous).status).toBe("NOT_RUN");
  });
  it("retains a genuine verification failure without exporting its error payload as PASS", () => {
    const root = sourceRoot(); completeSources(root);
    writeJson(root, ".playwright/verification-full.json", { ...verificationFixture(root), passed: false, failureDetails: [{ summary: "private-error-payload" }] });
    const result = exportEvidence(root);
    expect(result.status).toBe("FAILED"); expect(fs.readFileSync(path.join(result.outputDirectory, "verification.json"), "utf8")).not.toContain("private-error-payload");
  });
  it("keeps nested Vitest suite totals distinct from report file entries and retains actual Desktop health", () => {
    const root = sourceRoot(); completeSources(root);
    const unit = vitestFixture(); unit.numTotalTestSuites = 2; unit.numPassedTestSuites = 2;
    writeJson(root, ".playwright/vitest-full-all.json", unit, unitModified);
    const result = exportEvidence(root);
    expect(result.status).toBe("PASSED");
    const copy = JSON.parse(fs.readFileSync(path.join(result.outputDirectory, "vitest-all.json"), "utf8"));
    expect(copy.evidence.numTotalTestSuites).toBe(2); expect(copy.evidence.testResults).toHaveLength(1);
    expect(projectVerificationEvidence(verificationFixture()).gates).toMatchObject({ desktopHealth: "PASSED", desktopHealthSource: "timings:Desktop health" });
    const missingDesktop = verificationFixture(root); missingDesktop.timings = missingDesktop.timings.filter(value => value.name !== "Desktop health");
    writeJson(root, ".playwright/verification-full.json", missingDesktop);
    expect(exportEvidence(root).status).toBe("NOT_RUN");
  });
  it("requires an explicit current CI context and an exclusive actual-start marker", () => {
    const root = sourceRoot(); completeSources(root);
    expect(exportCiMachineEvidence({ root, mode: "full", secrets: [] }).status).toBe("NOT_RUN");
    expect(() => beginWindow(root)).toThrow();
    const markerFile = path.join(root, `.playwright/ci-verification-window-${context.runId}-${context.runAttempt}-${context.job}-full.json`);
    fs.unlinkSync(markerFile);
    expect(exportEvidence(root).status).toBe("NOT_RUN");
    const publicEnv = { GITHUB_ACTIONS: "true", GITHUB_RUN_ID: context.runId, GITHUB_RUN_ATTEMPT: "1", GITHUB_SHA: context.sha,
      GITHUB_JOB: context.job, UNRECOGNIZED_SECRET: "must-never-copy-env" };
    expect(readGitHubVerificationContext(publicEnv)).toEqual({ ...context, source: "GITHUB_ACTIONS" });
    expect(JSON.stringify(readGitHubVerificationContext(publicEnv))).not.toContain("must-never-copy-env");
    for (const changed of [{ GITHUB_ACTIONS: "false" }, { GITHUB_RUN_ATTEMPT: "0" }, { GITHUB_RUN_ATTEMPT: "1.0" },
      { GITHUB_RUN_ID: "not-a-run" }, { GITHUB_SHA: "not-a-sha" }, { GITHUB_JOB: "../other-job" }]) {
      expect(() => readGitHubVerificationContext({ ...publicEnv, ...changed })).toThrow("CI_CONTEXT_UNAVAILABLE");
    }
  });
  it("rejects a marker for another mode, job, SHA, run, attempt or invalid actual-start identity", () => {
    for (const changed of ["mode", "job", "sha", "runId", "runAttempt", "nonce", "startedAt"]) {
      const root = sourceRoot(); completeSources(root);
      const relative = `.playwright/ci-verification-window-${context.runId}-${context.runAttempt}-${context.job}-full.json`;
      const marker = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
      if (changed === "mode") marker.mode = "AFFECTED";
      else if (changed === "nonce") marker.nonce = "invalid-nonce";
      else if (changed === "startedAt") marker.startedAt = "2026-09-30T10:00:10.000Z";
      else Object.assign(marker.context, { [changed]: changed === "runAttempt" ? 2 : changed === "sha" ? "b".repeat(40) : changed === "runId" ? "36679749019" : "other" });
      writeJson(root, relative, marker, markerStart);
      expect(exportEvidence(root).status).toBe("NOT_RUN");
    }
  });
  it("does not expand the job window with stale Unit mtime or freshly copied old Unit content", () => {
    for (const changed of ["stale-mtime", "late-mtime", "old-content", "missing-report-start", "reversed-suite"]) {
      const root = sourceRoot(); completeSources(root); const unit = vitestFixture();
      if (changed === "old-content") {
        unit.startTime -= 86400000; unit.testResults[0].startTime -= 86400000; unit.testResults[0].endTime -= 86400000;
      } else if (changed === "missing-report-start") Object.assign(unit, { startTime: null });
      else if (changed === "reversed-suite") unit.testResults[0].endTime = unit.testResults[0].startTime - 1;
      writeJson(root, ".playwright/vitest-full-all.json", unit, changed === "stale-mtime" ? "2026-09-29T10:00:00.010Z" :
        changed === "late-mtime" ? "2026-09-30T10:00:10.000Z" : unitModified);
      expect(exportEvidence(root).status).toBe("NOT_RUN");
    }
  });
  it("requires measured finite Unit durations without confusing numeric zero or ULP precision", () => {
    for (const duration of [undefined, null, "0", false, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const root = sourceRoot(); completeSources(root); const unit = vitestFixture();
      Object.assign(unit.testResults[0].assertionResults[0], { duration });
      writeJson(root, ".playwright/vitest-full-all.json", unit, unitModified);
      expect(exportEvidence(root).status).toBe("NOT_RUN");
    }
    const root = sourceRoot(); completeSources(root); const unit = vitestFixture();
    unit.testResults[0].assertionResults[0].duration = 0;
    writeJson(root, ".playwright/vitest-full-all.json", unit, unitModified);
    expect(exportEvidence(root).status).toBe("PASSED");
    unit.testResults[0].endTime = unit.testResults[0].startTime + 2.362548828125;
    unit.testResults[0].assertionResults[0].duration = 2.3626000000000005;
    writeJson(root, ".playwright/vitest-full-all.json", unit, unitModified);
    expect(exportEvidence(root).status).toBe("PASSED");
  });
  it("rejects old native content copied into a fresh run and measurements outside its real test window", () => {
    for (const changed of ["old-content", "stats-start", "stats-duration", "attempt-start", "attempt-duration", "stale-mtime", "late-mtime"]) {
      const root = sourceRoot(), run = completeSources(root), native = nativeFixture(), attempt = native.suites[0].specs[0].tests[0].results[0];
      if (changed === "old-content") { native.stats.startTime = "2026-09-29T10:00:02.000Z"; attempt.startTime = native.stats.startTime; }
      else if (changed === "stats-start") native.stats.startTime = "2026-09-30T10:00:06.000Z";
      else if (changed === "stats-duration") native.stats.duration = 10000;
      else if (changed === "attempt-start") attempt.startTime = "2026-09-30T10:00:06.000Z";
      else if (changed === "attempt-duration") attempt.duration = 10000;
      writeJson(root, `.playwright/e2e-runs/${run.runId}/playwright-results.json`, native,
        changed === "stale-mtime" ? "2026-09-29T10:00:04.010Z" : changed === "late-mtime" ? "2026-09-30T10:00:10.000Z" : "2026-09-30T10:00:04.010Z");
      expect(exportEvidence(root).status).toBe("NOT_RUN");
    }
  });
  it("cannot pass native executions with missing identity, worker, parallel or finite duration", () => {
    for (const changed of ["spec-id", "project-id", "worker", "parallel", "duration", "stats-duration"]) {
      const root = sourceRoot(), run = completeSources(root), native = nativeFixture(), spec = native.suites[0].specs[0], test = spec.tests[0];
      if (changed === "spec-id") Object.assign(spec, { id: undefined });
      else if (changed === "project-id") Object.assign(test, { projectId: undefined });
      else if (changed === "worker") Object.assign(test.results[0], { workerIndex: undefined });
      else if (changed === "parallel") Object.assign(test.results[0], { parallelIndex: undefined });
      else if (changed === "duration") Object.assign(test.results[0], { duration: null });
      else Object.assign(native.stats, { duration: null });
      writeJson(root, `.playwright/e2e-runs/${run.runId}/playwright-results.json`, native, "2026-09-30T10:00:04.010Z");
      expect(exportEvidence(root).status).toBe("NOT_RUN");
    }
  });
  it("binds an affected E2E-only job without inventing selected Unit execution", () => {
    const root = sourceRoot(); completeSources(root); beginWindow(root, "affected");
    const verification = verificationFixture(root); verification.mode = "AFFECTED"; verification.unitTests = { total: 0, passed: 0 };
    verification.timings = verification.timings.filter(value => value.name === "E2E DATA_RULES");
    writeJson(root, ".playwright/verification-affected.json", verification);
    const result = exportEvidence(root, "affected");
    expect(result.status).toBe("PASSED");
    expect(result.index.unitEvidence).toEqual({ selection: "NOT_SELECTED", reportCount: 0, actualTotal: 0 });
    expect(result.index.files.some(file => file.path.startsWith("vitest-"))).toBe(false);
    expect(result.index.ownedRuns).toHaveLength(1);
  });
  it("workflow retains safe post-job evidence without uploading raw hidden run/env/database trees", () => {
    const workflow = fs.readFileSync(path.resolve(".github/workflows/veridia-ci.yml"), "utf8");
    expect(workflow).toContain("node scripts/testing/ci-machine-evidence.mjs --mode=");
    expect(workflow).toContain("node scripts/testing/ci-machine-evidence.mjs begin --mode=");
    const exporter = /      - name: 导出安全机器验证证据\r?\n([\s\S]*?)(?=\r?\n      - name:)/u.exec(workflow)?.[1];
    const upload = /      - name: 上传检查日志\r?\n([\s\S]*)$/u.exec(workflow)?.[1];
    expect(exporter).toBeDefined(); expect(upload).toBeDefined();
    expect(exporter).toContain("if: always()"); expect(upload).toContain("if: always()");
    expect(upload).toContain("uses: actions/upload-artifact@v4");
    const paths = /          path: \|\r?\n([\s\S]*?)(?=\r?\n          [a-z-]+:)/u.exec(upload ?? "")?.[1]
      .split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    expect(paths).toEqual(["artifacts/ci-logs", "artifacts/e2e-diagnostics", "artifacts/ci-machine", "playwright-report", "test-results"]);
    expect(upload).not.toMatch(/\.playwright|\.env|\*\*|\.db|\.pem|include-hidden-files:\s*true/u);
    expect(workflow.indexOf("导出安全机器验证证据")).toBeGreaterThan(workflow.indexOf("RELEASE_FULL 门禁"));
    expect(workflow.indexOf("记录实际 CI 验证窗口")).toBeLessThan(workflow.indexOf("affected 变更影响门禁"));
    expect(workflow.indexOf("上传检查日志")).toBeGreaterThan(workflow.indexOf("导出安全机器验证证据"));
  });
});
