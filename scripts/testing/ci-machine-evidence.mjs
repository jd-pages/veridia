import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { redactE2eDiagnosticText } from "./e2e-server-infrastructure.mjs";
import { NEXT_TRACE_SINGLE_FLIGHT_PATCH } from "./next-trace-single-flight.mjs";
import { readFormalNextPrepareEvidence } from "./formal-next-prepare-evidence.mjs";
import { readBuildLockDiagnosticsEvidence } from "./build-lock-diagnostics.mjs";

// Post-verification retention only. Never copy a source object wholesale:
// Playwright's native JSON includes inherited webServer.env, and failure
// payloads may contain cookies, credentials or application data.
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const number = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const bool = value => typeof value === "boolean" ? value : null;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const array = value => Array.isArray(value) ? value : null;
const status = (value, allowed) => allowed.includes(value) ? value : "NOT_RUN";
const text = (value, secrets) => typeof value === "string" ? redactE2eDiagnosticText(value, secrets) : null;
const fields = (value, names, transform) => Object.fromEntries(names.map(name => [name, transform(value?.[name])]));
const counterNames = ["total", "executed", "passed", "failed", "notRun"];
const executionNames = [...counterNames, "retryCount"];
const logicalNames = ["effectiveRunnerCount", "activeExtractionCount", "pendingCleanupBarrierCount", "pendingLifecycleOperationCount", "pendingPrismaTransactionCount"];
const transactionNames = ["pendingTransactionCount", "observedTransactionCount", "settledTransactionCount", "observedBatchTransactionCount", "observedInteractiveTransactionCount", "observedOtherTransactionCount"];
const knownSecrets = () => [process.env.AUTH_SECRET, process.env.EXTENSION_TOKEN, process.env.OPENAI_API_KEY].filter(Boolean);
const labels = (values, secrets) => array(values)?.map(value => text(value, secrets)) ?? null;
const modes = ["affected", "full"];
const utcDate = value => date(value) !== null && new Date(value).toISOString() === value ? value : null;
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value) ? value : null;
const hash = (value, length) => typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`, "u").test(value) ? value : null;

function projectQuiescence(input, secrets) {
  const value = object(input);
  const identity = item => ({ pid: positive(item?.pid), parentPid: positive(item?.parentPid), name: text(item?.name, secrets), createdAt: date(item?.createdAt) });
  return { measurement: value ? "AVAILABLE" : "NOT_RUN", schemaVersion: count(value?.schemaVersion),
    status: status(value?.status, ["PASSED", "FAILED", "NOT_APPLICABLE", "NOT_REQUIRED"]),
    runId: text(value?.runId, secrets), group: text(value?.group, secrets), head: hash(value?.head, 40),
    sourceFingerprint: hash(value?.sourceFingerprint, 64), observedAt: date(value?.observedAt),
    ownershipScope: text(value?.ownershipScope, secrets), coverage: text(value?.coverage, secrets),
    observation: { status: status(value?.observation?.status, ["PASSED", "FAILED", "NOT_RUN"]),
      coverage: text(value?.observation?.coverage, secrets), ...fields(value?.observation, ["sampleCount", "intervalMs"], count),
      maxGapMs: number(value?.observation?.maxGapMs) },
    logicalIdleStatus: status(value?.logicalIdleStatus, ["PASSED", "FAILED", "NOT_RUN"]),
    capturedBeforePhysicalTeardown: bool(value?.capturedBeforePhysicalTeardown),
    ...fields(value, ["finalOwnedProcessCount", "portCount", "unknownResidualCount", "capturedIdentityCount", "ownedProcessCount", "unknownProcessCount", "observations"], count),
    profilesRemoved: bool(value?.profilesRemoved), nextEnvRestored: bool(value?.nextEnvRestored), typeCleanupPass: bool(value?.typeCleanupPass),
    elapsedMs: number(value?.elapsedMs), deadlineMs: number(value?.deadlineMs), portsChecked: array(value?.portsChecked)?.map(positive) ?? null,
    allCapturedIdentities: array(value?.allCapturedIdentities)?.map(identity) ?? null,
    retiredProcessTrees: array(value?.retiredProcessTrees)?.map(tree => ({ rootPid: positive(tree?.rootPid), retiredAt: date(tree?.retiredAt),
      ownedProcessCount: count(tree?.ownedProcessCount), identities: array(tree?.identities)?.map(identity) ?? null })) ?? null };
}

function verificationContext(input) {
  const value = object(input);
  if (!["GITHUB_ACTIONS", "SYNTHETIC_UNIT_TEST"].includes(value?.source) ||
    typeof value.runId !== "string" || !/^[1-9][0-9]{0,31}$/u.test(value.runId) || positive(value.runAttempt) === null ||
    typeof value.sha !== "string" || !/^[0-9a-f]{40}$/u.test(value.sha) ||
    typeof value.job !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u.test(value.job)) return null;
  return { source: value.source, runId: value.runId, runAttempt: value.runAttempt, sha: value.sha, job: value.job };
}

export function readGitHubVerificationContext(env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" || !/^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? "")) throw new Error("CI_CONTEXT_UNAVAILABLE");
  const context = verificationContext({ source: "GITHUB_ACTIONS", runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT), sha: env.GITHUB_SHA, job: env.GITHUB_JOB });
  if (!context) throw new Error("CI_CONTEXT_UNAVAILABLE");
  return context;
}

function windowPath(context, mode) {
  return `.playwright/ci-verification-window-${context.runId}-${context.runAttempt}-${context.job}-${mode}.json`;
}

export function beginCiVerificationWindow({ root = process.cwd(), mode, context: inputContext, now }) {
  const context = verificationContext(inputContext);
  if (!modes.includes(mode) || !context || (now && context.source !== "SYNTHETIC_UNIT_TEST")) throw new Error("CI_CONTEXT_UNAVAILABLE");
  const clock = now ? now() : new Date();
  if (!(clock instanceof Date) || !Number.isFinite(clock.getTime())) throw new Error("CI_WINDOW_CLOCK_UNAVAILABLE");
  const marker = { schemaVersion: 1, purpose: "ACTUAL_CI_VERIFICATION_WINDOW", mode: mode.toUpperCase(), context,
    startedAt: clock.toISOString(), nonce: randomUUID() };
  const relativePath = windowPath(context, mode), absolute = assertBoundPath(root, relativePath, true);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  // Exclusive creation: a second begin must not silently move the same job window.
  fs.writeFileSync(absolute, `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx" });
  return { relativePath, marker };
}

function inside(value, lower, upper) {
  return number(value) !== null && number(lower) !== null && number(upper) !== null && lower <= value && value <= upper;
}

function durationFits(start, end, duration) {
  // JSON preserves fractional Vitest durations, while subtracting epoch floats
  // can lose a fraction of a microsecond. Allow only arithmetic ULP precision.
  const precision = Number.EPSILON * Math.max(Math.abs(start), Math.abs(end)) * 2;
  return number(duration) !== null && duration <= end - start + precision;
}

function validateUnitWindow(evidence, source, lower, upper) {
  return source && inside(source.modifiedMs, lower, upper) && inside(evidence.startTime, lower, source.modifiedMs) &&
    evidence.testResults?.length > 0 && evidence.testResults.every(suite =>
      inside(suite.startTime, evidence.startTime, source.modifiedMs) && inside(suite.endTime, suite.startTime, source.modifiedMs) &&
      suite.assertionResults?.length > 0 && suite.assertionResults.every(test => durationFits(suite.startTime, suite.endTime, test.durationMs)));
}

function projectCases(values, secrets) {
  return array(values)?.map(value => ({ file: text(value?.file, secrets), title: text(value?.title, secrets),
    status: status(value?.status, ["PASSED", "FAILED", "NOT_RUN"]) })) ?? null;
}

export function projectVerificationEvidence(input, secrets = []) {
  const report = object(input);
  const desktopTimings = array(report?.timings)?.filter(value => value?.name === "Desktop health");
  const desktopHealth = desktopTimings?.length === 1 && typeof desktopTimings[0].passed === "boolean"
    ? desktopTimings[0].passed ? "PASSED" : "FAILED" : report?.mode === "AFFECTED" && desktopTimings?.length === 0 ? "NOT_REQUIRED" : "NOT_RUN";
  return {
    measurement: report ? "AVAILABLE" : "NOT_RUN",
    gitHead: hash(report?.gitHead, 40), sourceFingerprint: hash(report?.sourceFingerprint, 64),
    sourceChangedDuringVerification: bool(report?.sourceChangedDuringVerification),
    mode: status(report?.mode, ["AFFECTED", "FULL"]), sourcePassed: bool(report?.passed),
    failures: labels(report?.failures, secrets),
    ...fields(report, ["e2eTotal", "e2eExecuted", "e2ePassed", "e2eFailed", "e2eNotRun"], count),
    selectedE2eFiles: labels(report?.selectedE2eFiles, secrets), selectedUnitFiles: labels(report?.selectedUnitFiles, secrets),
    unitTests: fields(report?.unitTests, ["total", "passed"], count),
    e2eGroups: array(report?.e2eGroups)?.map(group => ({ name: text(group?.name, secrets),
      files: labels(group?.files, secrets), ...fields(group, counterNames, count),
      status: status(group?.status, ["PASSED", "FAILED"]) })) ?? null,
    protectedRegression: status(report?.protectedRegression, ["PASSED", "FAILED", "NOT_APPLICABLE"]),
    protectedGroups: labels(report?.protectedGroups, secrets),
    protectedBehaviors: array(report?.protectedBehaviors)?.map(value => ({ key: text(value?.key, secrets),
      status: status(value?.status, ["PASSED", "FAILED"]), cases: projectCases(value?.cases, secrets) })) ?? null,
    postE2eProcessQuiescence: projectQuiescence(report?.postE2eProcessQuiescence, secrets),
    buildLockDiagnostics: {
      status: status(report?.buildLockDiagnostics?.status, ["PASSED", "DIAGNOSTICS_INCOMPLETE", "NOT_APPLICABLE", "NOT_REQUIRED"]),
      invocationId: uuid(report?.buildLockDiagnostics?.invocationId),
      receiptRelativePath: text(report?.buildLockDiagnostics?.receiptRelativePath, secrets),
      receiptSha256: hash(report?.buildLockDiagnostics?.receiptSha256, 64),
    },
    formalNextPreparation: { status: status(report?.formalNextPreparation?.status, ["PASSED", "FAILED", "NOT_RUN", "NOT_REQUIRED"]),
      invocationId: text(report?.formalNextPreparation?.invocationId, secrets), head: hash(report?.formalNextPreparation?.head, 40),
      sourceFingerprint: hash(report?.formalNextPreparation?.sourceFingerprint, 64),
      execution: status(report?.formalNextPreparation?.execution, ["EXECUTED", "SKIPPED_NOT_NEEDED"]),
      receiptSha256: hash(report?.formalNextPreparation?.receiptSha256, 64),
      patchedReporterSha256: hash(report?.formalNextPreparation?.patchedReporterSha256, 64),
      nativeMeasurement: status(report?.formalNextPreparation?.nativeMeasurement, ["AVAILABLE", "NOT_RUN"]),
      nativeScope: text(report?.formalNextPreparation?.nativeScope, secrets),
      capturedIdentityCount: count(report?.formalNextPreparation?.capturedIdentityCount),
      remainingCapturedIdentityCount: count(report?.formalNextPreparation?.remainingCapturedIdentityCount) },
    gates: { ...fields(report, ["lint", "typecheck", "productionBuild", "standaloneRuntime", "sqliteFreshMigration",
      "sqliteLegacyUpgrade", "postgresValidate", "sensitiveScan", "gitDiffCheck"], value => status(value, ["PASSED", "FAILED", "NOT_REQUIRED", "NOT_RUN"])),
    desktopHealth, desktopHealthSource: "timings:Desktop health",
    postE2eProcessQuiescence: status(report?.postE2eProcessQuiescence?.status, ["PASSED", "FAILED", "NOT_REQUIRED", "NOT_APPLICABLE"]),
    formalNextPreparation: status(report?.formalNextPreparation?.status, ["PASSED", "FAILED", "NOT_REQUIRED", "NOT_RUN"]) },
    timings: array(report?.timings)?.map(value => ({ name: text(value?.name, secrets),
      seconds: number(value?.seconds), passed: bool(value?.passed) })) ?? null,
  };
}

export function projectVitestEvidence(input, secrets = []) {
  const report = object(input);
  return { measurement: report ? "AVAILABLE" : "NOT_RUN", success: bool(report?.success),
    ...fields(report, ["numTotalTests", "numPassedTests", "numFailedTests", "numPendingTests",
      "numTotalTestSuites", "numPassedTestSuites", "numFailedTestSuites", "numPendingTestSuites"], count),
    startTime: count(report?.startTime),
    testResults: array(report?.testResults)?.map(suite => ({ name: text(suite?.name, secrets),
      status: status(suite?.status, ["passed", "failed"]), startTime: count(suite?.startTime), endTime: number(suite?.endTime),
      assertionResults: array(suite?.assertionResults)?.map(test => ({ title: text(test?.title, secrets),
        fullName: text(test?.fullName, secrets), ancestorTitles: labels(test?.ancestorTitles, secrets),
        status: status(test?.status, ["passed", "failed", "pending", "skipped", "todo"]),
        durationMs: number(test?.duration), failureMessageCount: array(test?.failureMessages)?.length ?? null })) ?? null })) ?? null };
}

export function projectPlaywrightEvidence(input, secrets = []) {
  const report = object(input);
  const suite = value => ({ title: text(value?.title, secrets), file: text(value?.file, secrets),
    specs: array(value?.specs)?.map(spec => ({ id: text(spec?.id, secrets), title: text(spec?.title, secrets),
      file: text(spec?.file, secrets), ok: bool(spec?.ok),
      tests: array(spec?.tests)?.map(test => ({ projectId: text(test?.projectId, secrets), projectName: text(test?.projectName, secrets),
        status: status(test?.status, ["expected", "unexpected", "flaky", "skipped"]),
        expectedStatus: status(test?.expectedStatus, ["passed", "failed", "skipped"]), timeoutMs: positive(test?.timeout),
        repeatEachIndex: count(test?.repeatEachIndex),
        repeatIndexSource: Object.hasOwn(test ?? {}, "repeatEachIndex") ? (count(test.repeatEachIndex) === null ? "INVALID_REPORT_FIELD" : "REPORT_FIELD") : "NOT_SERIALIZED",
        results: array(test?.results)?.map(result => ({ status: status(result?.status, ["passed", "failed", "timedOut", "skipped", "interrupted"]),
          durationMs: number(result?.duration), retry: count(result?.retry), startTime: date(result?.startTime),
          workerIndex: count(result?.workerIndex), parallelIndex: count(result?.parallelIndex),
          errorCount: array(result?.errors)?.length ?? null, singleErrorPresent: result?.error != null })) ?? null })) ?? null })) ?? null,
    suites: array(value?.suites)?.map(suite) ?? null });
  return { measurement: report ? "AVAILABLE" : "NOT_RUN",
    config: { version: text(report?.config?.version, secrets), workers: positive(report?.config?.workers),
      fullyParallel: bool(report?.config?.fullyParallel), actualWorkers: positive(report?.config?.metadata?.actualWorkers),
      projects: array(report?.config?.projects)?.map(project => ({ id: text(project?.id, secrets), name: text(project?.name, secrets),
        retries: count(project?.retries), repeatEach: positive(project?.repeatEach), timeoutMs: positive(project?.timeout),
        testMatch: labels(project?.testMatch, secrets), testIgnore: labels(project?.testIgnore, secrets) })) ?? null },
    stats: { ...fields(report?.stats, ["expected", "unexpected", "flaky", "skipped"], count),
      startTime: date(report?.stats?.startTime), durationMs: number(report?.stats?.duration) },
    errorCount: array(report?.errors)?.length ?? null,
    suites: array(report?.suites)?.map(suite) ?? null };
}

function projectRuntime(input, secrets) {
  const report = object(input);
  if (!report) return null;
  return { label: text(report.label, secrets), capturedAt: date(report.capturedAt),
    processes: array(report.processes)?.map(value => ({ pid: positive(value?.pid), parentPid: count(value?.parentPid),
      name: text(value?.name, secrets), createdAt: date(value?.createdAt), workingSetBytes: count(value?.workingSetBytes) })) ?? null,
    ports: array(report.ports)?.map(value => ({ pid: positive(value?.pid), port: positive(value?.port),
      state: text(value?.state, secrets) })) ?? null };
}

export function projectOwnedRunEvidence(input, secrets = []) {
  const report = object(input);
  const idle = report?.generationIdleCheck;
  const transaction = idle?.prismaTransactionCheck;
  return { measurement: report ? "AVAILABLE" : "NOT_RUN", schemaVersion: count(report?.schemaVersion),
    runId: text(report?.runId, secrets), isolationGroup: text(report?.isolationGroup, secrets),
    status: status(report?.status, ["PASSED", "FAILED"]), cleaned: bool(report?.cleaned),
    startedAt: date(report?.startedAt), finishedAt: date(report?.finishedAt), cleanupReason: text(report?.cleanupReason, secrets),
    port: positive(report?.port), serverPid: positive(report?.serverPid), testProcessPid: positive(report?.testProcessPid),
    repeatEach: positive(report?.repeatEach), requestRetries: count(report?.requestRetries), httpConnection: text(report?.httpConnection, secrets),
    ...fields(report, counterNames, count),
    executionSummary: fields(report?.executionSummary, executionNames, count),
    cases: projectCases(report?.cases, secrets),
    serverExitedDuringTests: bool(report?.serverExitedDuringTests), unexpectedServerOwnershipChange: bool(report?.unexpectedServerOwnershipChange),
    serverExitCode: count(report?.serverExitCode), serverExitedAt: date(report?.serverExitedAt),
    runtimeBeforeTests: projectRuntime(report?.runtimeBeforeTests, secrets), runtimeAfterTests: projectRuntime(report?.runtimeAfterTests, secrets),
    runtimeBeforeCleanup: projectRuntime(report?.runtimeBeforeCleanup, secrets), runtimeAfterCleanup: projectRuntime(report?.runtimeAfterCleanup, secrets),
    postE2eQuiescence: projectQuiescence(report?.postE2eQuiescence, secrets),
    generationIdleCheck: { status: status(idle?.status, ["PASSED", "FAILED"]), idle: bool(idle?.idle),
      capturedBeforePhysicalTeardown: bool(idle?.capturedBeforePhysicalTeardown), observedAt: date(idle?.observedAt),
      elapsedMs: number(idle?.elapsedMs), observations: count(idle?.observations), counts: fields(idle?.counts, logicalNames, count),
      ownerState: text(idle?.ownerState, secrets), ownerAfterPhysicalTeardown: text(idle?.ownerAfterPhysicalTeardown, secrets),
      activeBrowserOwnerGenerations: array(idle?.activeBrowserOwnerGenerations)?.map(count) ?? null,
      platformBrowserManagers: Object.fromEntries(["XIAOHONGSHU", "DOUYIN"].map(platform => {
        const manager = idle?.platformBrowserManagers?.[platform];
        return [platform, { managerAvailable: bool(manager?.managerAvailable), contextPresent: bool(manager?.contextPresent),
          browserConnected: bool(manager?.browserConnected), contextOwnerGeneration: count(manager?.contextOwnerGeneration),
          lifecycleGeneration: count(manager?.lifecycleGeneration),
          contextOwnershipKind: status(manager?.contextOwnershipKind, ["NONE", "INTERACTIVE", "EXTRACTION"]) }];
      })),
      physicalCloseState: idle?.physicalCloseState === null ? null : status(idle?.physicalCloseState, ["PENDING", "FAILED"]),
      physicalCloseFencePresent: bool(idle?.physicalCloseFencePresent),
      transactionMeasurementScope: text(idle?.transactionMeasurementScope, secrets),
      prismaTransactionCheck: { status: status(transaction?.status, ["PASSED", "PENDING"]),
        measurement: status(transaction?.measurement, ["AVAILABLE", "INVALID", "UNAVAILABLE"]),
        coverageScope: text(transaction?.coverageScope, secrets), singletonRegistered: bool(transaction?.singletonRegistered),
        wrapperIntact: bool(transaction?.wrapperIntact), ...fields(transaction, transactionNames, count) } },
    resourceLeakCheck: { status: status(report?.resourceLeakCheck?.status, ["PASSED", "FAILED", "NOT_APPLICABLE"]),
      passed: bool(report?.resourceLeakCheck?.passed), ownedProcessCount: count(report?.resourceLeakCheck?.ownedProcessCount),
      listeningPortCount: count(report?.resourceLeakCheck?.listeningPortCount), profilesRemoved: bool(report?.resourceLeakCheck?.profilesRemoved) },
    failurePayloadPresent: ["infrastructureError", "cleanupError", "serverError"].some(key => Object.hasOwn(report ?? {}, key)) };
}

function nativeTests(report) {
  const output = [];
  const visit = suite => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) output.push({ spec, test });
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites ?? []) visit(suite);
  return output;
}

function countsPass(report, names = counterNames) {
  return names.every(key => count(report?.[key]) !== null) && report.total > 0 && report.executed === report.total &&
    report.passed === report.total && report.failed === 0 && report.notRun === 0 && (!names.includes("retryCount") || report.retryCount === 0);
}

export function validateOwnedRunEvidence(run, native) {
  const issues = [];
  const require = (valid, label) => { if (!valid) issues.push(label); };
  require(run.measurement === "AVAILABLE" && run.status === "PASSED" && run.cleaned === true, "RUN_NOT_COMPLETED_PASS");
  require(countsPass(run) && countsPass(run.executionSummary, executionNames), "RUN_COUNTS_MISSING_OR_NOT_ALL_PASS");
  require(run.requestRetries === 0 && run.httpConnection === "close", "TRANSPORT_CONTRACT_UNAVAILABLE");
  require(run.serverExitedDuringTests === false && run.unexpectedServerOwnershipChange === false, "SERVER_OWNERSHIP_UNAVAILABLE_OR_CHANGED");
  const idle = run.generationIdleCheck, tx = idle.prismaTransactionCheck;
  require(idle.status === "PASSED" && idle.idle === true && idle.capturedBeforePhysicalTeardown === true &&
    logicalNames.every(key => idle.counts[key] === 0) && idle.physicalCloseState === null && idle.physicalCloseFencePresent === false, "LOGICAL_IDLE_NOT_MEASURED_ZERO");
  require(tx.measurement === "AVAILABLE" && tx.status === "PASSED" && tx.singletonRegistered === true && tx.wrapperIntact === true &&
    tx.coverageScope === "APP_LIB_SINGLETON_EXPLICIT_TRANSACTIONS" && transactionNames.every(key => count(tx[key]) !== null) &&
    tx.pendingTransactionCount === 0 && tx.observedTransactionCount === tx.settledTransactionCount &&
    tx.observedTransactionCount === tx.observedBatchTransactionCount + tx.observedInteractiveTransactionCount + tx.observedOtherTransactionCount,
  "EXPLICIT_SINGLETON_TRANSACTION_LEDGER_UNAVAILABLE_OR_UNBALANCED");
  require(date(idle.observedAt) !== null && date(run.runtimeBeforeCleanup?.capturedAt) !== null && date(run.runtimeAfterCleanup?.capturedAt) !== null &&
    Date.parse(idle.observedAt) <= Date.parse(run.runtimeBeforeCleanup.capturedAt) &&
    Date.parse(run.runtimeBeforeCleanup.capturedAt) <= Date.parse(run.runtimeAfterCleanup.capturedAt), "PREKILL_OBSERVATION_ORDER_UNAVAILABLE");
  require(run.resourceLeakCheck.status === "PASSED" && run.resourceLeakCheck.passed === true &&
    run.resourceLeakCheck.ownedProcessCount === 0 && run.resourceLeakCheck.listeningPortCount === 0 && run.resourceLeakCheck.profilesRemoved === true &&
    Array.isArray(run.runtimeAfterCleanup?.processes) && run.runtimeAfterCleanup.processes.length === 0 &&
    Array.isArray(run.runtimeAfterCleanup?.ports) && run.runtimeAfterCleanup.ports.length === 0, "POSTPHYSICAL_ZERO_UNAVAILABLE");
  const q = run.postE2eQuiescence;
  require(q.status === "PASSED" && q.schemaVersion === 1 && q.runId === run.runId && q.group === run.isolationGroup &&
    q.head !== null && q.sourceFingerprint !== null && date(q.observedAt) !== null &&
    q.ownershipScope === "CAPTURED_NATIVE_BIRTH_LINEAGES_WITH_LIVE_PARENT_PERIODIC_OBSERVATION" &&
    q.observation.status === "PASSED" && q.observation.coverage === "SAMPLED_NOT_EXHAUSTIVE" &&
    positive(q.observation.sampleCount) !== null && positive(q.observation.intervalMs) !== null && number(q.observation.maxGapMs) !== null &&
    q.logicalIdleStatus === "PASSED" && q.capturedBeforePhysicalTeardown === true &&
    q.finalOwnedProcessCount === 0 && q.portCount === 0 && q.unknownResidualCount === 0 &&
    q.profilesRemoved === true && q.nextEnvRestored === true && q.typeCleanupPass === true &&
    number(q.elapsedMs) !== null && positive(q.deadlineMs) !== null && q.elapsedMs <= q.deadlineMs &&
    q.allCapturedIdentities?.length > 0 && q.allCapturedIdentities.every(item => positive(item.pid) !== null && positive(item.parentPid) !== null &&
      typeof item.createdAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(item.createdAt)) &&
    q.retiredProcessTrees?.length > 0 && q.retiredProcessTrees.every(tree => tree.ownedProcessCount === 0 && tree.identities?.length > 0),
  "POST_E2E_QUIESCENCE_RECEIPT_UNAVAILABLE_OR_UNMEASURED");
  const beforePort = run.runtimeBeforeTests?.ports?.[0], afterPort = run.runtimeAfterTests?.ports?.[0];
  const beforeOwner = run.runtimeBeforeTests?.processes?.find(item => item.pid === beforePort?.pid);
  const afterOwner = run.runtimeAfterTests?.processes?.find(item => item.pid === afterPort?.pid);
  require(positive(beforePort?.pid) !== null && beforePort.pid === afterPort?.pid && date(beforeOwner?.createdAt) !== null &&
    beforeOwner.createdAt === afterOwner?.createdAt, "SERVER_PHYSICAL_IDENTITY_UNAVAILABLE_OR_CHANGED");
  const records = nativeTests(native);
  const testWindowStart = Date.parse(run.runtimeBeforeTests?.capturedAt), testWindowEnd = Date.parse(run.runtimeAfterTests?.capturedAt);
  const nativeStart = Date.parse(native.stats.startTime), nativeEnd = nativeStart + native.stats.durationMs;
  require(inside(testWindowStart, Date.parse(run.startedAt), Date.parse(run.finishedAt)) &&
    inside(testWindowEnd, testWindowStart, Date.parse(run.finishedAt)) && inside(nativeStart, testWindowStart, testWindowEnd) &&
    inside(nativeEnd, nativeStart, testWindowEnd) && number(native.stats.durationMs) !== null &&
    records.every(({ test }) => test.results?.every(result => inside(Date.parse(result.startTime), nativeStart, nativeEnd) &&
      durationFits(Date.parse(result.startTime), nativeEnd, result.durationMs))), "NATIVE_CONTENT_OUTSIDE_OWNED_TEST_WINDOW");
  require(native.measurement === "AVAILABLE" && native.errorCount === 0 && native.stats.unexpected === 0 && native.stats.flaky === 0 && native.stats.skipped === 0 &&
    positive(native.config.workers) !== null && positive(native.config.actualWorkers) !== null && typeof native.config.fullyParallel === "boolean" &&
    date(native.stats.startTime) !== null && number(native.stats.durationMs) !== null &&
    native.config.projects?.length > 0 && native.config.projects.every(project => project.retries === 0 && project.repeatEach === run.repeatEach), "NATIVE_REPORT_NOT_ALL_PASS_ZERO_RETRY");
  require(records.length > 0 && records.length === run.executionSummary.total && native.stats.expected === records.length &&
    records.every(({ spec, test }) => typeof spec.id === "string" && spec.id.length > 0 && typeof spec.file === "string" && spec.file.length > 0 &&
      typeof test.projectId === "string" && test.projectId.length > 0 && native.config.projects?.some(project => project.id === test.projectId) &&
      test.repeatIndexSource !== "INVALID_REPORT_FIELD" && spec.ok === true && test.expectedStatus === "passed" &&
      test.status === "expected" && positive(test.timeoutMs) !== null && test.results?.length === 1 && test.results[0].status === "passed" &&
      test.results[0].retry === 0 && test.results[0].errorCount === 0 && test.results[0].singleErrorPresent === false &&
      number(test.results[0].durationMs) !== null && date(test.results[0].startTime) !== null &&
      count(test.results[0].workerIndex) !== null && count(test.results[0].parallelIndex) !== null),
  "NATIVE_ACTUAL_EXECUTIONS_MISSING_FAILED_OR_RETRIED");
  require(new Set(records.map(({ spec, test }) => JSON.stringify([spec.id, test.projectId]))).size === records.length, "NATIVE_EXECUTION_ID_DUPLICATE");
  return { status: issues.length === 0 ? "PASSED" : run.status === "FAILED" || records.some(({ test }) => test.results?.some(result => ["failed", "timedOut", "interrupted"].includes(result.status))) ? "FAILED" : "NOT_RUN", issues };
}

function assertBoundPath(root, relativePath, allowMissing = false) {
  const absolute = path.resolve(root, relativePath);
  if (!absolute.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("REPORT_PATH_OUTSIDE_ROOT");
  let current = path.resolve(root);
  for (const component of path.relative(root, absolute).split(path.sep)) {
    current = path.join(current, component);
    let info;
    try { info = fs.lstatSync(current); }
    catch (error) { if (allowMissing && error?.code === "ENOENT") break; throw error; }
    if (info.isSymbolicLink()) throw new Error("REPORT_LINK_NOT_ALLOWED");
  }
  return absolute;
}

function readOwnedJson(root, relativePath) {
  const absolute = assertBoundPath(root, relativePath);
  const info = fs.statSync(absolute);
  if (!info.isFile() || info.nlink !== 1) throw new Error("REPORT_NOT_SINGLE_OWNED_REGULAR_FILE");
  const bytes = fs.readFileSync(absolute);
  return { value: JSON.parse(bytes.toString("utf8")), source: { path: relativePath.replaceAll("\\", "/"),
    sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length, modifiedAt: info.mtime.toISOString(), modifiedMs: info.mtimeMs } };
}

export function exportCiMachineEvidence({ root = process.cwd(), mode, context: inputContext, secrets = knownSecrets() }) {
  if (!modes.includes(mode)) throw new Error("CI machine evidence mode must be affected or full");
  const context = verificationContext(inputContext);
  const outputDirectory = path.join(root, "artifacts", "ci-machine", mode, `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`);
  assertBoundPath(root, path.relative(root, outputDirectory), true);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const index = { schemaVersion: 2, purpose: "SAFE_POST_VERIFICATION_MACHINE_EVIDENCE", mode: mode.toUpperCase(), context,
    generatedAt: new Date().toISOString(), status: "NOT_RUN", issues: [], files: [], ownedRuns: [],
    transactionScope: "APP_LIB_SINGLETON_EXPLICIT_TRANSACTIONS", nativePoolOrSqlLockAbsenceClaim: false };
  const save = (relative, evidence, source) => {
    const destination = path.join(outputDirectory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, `${JSON.stringify({ source, evidence }, null, 2)}\n`);
    index.files.push({ path: relative.replaceAll("\\", "/"), source });
  };
  const read = relative => {
    try { return readOwnedJson(root, relative); }
    catch { index.issues.push(`REPORT_UNAVAILABLE:${relative}`); return null; }
  };
  const original = read(`.playwright/verification-${mode}.json`);
  const rawWindow = context ? read(windowPath(context, mode)) : null;
  const marker = object(rawWindow?.value), markerContext = verificationContext(marker?.context);
  const lowerBound = utcDate(marker?.startedAt) === null ? null : Date.parse(marker.startedAt);
  const upperBound = original?.source.modifiedMs ?? null;
  const windowAvailable = context !== null && marker?.schemaVersion === 1 && marker?.purpose === "ACTUAL_CI_VERIFICATION_WINDOW" &&
    marker?.mode === mode.toUpperCase() && markerContext !== null && JSON.stringify(markerContext) === JSON.stringify(context) &&
    uuid(marker?.nonce) !== null && lowerBound !== null && inside(rawWindow?.source.modifiedMs, lowerBound, upperBound);
  index.verificationWindow = { measurement: windowAvailable ? "AVAILABLE" : "NOT_RUN", mode: mode.toUpperCase(),
    context: markerContext, startedAt: utcDate(marker?.startedAt), nonce: uuid(marker?.nonce) };
  if (!windowAvailable) index.issues.push("ACTUAL_CI_VERIFICATION_WINDOW_UNAVAILABLE_OR_MISMATCHED");
  save("verification-window.json", index.verificationWindow, rawWindow?.source ?? null);
  const verification = projectVerificationEvidence(original?.value, secrets);
  save("verification.json", verification, original?.source ?? null);
  if (verification.mode !== mode.toUpperCase() || verification.sourcePassed !== true) index.issues.push("VERIFICATION_NOT_ALL_PASS_OR_MODE_MISSING");
  if (verification.gitHead !== context?.sha || verification.sourceFingerprint === null || verification.sourceChangedDuringVerification !== false) index.issues.push("VERIFICATION_SOURCE_IDENTITY_UNAVAILABLE_OR_CHANGED");
  if (!verification.failures || verification.failures.length > 0 || !verification.timings?.length ||
    verification.timings.some(value => value.passed !== true || number(value.seconds) === null)) index.issues.push("VERIFICATION_COMMAND_EVIDENCE_UNAVAILABLE_OR_FAILED");
  const requiredGates = mode === "full" ? Object.keys(verification.gates).filter(key => key !== "desktopHealthSource") : ["lint", "typecheck", "gitDiffCheck"];
  if (requiredGates.some(key => verification.gates[key] !== "PASSED")) index.issues.push("VERIFICATION_REQUIRED_GATE_NOT_PASSED");
  const unitNames = mode === "full" ? ["all"] : [
    ...(verification.timings?.some(value => value.name === "Affected explicit unit") ? ["affected-explicit"] : []),
    ...(verification.timings?.some(value => value.name === "Affected related unit") ? ["affected-related"] : []),
  ];
  const units = unitNames.map(name => {
    const raw = read(`.playwright/vitest-${mode}-${name}.json`);
    const evidence = projectVitestEvidence(raw?.value, secrets);
    save(`vitest-${name}.json`, evidence, raw?.source ?? null);
    const cases = evidence.testResults?.flatMap(suite => suite.assertionResults ?? []) ?? [];
    if (evidence.success !== true || positive(evidence.numTotalTests) === null || evidence.numPassedTests !== evidence.numTotalTests ||
      evidence.numFailedTests !== 0 || evidence.numPendingTests !== 0 || cases.length !== evidence.numTotalTests ||
      positive(evidence.numTotalTestSuites) === null || evidence.numPassedTestSuites !== evidence.numTotalTestSuites ||
      evidence.numFailedTestSuites !== 0 || evidence.numPendingTestSuites !== 0 ||
      evidence.testResults.some(suite => suite.status !== "passed") ||
      cases.some(test => test.status !== "passed" || test.failureMessageCount !== 0)) index.issues.push(`VITEST_NOT_ALL_PASS:${name}`);
    if (!windowAvailable || !validateUnitWindow(evidence, raw?.source, lowerBound, upperBound)) index.issues.push(`VITEST_CONTENT_OUTSIDE_ACTUAL_JOB_WINDOW_OR_UNMEASURED:${name}`);
    return { evidence, source: raw?.source };
  });
  const actualUnitTotal = units.reduce((sum, unit) => sum + (unit.evidence.numTotalTests ?? 0), 0);
  index.unitEvidence = { selection: units.length === 0 ? "NOT_SELECTED" : "SELECTED", reportCount: units.length, actualTotal: actualUnitTotal };
  if (verification.unitTests.total === null || verification.unitTests.passed === null || verification.unitTests.total !== actualUnitTotal ||
    verification.unitTests.passed !== actualUnitTotal || (mode === "full" && actualUnitTotal === 0)) index.issues.push("UNIT_TOTAL_NOT_BOUND_TO_ACTUAL_REPORTS");
  const groups = verification.e2eGroups;
  if (!groups || (mode === "full" && groups.length === 0)) index.issues.push("E2E_GROUPS_UNAVAILABLE");
  const handoff = verification.postE2eProcessQuiescence;
  if (verification.gates.productionBuild === "PASSED" && groups?.length &&
      (handoff.status !== "PASSED" || handoff.head !== context?.sha || handoff.sourceFingerprint !== verification.sourceFingerprint ||
       handoff.coverage !== "SAMPLED_NOT_EXHAUSTIVE" || handoff.ownedProcessCount !== 0 || handoff.portCount !== 0 || handoff.unknownProcessCount !== 0 ||
       positive(handoff.capturedIdentityCount) === null || positive(handoff.observations) === null || !handoff.portsChecked?.includes(3100) ||
       !windowAvailable || !inside(Date.parse(handoff.observedAt), lowerBound, upperBound))) index.issues.push("PRE_BUILD_NATIVE_HANDOFF_UNAVAILABLE_OR_UNBOUND");
  const preparation = verification.formalNextPreparation;
  const lockDiagnostics = verification.buildLockDiagnostics;
  if (lockDiagnostics.receiptRelativePath !== null) {
    try {
      if (!windowAvailable) throw new Error("ACTUAL_BUILD_DIAGNOSTIC_JOB_WINDOW_UNAVAILABLE");
      const measured = readBuildLockDiagnosticsEvidence(lockDiagnostics.receiptRelativePath, { root, head: context.sha,
        sourceFingerprint: verification.sourceFingerprint, startedAt: index.verificationWindow.startedAt, now: original.source.modifiedAt });
      if (lockDiagnostics.receiptSha256 !== measured.source.sha256 || lockDiagnostics.status !== measured.evidence.status ||
        lockDiagnostics.invocationId !== measured.evidence.invocationId) throw new Error("BUILD_DIAGNOSTIC_RAW_RECEIPT_UNBOUND");
      if (verification.gates.productionBuild === "PASSED" &&
          (measured.evidence.nativeBuild?.status !== "EXIT0" || measured.evidence.nativeBuild?.exitStatus !== 0)) {
        throw new Error("NATIVE_FAILED_OR_NOT_RUN_BUILD_CANNOT_BIND_PASSED_PRODUCTION_BUILD");
      }
      // The reader validates the exact invocation and every member, returning
      // only safe whitelists. Never upload raw receipt/holder/monitor objects.
      save("build-lock-diagnostics.json", measured.evidence, measured.source);
      for (const [position, member] of measured.failureMembers.entries()) {
        save(`build-lock-failure/${String(position + 1).padStart(2, "0")}.json`,
          { kind: text(member.kind, secrets), records: member.records }, member.source);
      }
      if (measured.evidence.status !== "PASSED") index.issues.push("BUILD_LOCK_DIAGNOSTICS_NOT_COMPLETE");
    } catch {
      index.issues.push("BUILD_LOCK_DIAGNOSTICS_UNIQUE_RECEIPT_OR_MEMBERS_UNAVAILABLE_OR_UNBOUND");
    }
  }
  if (verification.gates.productionBuild === "PASSED" &&
      (lockDiagnostics.status !== "PASSED" || lockDiagnostics.receiptRelativePath === null || lockDiagnostics.receiptSha256 === null || lockDiagnostics.invocationId === null)) {
    index.issues.push("FORMAL_BUILD_LOCK_DIAGNOSTICS_NOT_EXECUTED_OR_UNMEASURED");
  }
  if (verification.gates.productionBuild === "PASSED") {
    try {
      const raw = original?.value?.formalNextPreparation;
      if (!windowAvailable || typeof raw?.invocationId !== "string" || !/^[A-Za-z0-9_-]+$/u.test(raw.invocationId)) {
        throw new Error("EXACT_PREPARE_INVOCATION_UNAVAILABLE");
      }
      const relative = `.playwright/typegen-lifecycle/${raw.invocationId}/receipt.json`;
      const receipt = readOwnedJson(root, relative);
      const marker = `VERIDIA_FORMAL_NEXT_PREPARE=${JSON.stringify({ invocationId: raw.invocationId,
        receiptPath: path.resolve(root, relative), status: raw.status, execution: raw.execution })}`;
      const measured = readFormalNextPrepareEvidence(marker, { root, head: context.sha,
        sourceFingerprint: verification.sourceFingerprint, startedAt: index.verificationWindow.startedAt,
        now: original.source.modifiedAt });
      const boundFields = ["status", "invocationId", "head", "sourceFingerprint", "execution", "receiptSha256",
        "patchedReporterSha256", "nativeMeasurement", "nativeScope", "capturedIdentityCount", "remainingCapturedIdentityCount"];
      if (boundFields.some(key => !Object.hasOwn(raw, key) || raw[key] !== measured[key]) ||
        measured.receiptSha256 !== receipt.source.sha256 ||
        !inside(receipt.source.modifiedMs, Date.parse(measured.finishedAt), upperBound)) {
        throw new Error("PREPARE_RECEIPT_BYTES_OR_RAW_MEASUREMENT_UNBOUND");
      }
      // Retain only the validated whitelist, never arbitrary receipt fields.
      save("formal-next-prepare.json", projectVerificationEvidence({ formalNextPreparation: measured }, secrets).formalNextPreparation, receipt.source);
    } catch {
      index.issues.push("FORMAL_PREPARE_UNIQUE_RECEIPT_UNAVAILABLE_OR_UNBOUND");
    }
  }
  if (verification.gates.productionBuild === "PASSED" && (preparation.status !== "PASSED" || preparation.head !== context?.sha ||
      preparation.sourceFingerprint !== verification.sourceFingerprint || preparation.receiptSha256 === null || preparation.patchedReporterSha256 !== NEXT_TRACE_SINGLE_FLIGHT_PATCH.patchedSha256 ||
      !["EXECUTED", "SKIPPED_NOT_NEEDED"].includes(preparation.execution) ||
      (preparation.execution === "SKIPPED_NOT_NEEDED" ? preparation.nativeMeasurement !== "NOT_RUN" || preparation.capturedIdentityCount !== null || preparation.remainingCapturedIdentityCount !== null :
       preparation.nativeMeasurement !== "AVAILABLE" || positive(preparation.capturedIdentityCount) === null || preparation.remainingCapturedIdentityCount !== 0))) {
    index.issues.push("FORMAL_PREPARE_RUNTIME_EVIDENCE_UNAVAILABLE_OR_UNBOUND");
  }
  let entries = [];
  const runsRoot = path.join(root, ".playwright", "e2e-runs");
  if (groups?.length) {
    if (!windowAvailable) index.issues.push("VERIFICATION_RUN_WINDOW_UNAVAILABLE");
    else {
      try { assertBoundPath(root, path.relative(root, runsRoot)); entries = fs.readdirSync(runsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()); }
      catch { index.issues.push("OWNED_RUN_DIRECTORY_UNAVAILABLE"); }
    }
  }
  for (const group of groups ?? []) {
    const candidates = [];
    for (const entry of entries) {
      const relative = `.playwright/e2e-runs/${entry.name}/run.json`;
      let candidate;
      try { candidate = readOwnedJson(root, relative); } catch { continue; }
      const run = candidate.value;
      if (run?.runId !== entry.name || run?.isolationGroup !== group.name || date(run.startedAt) === null || date(run.finishedAt) === null ||
        !inside(Date.parse(run.startedAt), lowerBound, upperBound) || !inside(Date.parse(run.finishedAt), Date.parse(run.startedAt), upperBound) ||
        !inside(candidate.source.modifiedMs, Date.parse(run.finishedAt), upperBound)) continue;
      candidates.push(candidate);
    }
    if (candidates.length !== 1) { index.issues.push(`EXACT_COMPLETED_OWNED_RUN_UNAVAILABLE:${group.name}`); continue; }
    const candidate = candidates[0], run = projectOwnedRunEvidence(candidate.value, secrets);
    const rawNative = read(`.playwright/e2e-runs/${candidate.value.runId}/playwright-results.json`);
    const native = projectPlaywrightEvidence(rawNative?.value, secrets);
    const check = validateOwnedRunEvidence(run, native);
    if (run.postE2eQuiescence.head !== context?.sha || run.postE2eQuiescence.sourceFingerprint !== verification.sourceFingerprint ||
        !inside(Date.parse(run.postE2eQuiescence.observedAt), Date.parse(run.startedAt), Date.parse(run.finishedAt))) check.issues.push("QUIESCENCE_RECEIPT_SOURCE_OR_OWNED_WINDOW_UNBOUND");
    if (verification.gates.productionBuild === "PASSED" && Date.parse(handoff.observedAt) < Date.parse(run.finishedAt)) check.issues.push("PRE_BUILD_FENCE_PRECEDES_COMPLETED_GROUP");
    const nativeStart = Date.parse(native.stats.startTime), nativeEnd = nativeStart + native.stats.durationMs;
    if (!windowAvailable || !inside(nativeStart, lowerBound, upperBound) || !inside(nativeEnd, nativeStart, upperBound) ||
      !inside(rawNative?.source.modifiedMs, nativeEnd, Date.parse(run.runtimeAfterTests?.capturedAt)) ||
      !inside(rawNative?.source.modifiedMs, lowerBound, upperBound)) check.issues.push("NATIVE_SOURCE_OUTSIDE_ACTUAL_JOB_OR_OWNED_TEST_WINDOW");
    const actualFiles = new Set(nativeTests(native).map(({ spec }) => path.basename(spec.file ?? "")));
    if (!group.files?.length || actualFiles.size !== group.files.length || group.files.some(file => !actualFiles.has(path.basename(file))) ||
      group.status !== "PASSED" || !countsPass(group) || counterNames.some(key => group[key] !== run[key])) check.issues.push("VERIFICATION_GROUP_NATIVE_BINDING_MISMATCH");
    if (check.issues.length > 0) { index.issues.push(...check.issues.map(issue => `${group.name}:${issue}`)); }
    save(`e2e/${candidate.value.runId}/run.json`, run, candidate.source);
    save(`e2e/${candidate.value.runId}/playwright-results.json`, native, rawNative?.source ?? null);
    index.ownedRuns.push({ runId: run.runId, group: group.name, status: check.issues.length === 0 ? "PASSED" : check.status === "FAILED" ? "FAILED" : "NOT_RUN", issues: check.issues });
  }
  const groupTotals = (groups ?? []).reduce((sum, group) => sum + (group.total ?? 0), 0);
  if (verification.e2eTotal === null || verification.e2eTotal !== groupTotals || verification.e2ePassed !== groupTotals ||
    verification.e2eExecuted !== groupTotals || verification.e2eFailed !== 0 || verification.e2eNotRun !== 0) index.issues.push("E2E_TOTAL_NOT_ALL_PASS");
  if (verification.protectedRegression === "FAILED" || verification.protectedRegression === "NOT_RUN" ||
    (mode === "full" && verification.protectedRegression !== "PASSED")) index.issues.push("PROTECTED_EVIDENCE_NOT_ALL_PASS");
  if (verification.protectedRegression === "PASSED" && (!verification.protectedGroups?.length || !verification.protectedBehaviors?.length ||
    verification.protectedBehaviors.some(behavior => behavior.status !== "PASSED" || !behavior.cases?.length ||
      behavior.cases.some(value => value.status !== "PASSED")))) index.issues.push("PROTECTED_ACTUAL_CASE_EVIDENCE_UNAVAILABLE");
  if (windowAvailable && (verification.sourcePassed === false || units.some(unit => unit.evidence.success === false) || index.ownedRuns.some(run => run.status === "FAILED"))) index.status = "FAILED";
  else if (index.issues.length === 0) index.status = "PASSED";
  fs.writeFileSync(path.join(outputDirectory, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return { status: index.status, outputDirectory, index };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const begin = args[0] === "begin", modeArg = args[begin ? 1 : 0];
  if (args.length !== (begin ? 2 : 1) || !/^--mode=(?:affected|full)$/u.test(modeArg ?? "")) throw new Error("Use [begin] --mode=affected or --mode=full");
  const mode = modeArg.slice("--mode=".length), context = readGitHubVerificationContext();
  if (begin) {
    const result = beginCiVerificationWindow({ mode, context });
    process.stdout.write(`VERIDIA_CI_VERIFICATION_WINDOW=${JSON.stringify(result)}\n`);
  } else {
    const result = exportCiMachineEvidence({ mode, context });
    process.stdout.write(`VERIDIA_CI_MACHINE_EVIDENCE=${JSON.stringify({ status: result.status, directory: path.relative(process.cwd(), result.outputDirectory), issues: result.index.issues })}\n`);
    if (result.status !== "PASSED") process.exitCode = 1;
  }
}
