import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import fs from "node:fs";
import path from "node:path";
import observer from "./e2e-server-observer.cjs";
import { validateNativeRuntimeSnapshot, validateNativeProviderReceipt, validateNativeIdentityFailure } from "./runtime-observation-provider-client.mjs";

export const { redactE2eDiagnosticText } = observer;

export function redactE2eDiagnosticValue(value, secrets = []) {
  if (typeof value === "string") return redactE2eDiagnosticText(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactE2eDiagnosticValue(item, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      /cookie|authorization|password|secret|token|api[_-]?key/iu.test(key)
        ? "[REDACTED]" : redactE2eDiagnosticValue(item, secrets)]));
  }
  return value;
}

export function parseRepeatEach(args) {
  const options = args.filter(arg => arg.startsWith("--repeat-each="));
  if (options.length === 0) return 1;
  if (options.length !== 1 || !/^--repeat-each=[1-9]\d*$/u.test(options[0])) {
    throw new Error("--repeat-each 必须是唯一的正整数参数");
  }
  const repeatEach = Number(options[0].split("=")[1]);
  if (!Number.isSafeInteger(repeatEach)) throw new Error("--repeat-each 必须是安全正整数");
  return repeatEach;
}

export function normalizeUniqueFormalCaseEvidence(cases) {
  const unique = new Map();
  const priority = { PASSED: 0, NOT_RUN: 1, FAILED: 2 };
  for (const item of cases) {
    if (!Object.hasOwn(priority, item.status)) throw new Error("E2E formal case evidence 状态未知");
    const key = JSON.stringify([item.file, item.title]);
    const prior = unique.get(key);
    if (!prior || priority[item.status] > priority[prior.status]) {
      unique.set(key, { file: item.file, title: item.title, status: item.status });
    }
  }
  return [...unique.values()];
}

export function summarizeRepeatedExecutions(report, selectedTotal) {
  const cases = [];
  const visit = suite => {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const results = test.results || [];
        const actual = results.filter(result => result.status !== "skipped");
        const status = actual.some(result => result.status !== "passed") ? "FAILED"
          : actual.length > 0 ? "PASSED" : "NOT_RUN";
        const repeatIndexPresent = Object.hasOwn(test, "repeatEachIndex");
        const validRepeatIndex = repeatIndexPresent && Number.isSafeInteger(test.repeatEachIndex) && test.repeatEachIndex >= 0;
        cases.push({ file: spec.file || suite.file, title: spec.title, project: test.projectName,
          reportSpecId: typeof spec.id === "string" ? spec.id : null, reportExecutionOrdinal: cases.length + 1,
          repeatEachIndex: validRepeatIndex ? test.repeatEachIndex : null,
          repeatIndexSource: validRepeatIndex ? "REPORT_FIELD" : repeatIndexPresent ? "INVALID_REPORT_FIELD" : "NOT_SERIALIZED",
          timeoutMs: Number.isSafeInteger(test.timeout) && test.timeout > 0 ? test.timeout : null, status,
          durationMs: actual.reduce((sum, result) => sum + (result.duration || 0), 0),
          retryCount: actual.reduce((sum, result) => sum + (result.retry > 0 ? 1 : 0), 0),
          attempts: actual.map(result => ({ status: result.status, durationMs: result.duration ?? null,
            retry: result.retry ?? null, startTime: result.startTime ?? null,
            workerIndex: result.workerIndex ?? null, parallelIndex: result.parallelIndex ?? null })) });
      }
    }
    for (const child of suite.suites || []) visit(child);
  };
  for (const suite of report.suites || []) visit(suite);
  const total = Math.max(selectedTotal, cases.length);
  const passed = cases.filter(item => item.status === "PASSED").length;
  const failed = cases.filter(item => item.status === "FAILED").length;
  return { total, executed: passed + failed, passed, failed, notRun: total - passed - failed,
    retryCount: cases.reduce((sum, item) => sum + item.retryCount, 0), cases };
}

export function selectOwnedProcessTree(processes, rootPid) {
  const root = processes.find(item => item.pid === rootPid);
  return root ? extendOwnedProcessIdentities(processes, [root]) : [];
}

function validBirth(item) {
  return typeof item?.createdAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(item.createdAt) &&
    Number.isFinite(Date.parse(item.createdAt));
}

const OWNERSHIP_STATUS = new Set(["SNAPSHOT_ONLY_BIRTH_PARENT_NAME_OBSERVATION", "SPI_IDLE_SENTINEL_NO_AUTHORITY", "HELD_HANDLE_PID_PARENT_BIRTH_NAME_VERIFIED", "HELD_HANDLE_EXITED_NO_AUTHORITY", "OPAQUE_NO_HELD_IDENTITY_NO_AUTHORITY"]);
const OWNERSHIP_PARENT_PROOF = new Set(["SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY", "HELD_HANDLE_NT_BASIC_OBSERVATION_ONLY", "TOOLHELP_SNAPSHOT_OPAQUE_NO_AUTHORITY"]);
function ownershipIdentityProjection(row) {
  const failure = row?.nativeIdentityFailure;
  let nativeIdentityFailure = null;
  if (failure) {
    try { nativeIdentityFailure = validateNativeIdentityFailure(failure); }
    catch { nativeIdentityFailure = { code: "UNKNOWN_NATIVE_IDENTITY_READ_FAILURE", operation: "UNKNOWN", win32Error: null, ntStatus: null }; }
  }
  return { pid: Number.isSafeInteger(row?.pid) && row.pid >= 0 ? row.pid : null,
    parentPid: Number.isSafeInteger(row?.parentPid) && row.parentPid >= 0 ? row.parentPid : null,
    name: typeof row?.name === "string" && /^[\p{L}\p{N}_. ()\[\]-]{1,260}$/u.test(row.name) ? row.name : "NOT_AVAILABLE",
    createdAt: validBirth(row) ? row.createdAt : null,
    createdAtMeasurement: validBirth(row) ? "VALID" : row?.createdAt === null ? "NULL" : "INVALID_OR_MISSING",
    nativeBirthStamp: typeof row?.nativeBirthStamp === "string" && /^\d{17,18}$/u.test(row.nativeBirthStamp) ? row.nativeBirthStamp : null,
    nativeIdentityStatus: OWNERSHIP_STATUS.has(row?.nativeIdentityStatus) ? row.nativeIdentityStatus : "NOT_AVAILABLE",
    parentIdentityProof: OWNERSHIP_PARENT_PROOF.has(row?.parentIdentityProof) ? row.parentIdentityProof : "NOT_AVAILABLE",
    liveAtCaptureEnd: typeof row?.liveAtCaptureEnd === "boolean" ? row.liveAtCaptureEnd : null, nativeIdentityFailure };
}

function ownershipFailure(message, kind, candidate, parent, captured, parentSelection) {
  const candidateHistory = captured.filter(row => row.pid === candidate.pid), parentHistory = captured.filter(row => row.pid === parent?.pid);
  const diagnostic = { schemaVersion: 1, kind, ownershipGranted: false, parentSelection,
    capturedRootIdentity: captured[0] ? ownershipIdentityProjection(captured[0]) : null,
    candidate: ownershipIdentityProjection(candidate), parent: parent ? ownershipIdentityProjection(parent) : null,
    capturedCandidateIdentityCount: candidateHistory.length, capturedCandidateIdentities: candidateHistory.slice(0, 4).map(ownershipIdentityProjection),
    capturedParentIdentityCount: parentHistory.length, capturedParentIdentities: parentHistory.slice(0, 4).map(ownershipIdentityProjection),
    identityHistoryTruncated: candidateHistory.length > 4 || parentHistory.length > 4 };
  const error = new Error(message);
  // A detached whitelist projection, not an inventory/reference to raw rows.
  Object.defineProperty(error, "ownershipDiagnostic", { value: diagnostic, enumerable: true });
  return error;
}

function safeOwnershipDiagnostic(error) {
  try {
  const value = error?.ownershipDiagnostic;
  if (!value || value.schemaVersion !== 1 || value.ownershipGranted !== false ||
    !["CAPTURED_PID_IDENTITY_UNAVAILABLE", "LIVE_PARENT_CHILD_IDENTITY_UNAVAILABLE"].includes(value.kind) ||
    !Array.isArray(value.capturedCandidateIdentities) || !Array.isArray(value.capturedParentIdentities)) return null;
  const project = row => ({ ...ownershipIdentityProjection(row),
    createdAtMeasurement: ["VALID", "NULL", "INVALID_OR_MISSING"].includes(row?.createdAtMeasurement) ? row.createdAtMeasurement : "INVALID_OR_MISSING" });
  return { schemaVersion: 1, kind: value.kind, ownershipGranted: false,
    capturedRootIdentity: value.capturedRootIdentity ? project(value.capturedRootIdentity) : null,
    parentSelection: value.parentSelection === "SNAPSHOT_BIRTH_MATCHED_OBSERVED_PARENT" ? value.parentSelection : "CURRENT_SNAPSHOT_CANDIDATE_PARENT",
    candidate: project(value.candidate), parent: value.parent ? project(value.parent) : null,
    capturedCandidateIdentityCount: Number.isSafeInteger(value.capturedCandidateIdentityCount) && value.capturedCandidateIdentityCount >= 0 ? value.capturedCandidateIdentityCount : null,
    capturedCandidateIdentities: value.capturedCandidateIdentities.slice(0, 4).map(project),
    capturedParentIdentityCount: Number.isSafeInteger(value.capturedParentIdentityCount) && value.capturedParentIdentityCount >= 0 ? value.capturedParentIdentityCount : null,
    capturedParentIdentities: value.capturedParentIdentities.slice(0, 4).map(project),
    identityHistoryTruncated: value.identityHistoryTruncated === true || value.capturedCandidateIdentities.length > 4 || value.capturedParentIdentities.length > 4 };
  } catch { return null; } // Diagnostics must never replace the primary failure.
}

export function extendOwnedProcessIdentities(processes, captured) {
  const identities = new Map(captured.map(item => [`${item.pid}:${item.createdAt}`, item]));
  for (const process of processes) {
    const previous = captured.filter(item => item.pid === process.pid);
    if (previous.length && !validBirth(process)) {
      throw ownershipFailure("E2E 已捕获 PID 当前出生身份不可验证，禁止推断已退出", "CAPTURED_PID_IDENTITY_UNAVAILABLE",
        process, processes.find(row => row.pid === process.parentPid), captured, "CURRENT_SNAPSHOT_CANDIDATE_PARENT");
    }
  }
  // Original CIM contract: associate descendants from one birth-bearing census,
  // not from end-of-capture liveness. This ledger is a cleanup candidate history;
  // termination still requires a fresh census and retained-handle birth checks.
  // Historical ParentProcessId alone is insufficient.
  const observed = new Map(matchingOwnedProcesses(processes, captured).filter(validBirth).map(item => [item.pid, item]));
  let grew;
  do {
    grew = false;
    for (const child of processes) {
      const parent = observed.get(child.parentPid);
      if (!parent || observed.has(child.pid)) continue;
      if (!validBirth(child)) {
        throw ownershipFailure("E2E 已观测父进程的子进程缺少可验证出生身份", "LIVE_PARENT_CHILD_IDENTITY_UNAVAILABLE",
          child, parent, captured, "SNAPSHOT_BIRTH_MATCHED_OBSERVED_PARENT");
      }
      // Fixed-width UTC stamps preserve sub-millisecond order. An old orphan
      // whose parent PID was reused must never be adopted or killed.
      if (child.createdAt < parent.createdAt) continue;
      observed.set(child.pid, child);
      identities.set(`${child.pid}:${child.createdAt}`, child);
      grew = true;
    }
  } while (grew);
  return [...identities.values()];
}

export function startRuntimeObservation({ capture, record, intervalMs = 2_000, now = Date.now }) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("无效 E2E 后代观测间隔");
  const startedAt = now();
  let sampleCount = 0;
  let lastSampleAt = startedAt;
  let maxGapMs = 0;
  let failure;
  const sample = () => {
    try {
      const runtime = capture();
      record(runtime);
      const at = now();
      maxGapMs = Math.max(maxGapMs, at - lastSampleAt);
      lastSampleAt = at;
      sampleCount += 1;
    } catch (error) { failure ??= error instanceof Error ? error.message : String(error); }
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref?.();
  sample();
  return { stop() {
    clearInterval(timer);
    return { status: failure ? "FAILED" : sampleCount > 0 ? "PASSED" : "NOT_RUN", sampleCount, intervalMs,
      maxGapMs: Math.max(maxGapMs, now() - lastSampleAt), elapsedMs: now() - startedAt,
      coverage: "SAMPLED_NOT_EXHAUSTIVE", ...(failure ? { error: failure } : {}) };
  } };
}

// The persistent read-only native census runs on a dedicated serial worker, never on
// the Playwright protocol event loop. Ownership adoption remains on the caller.
export function validRuntimeObservationQueryDeadline(sentMs, deadlineMs) {
  return Number.isFinite(sentMs) && Number.isFinite(deadlineMs) && deadlineMs === sentMs + 15_000;
}

export function startWindowsRuntimeObservation({ port, runId, wrapperIdentity, record }, {
  createWorker = data => new Worker(new URL("./runtime-observation-worker.mjs", import.meta.url), { workerData: data }),
  now = () => performance.now(), timeOrigin = performance.timeOrigin,
} = {}) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || typeof runId !== "string" ||
    !/^[A-Za-z0-9_.-]{1,256}$/u.test(runId) || typeof record !== "function" ||
    wrapperIdentity?.pid !== process.pid || !validBirth(wrapperIdentity)) throw new Error("E2E worker observation input invalid");
  const observerId = randomUUID(), startedMs = now(), startupDeadlineMs = startedMs + 15_000;
  const worker = createWorker({ runId, observerId, port, wrapperPid: process.pid, wrapperIdentity, startupDeadlineMs, timeOrigin });
  let state = "STARTING", failure, sampleCount = 0, sequence = 0, pending, stopPromise, stopDeadlineMs;
  let timer, lastSampleMs = startedMs, maxGapMs = 0, coalescedTicks = 0, exitCode = null, joined = false;
  let stopRequestedMs, stopAcknowledged = false, nativeProviderIdentity, nativeProviderJoin, firstOwnershipFailureDiagnostic;
  let resolveReady, rejectReady, resolveExit;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Caller receives the original rejecting promise, but startup cleanup can be
  // initiated before it awaits ready without creating an unhandled rejection.
  ready.catch(() => undefined);
  const exited = new Promise(resolve => { resolveExit = resolve; });
  const receipts = [];
  const snapshot = () => ({ status: failure ? "FAILED" : sampleCount > 0 && joined ? "PASSED" : "NOT_RUN",
    sampleCount, intervalMs: 2_000, maxGapMs: Math.max(maxGapMs, now() - lastSampleMs), elapsedMs: now() - startedMs,
    coverage: "SAMPLED_NOT_EXHAUSTIVE", ...(failure ? { error: failure } : {}),
    state, runId, observerId, coalescedTicks, workerJoined: joined, workerExitCode: exitCode,
    stopDeadlineMs: stopDeadlineMs ?? null, stopAcknowledged, nativeProviderJoin: nativeProviderJoin ?? null,
    ...(firstOwnershipFailureDiagnostic ? { firstOwnershipFailureDiagnostic } : {}), receipts });
  const fail = error => {
    const message = error instanceof Error ? error.message : String(error);
    failure ??= message; clearInterval(timer);
    receipts.push({ event: "FAILED", atMs: now(), error: message });
  };
  const annotatedError = message => {
    const error = new Error(message);
    Object.defineProperty(error, "observation", { enumerable: true, get: snapshot });
    return error;
  };
  const startupTimer = setTimeout(() => {
    fail("E2E observation READY deadline exhausted"); rejectReady(annotatedError(failure));
  }, Math.max(0, startupDeadlineMs - now()));
  const bound = (promise, deadlineMs) => {
    let deadlineTimer;
    const remaining = deadlineMs - now();
    const message = "E2E observation caller stop deadline exhausted";
    if (remaining <= 0) { fail(message); return Promise.reject(annotatedError(message)); }
    return Promise.race([promise, new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => { fail(message); reject(annotatedError(message)); }, remaining);
    })]).then(value => {
      if (now() >= deadlineMs) { fail(message); throw annotatedError(message); }
      return value;
    }).finally(() => clearTimeout(deadlineTimer));
  };
  const settlePending = () => {
    if (!pending) return;
    clearTimeout(pending.timer); const item = pending; pending = undefined; item.resolve();
  };
  const identityMatches = message => message?.runId === runId && message.observerId === observerId &&
    message.port === port && message.wrapperPid === process.pid && message.workerThreadId === worker.threadId &&
    message.timeOrigin === timeOrigin;
  const request = () => {
    if (state !== "RUNNING" || failure) return;
    if (pending) { coalescedTicks++; return; }
    const sentMs = now(), deadlineMs = sentMs + 15_000;
    let resolve;
    const done = new Promise(value => { resolve = value; });
    pending = { sequence: ++sequence, sentMs, deadlineMs, done, resolve,
      timer: setTimeout(() => fail("E2E observation query deadline exhausted"), 15_000) };
    receipts.push({ event: "QUERY_SENT", sequence, sentMs, deadlineMs, timeoutMs: 15_000 });
    worker.postMessage({ command: "QUERY", runId, observerId, port, wrapperPid: process.pid,
      sequence, sentMs, deadlineMs, timeOrigin });
  };
  worker.on("message", message => {
    const receivedMs = now();
    let resultReceipt;
    try {
      if (!identityMatches(message)) throw new Error("E2E observation worker identity mismatch");
      if (message.event === "FAILED") {
        if (message.nativeProviderJoin) nativeProviderJoin = message.nativeProviderJoin;
        throw new Error(message.error || "E2E observation native provider failure");
      }
      if (message.event === "READY") {
        if (state !== "STARTING" || failure || !Number.isFinite(message.readyMs) || message.readyMs < startedMs ||
          message.readyMs > receivedMs || receivedMs > startupDeadlineMs) throw new Error("E2E observation late/duplicate READY");
        nativeProviderIdentity = validateNativeProviderReceipt(message.nativeProviderIdentity,
          { runId, observerId, port, wrapperIdentity, receivedMs });
        clearTimeout(startupTimer); state = "RUNNING";
        receipts.push({ event: "READY", atMs: receivedMs, readyMs: message.readyMs, workerThreadId: worker.threadId });
        request(); timer = setInterval(request, 2_000); resolveReady(); return;
      }
      if (message.event === "STOP_ACK") {
        if (state !== "STOPPING" || stopAcknowledged || pending || message.sequence !== sequence ||
          !Number.isFinite(message.acknowledgedMs) || message.acknowledgedMs < stopRequestedMs ||
          message.acknowledgedMs > receivedMs || receivedMs > stopDeadlineMs) throw new Error("E2E observation STOP acknowledgement invalid");
        nativeProviderJoin = validateNativeProviderReceipt(message.nativeProviderJoin,
          { runId, observerId, port, wrapperIdentity, providerIdentity: nativeProviderIdentity,
            sequence, receivedMs, stopRequestedMs, stopDeadlineMs, terminal: true });
        stopAcknowledged = true;
        receipts.push({ event: "STOP_ACK", runId, observerId, sequence, workerThreadId: worker.threadId,
          acknowledgedMs: message.acknowledgedMs, receivedMs, nativeProviderJoin }); return;
      }
      if (message.event !== "QUERY_RESULT" || !pending || message.sequence !== pending.sequence ||
        !["RUNNING", "STOPPING"].includes(state)) throw new Error("E2E observation stale/unbound query result");
      const { sentMs, deadlineMs } = pending;
      // Do not serialize the complete native machine inventory every two seconds.
      // The validated raw snapshot still reaches the ownership callback below.
      resultReceipt = { event: "QUERY_RESULT", runId, observerId, port, wrapperPid: process.pid,
        workerThreadId: message.workerThreadId, timeOrigin: message.timeOrigin, sequence: message.sequence,
        provider: message.provider, queryStartedMs: message.queryStartedMs, queryEndedMs: message.queryEndedMs,
        queryStartedAt: message.queryStartedAt, queryEndedAt: message.queryEndedAt,
        receivedMs, elapsedMs: receivedMs - sentMs, error: message.error,
        runtimeValidated: false, processCount: null, portCount: null };
      receipts.push(resultReceipt);
      if (message.provider !== "SPI_SNAPSHOT_HELD_ROOTS_IPHELPER_WMI_FREE" || !Number.isFinite(message.queryStartedMs) ||
        !Number.isFinite(message.queryEndedMs) || sentMs > message.queryStartedMs ||
        message.queryStartedMs > message.queryEndedMs || message.queryEndedMs > receivedMs ||
        receivedMs > deadlineMs || (stopDeadlineMs !== undefined && receivedMs > stopDeadlineMs) ||
        !Number.isFinite(Date.parse(message.queryStartedAt)) || !Number.isFinite(Date.parse(message.queryEndedAt)) ||
        Date.parse(message.queryStartedAt) > Date.parse(message.queryEndedAt)) throw new Error("E2E observation query clock/deadline invalid");
      if (message.error !== null) throw new Error(message.error || "E2E observation provider failure");
      const runtime = validateNativeRuntimeSnapshot(message.runtime, { port, wrapperIdentity, providerIdentity: nativeProviderIdentity });
      resultReceipt.runtimeValidated = true;
      resultReceipt.processCount = runtime.processes.length; resultReceipt.portCount = runtime.ports.length;
      if (!failure) {
        try { record(runtime); } catch (error) {
          const diagnostic = safeOwnershipDiagnostic(error);
          if (diagnostic) {
            resultReceipt.ownershipFailureDiagnostic = diagnostic;
            firstOwnershipFailureDiagnostic ??= { runId, observerId, sequence: message.sequence, workerThreadId: message.workerThreadId,
              queryStartedAt: message.queryStartedAt, queryEndedAt: message.queryEndedAt, receivedMs, diagnostic };
          }
          throw error;
        }
        maxGapMs = Math.max(maxGapMs, receivedMs - lastSampleMs); lastSampleMs = receivedMs; sampleCount++;
      }
      settlePending();
    } catch (error) {
      if (resultReceipt) resultReceipt.validationError = error instanceof Error ? error.message : String(error);
      fail(error);
      if (state === "STARTING") { clearTimeout(startupTimer); rejectReady(annotatedError(failure)); }
      // An unrelated message must not discharge the real in-flight query.
      if (pending && identityMatches(message) && message.sequence === pending.sequence && message.event === "QUERY_RESULT") settlePending();
    }
  });
  worker.on("error", error => { fail(error); clearTimeout(startupTimer); rejectReady(annotatedError(failure)); });
  worker.on("exit", code => {
    const priorState = state;
    if (priorState !== "STOPPING" || code !== 0 || pending || !stopAcknowledged) fail("E2E observation unexpected worker exit or missing STOP acknowledgement");
    joined = true; exitCode = code; state = priorState === "STOPPING" ? "STOPPED" : "EXITED_UNEXPECTED";
    clearTimeout(startupTimer); clearInterval(timer); settlePending();
    rejectReady(annotatedError(failure || "E2E observation exited before READY"));
    receipts.push({ event: "WORKER_EXIT", atMs: now(), code, priorState }); resolveExit();
  });
  return { ready, snapshot, stop(deadlineMs) {
    if (stopPromise) return stopPromise;
    clearInterval(timer); clearTimeout(startupTimer);
    stopRequestedMs = now();
    stopDeadlineMs = Math.min(deadlineMs, stopRequestedMs + 15_000);
    if (state === "STARTING") { fail("E2E observation stopped before READY"); rejectReady(annotatedError(failure)); }
    if (!["STOPPED", "EXITED_UNEXPECTED"].includes(state)) {
      state = "STOPPING"; worker.postMessage({ command: "STOP", runId, observerId, sequence, deadlineMs: stopDeadlineMs });
    }
    receipts.push({ event: "STOP_REQUESTED", atMs: now(), deadlineMs: stopDeadlineMs, callerDeadlineMs: deadlineMs, inFlight: !!pending });
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
      fail("E2E observation mandatory absolute stop deadline invalid");
      stopPromise = Promise.reject(annotatedError(failure)); return stopPromise;
    }
    stopPromise = bound((async () => { if (pending) await pending.done; await exited; return snapshot(); })(), stopDeadlineMs);
    return stopPromise;
  } };
}

export async function waitForOwnedProcessQuiescence({ identities, capture, requirePortClosed = false,
  deadlineMs = 10_000, intervalMs = 100, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || !Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("无效 E2E 物理退出期限");
  const startedAt = now();
  let observations = 0;
  do {
    const remainingMs = deadlineMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    let timer;
    let runtime;
    try {
      runtime = await Promise.race([Promise.resolve().then(() => capture(remainingMs)), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("E2E 物理退出观测超时")), remainingMs);
      })]);
    } finally { clearTimeout(timer); }
    if (!Array.isArray(runtime?.processes) || !Array.isArray(runtime?.ports)) throw new Error("E2E 物理退出测量缺失，禁止猜测进程0");
    observations += 1;
    const owned = matchingOwnedProcesses(runtime.processes, identities);
    if (now() - startedAt <= deadlineMs && owned.length === 0 && (!requirePortClosed || runtime.ports.length === 0)) {
      return { status: "PASSED", runtime, observations, elapsedMs: now() - startedAt, deadlineMs, ownedProcessCount: 0 };
    }
    const waitMs = Math.min(intervalMs, deadlineMs - (now() - startedAt));
    if (waitMs > 0) await sleep(waitMs);
  } while (now() - startedAt < deadlineMs);
  throw new Error("E2E 已捕获进程树/端口在限定时间内未释放");
}

export function validateInitialOwnedRoot(actual, fence) {
  if (!actual || !fence || actual.pid !== fence.pid || actual.parentPid !== fence.parentPid ||
    typeof actual.name !== "string" || typeof fence.name !== "string" || actual.name.toLowerCase() !== fence.name.toLowerCase() ||
    typeof actual.createdAt !== "string" || actual.createdAt.length === 0 || !Number.isFinite(Date.parse(actual.createdAt))) return false;
  if (fence.expectedCreatedAt) return actual.createdAt === fence.expectedCreatedAt;
  const createdMs = Date.parse(actual.createdAt);
  return Number.isSafeInteger(fence.earliestCreationMs) && Number.isSafeInteger(fence.latestCreationMs) &&
    Number.isFinite(createdMs) && createdMs >= fence.earliestCreationMs && createdMs <= fence.latestCreationMs;
}

export function selectNewOwnedBrowserRoot(before, after, parentPid) {
  const previous = new Set(before.map(item => `${item.pid}:${item.createdAt}`));
  const candidates = after.filter(item => item.parentPid === parentPid &&
    /^(?:chrome|chromium|headless_shell)\.exe$/iu.test(item.name) &&
    typeof item.createdAt === "string" && item.createdAt.length > 0 &&
    !previous.has(`${item.pid}:${item.createdAt}`));
  if (candidates.length !== 1) throw new Error(`E2E warmup browser 所有权不唯一：${candidates.length}`);
  return candidates[0];
}

export async function closeWithinDeadline(close, timeoutMs = 2_000) {
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(close),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("E2E warmup browser close 超时")), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function evaluateGenerationIdleSnapshot(runtime, sessions, health) {
  if (health?.ok !== true || health?.service !== "VERIDIA") throw new Error("E2E group-end health 未就绪");
  const counts = {};
  for (const key of ["effectiveRunnerCount", "activeExtractionCount", "pendingCleanupBarrierCount", "pendingLifecycleOperationCount"]) {
    const value = runtime?.[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`E2E group-end 缺少真实整数计数：${key}`);
    counts[key] = value;
  }
  const transactions = runtime?.prismaTransactionDiagnostics;
  if (transactions?.measurement !== "AVAILABLE" || transactions.coverageScope !== "APP_LIB_SINGLETON_EXPLICIT_TRANSACTIONS" ||
    transactions.singletonRegistered !== true || transactions.wrapperIntact !== true) {
    throw new Error("E2E group-end Prisma explicit transaction measurement 不可验证");
  }
  for (const key of ["pendingTransactionCount", "observedTransactionCount", "settledTransactionCount",
    "observedBatchTransactionCount", "observedInteractiveTransactionCount", "observedOtherTransactionCount"]) {
    if (!Number.isSafeInteger(transactions[key]) || transactions[key] < 0) {
      throw new Error(`E2E group-end Prisma explicit transaction 真实整数计数缺失：${key}`);
    }
  }
  if (transactions.observedTransactionCount !== transactions.settledTransactionCount + transactions.pendingTransactionCount ||
    transactions.observedTransactionCount !== transactions.observedBatchTransactionCount + transactions.observedInteractiveTransactionCount + transactions.observedOtherTransactionCount) {
    throw new Error("E2E group-end Prisma explicit transaction lifetime ledger 不一致");
  }
  counts.pendingPrismaTransactionCount = transactions.pendingTransactionCount;
  if (!Array.isArray(runtime.activeBrowserOwnerGenerations) || runtime.activeBrowserOwnerGenerations.some(value => !Number.isSafeInteger(value) || value < 1) ||
    new Set(runtime.activeBrowserOwnerGenerations).size !== runtime.activeBrowserOwnerGenerations.length) {
    throw new Error("E2E group-end 缺少真实 Browser owner generation");
  }
  if (![null, "PENDING", "FAILED"].includes(runtime.physicalCloseState) || typeof runtime.physicalCloseFencePresent !== "boolean") {
    throw new Error("E2E group-end 缺少真实物理关闭状态");
  }
  if (runtime.physicalCloseState === "FAILED") throw new Error("E2E group-end physical close fence FAILED");
  const managers = {};
  for (const platform of ["XIAOHONGSHU", "DOUYIN"]) {
    const manager = runtime.platformBrowserManagers?.[platform];
    if (manager?.managerAvailable !== true || typeof manager.contextPresent !== "boolean" ||
      typeof manager.browserConnected !== "boolean" || !Number.isSafeInteger(manager.lifecycleGeneration) || manager.lifecycleGeneration < 0 ||
      !["NONE", "INTERACTIVE", "EXTRACTION"].includes(manager.contextOwnershipKind) ||
      !(manager.contextOwnerGeneration === null || (Number.isSafeInteger(manager.contextOwnerGeneration) && manager.contextOwnerGeneration > 0))) {
      throw new Error(`E2E group-end ${platform} browser manager 不可验证`);
    }
    if (!sessions?.[platform] || !("auditLock" in sessions[platform])) throw new Error(`E2E group-end ${platform} isolated DB session 未验证`);
    managers[platform] = { managerAvailable: true, contextPresent: manager.contextPresent,
      browserConnected: manager.browserConnected, contextOwnerGeneration: manager.contextOwnerGeneration,
      contextOwnershipKind: manager.contextOwnershipKind, lifecycleGeneration: manager.lifecycleGeneration,
      auditLockPresent: sessions[platform].auditLock !== null };
  }
  const idle = Object.values(counts).every(value => value === 0) && runtime.physicalCloseState === null &&
    !runtime.physicalCloseFencePresent && Object.values(managers).every(manager => !manager.auditLockPresent);
  if (idle && runtime.activeBrowserOwnerGenerations.some(generation =>
    !Object.values(managers).some(manager => manager.contextPresent && manager.contextOwnerGeneration === generation))) {
    throw new Error("E2E group-end Browser owner 没有对应存活 context");
  }
  if (idle && Object.values(managers).some(manager => manager.contextPresent && !manager.browserConnected)) {
    throw new Error("E2E group-end retained Browser context 连接不可验证");
  }
  if (idle && Object.values(managers).some(manager => !manager.contextPresent
    ? manager.contextOwnerGeneration !== null || manager.contextOwnershipKind !== "NONE"
    : manager.contextOwnershipKind === "EXTRACTION"
      ? manager.contextOwnerGeneration === null || !runtime.activeBrowserOwnerGenerations.includes(manager.contextOwnerGeneration)
      : manager.contextOwnershipKind !== "INTERACTIVE" || manager.contextOwnerGeneration !== null)) {
    throw new Error("E2E group-end retained context 所有权来源或 ledger 不一致");
  }
  return { idle, counts, physicalCloseState: runtime.physicalCloseState,
    prismaTransactionCheck: { status: counts.pendingPrismaTransactionCount === 0 ? "PASSED" : "PENDING",
      measurement: transactions.measurement, coverageScope: transactions.coverageScope,
      singletonRegistered: true, wrapperIntact: true, pendingTransactionCount: transactions.pendingTransactionCount,
      observedTransactionCount: transactions.observedTransactionCount, settledTransactionCount: transactions.settledTransactionCount,
      observedBatchTransactionCount: transactions.observedBatchTransactionCount,
      observedInteractiveTransactionCount: transactions.observedInteractiveTransactionCount,
      observedOtherTransactionCount: transactions.observedOtherTransactionCount },
    physicalCloseFencePresent: runtime.physicalCloseFencePresent, platformBrowserManagers: managers,
    activeBrowserOwnerGenerations: [...runtime.activeBrowserOwnerGenerations],
    ownerState: !idle ? "PENDING_OWNER" : Object.values(managers).some(manager => manager.contextPresent && manager.contextOwnershipKind === "EXTRACTION")
      ? "VALID_RETAINED_OWNER" : Object.values(managers).some(manager => manager.contextPresent)
        ? "VALID_RETAINED_INTERACTIVE_CONTEXT" : "NONE_RECORDED",
    isolatedDatabaseResponsive: true, health: { ok: true, service: "VERIDIA", version: health.version } };
}

export function captureWindowsRuntime(port, execute = spawnSync, timeoutMs = 15_000) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("无效 E2E 端口");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error("无效 E2E 诊断期限");
  // Enumerate before filtering: a normal empty provider result is port0, while
  // provider/permission errors must never be converted into the same evidence.
  const script = `$ErrorActionPreference='Stop'; $processes=@(Get-CimInstance Win32_Process | ForEach-Object { @{pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; name=$_.Name; createdAt=$(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); workingSetBytes=[long]$_.WorkingSetSize} }); $ports=@(Get-NetTCPConnection -ErrorAction Stop | Where-Object { [int]$_.LocalPort -eq ${port} -and [string]$_.State -eq 'Listen' } | ForEach-Object { @{port=[int]$_.LocalPort; pid=[int]$_.OwningProcess; state='LISTEN'} }); @{processes=$processes; ports=$ports} | ConvertTo-Json -Depth 5 -Compress`;
  const result = execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: timeoutMs,
  });
  if (result.error || result.status !== 0) throw new Error(`E2E 进程/端口诊断失败：${result.error?.message || result.stderr || result.status}`);
  return JSON.parse(result.stdout.trim());
}

export function captureWindowsScopedResiduals({ projectRoot, profilePaths, identities, wrapperIdentity, timeoutMs = 15_000 }, execute = spawnSync) {
  if (!path.isAbsolute(projectRoot) || !Array.isArray(profilePaths) || !Array.isArray(identities) ||
    !validBirth(wrapperIdentity) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15_000) throw new Error("E2E residual scope/物理身份不完整");
  const script = `$ErrorActionPreference='Stop';
$scope=[Console]::In.ReadToEnd() | ConvertFrom-Json;
$marker=([string]$scope.projectRoot).Replace('/','\\').ToLowerInvariant();
$expected=@{}; $historicalParentPids=@{}; foreach($identity in $scope.identities){$expected["$($identity.pid):$($identity.createdAt)"]=$true;$historicalParentPids[[string]$identity.pid]=$true};
$owned=@(); $unknown=@(); $opaque=@(); $collectorCandidates=@(); $heldChildren=@(); $collectorHandle=$null; $wrapperHandle=$null;
function RowBirth($item){if($item.CreationDate){$item.CreationDate.ToUniversalTime().ToString('o')}else{$null}};
function BirthFileTime($birth){[DateTimeOffset]::ParseExact($birth,'yyyy-MM-ddTHH:mm:ss.fffffffZ',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime.ToFileTimeUtc()};
try {
  # Self proof is collected before candidate filtering. These handles confer
  # observation identity only; this collector never grants Kill authority.
  $collectorHandle=[Diagnostics.Process]::GetCurrentProcess();$null=$collectorHandle.Handle;
  $collectorNative=$collectorHandle.StartTime.ToUniversalTime().ToFileTimeUtc();
  $queryStarted=[DateTime]::UtcNow;
  $items=@(Get-CimInstance Win32_Process);
  $selfRows=@($items | Where-Object {[int]$_.ProcessId -eq $PID});
  $wrapperRows=@($items | Where-Object {[int]$_.ProcessId -eq [int]$scope.wrapperIdentity.pid});
  if($selfRows.Count -ne 1 -or $wrapperRows.Count -ne 1){throw 'COLLECTOR_OR_WRAPPER_IDENTITY_UNAVAILABLE'};
  $self=$selfRows[0];$wrapper=$wrapperRows[0];$collectorBirth=RowBirth $self;
  if(!$collectorBirth -or [string]$self.Name -ine ($collectorHandle.ProcessName+'.exe') -or [int]$self.ParentProcessId -ne [int]$scope.wrapperIdentity.pid -or
    [decimal]::Floor([decimal]$collectorNative/10) -ne [decimal]::Floor([decimal](BirthFileTime $collectorBirth)/10)){throw 'COLLECTOR_BIRTH_OR_CALLER_MISMATCH'};
  $wrapperBirth=RowBirth $wrapper;
  $wrapperHandle=[Diagnostics.Process]::GetProcessById([int]$scope.wrapperIdentity.pid);$null=$wrapperHandle.Handle;
  $wrapperNative=$wrapperHandle.StartTime.ToUniversalTime().ToFileTimeUtc();
  if($wrapperBirth -ne $scope.wrapperIdentity.createdAt -or [int]$wrapper.ParentProcessId -ne [int]$scope.wrapperIdentity.parentPid -or
    [string]$wrapper.Name -ine [string]$scope.wrapperIdentity.name -or
    $collectorNative -lt $wrapperNative -or
    [decimal]::Floor([decimal]$wrapperNative/10) -ne [decimal]::Floor([decimal](BirthFileTime $scope.wrapperIdentity.createdAt)/10)){throw 'WRAPPER_BIRTH_MISMATCH'};
  foreach($item in $items) {
    if([int]$item.ProcessId -eq $PID -or [int]$item.ProcessId -eq [int]$scope.wrapperIdentity.pid){continue};
    $birth=RowBirth $item;
    $known=$expected.ContainsKey("$($item.ProcessId):$birth");
    $directCollectorChild=[int]$item.ParentProcessId -eq $PID;
    $related=$false; $opaqueNamed=$false; $scopeKnown=$false;
    $named=$item.Name -match '^(node|chrome|chromium|headless_shell|electron|VERIDIA)\\.exe$';
    $conhost=$item.Name -ieq 'conhost.exe';
    if($named -or ($directCollectorChild -and $conhost)) {
      # A conhost exclusion must independently disprove project/profile scope.
      # Missing command/path evidence is not a non-project proof.
      $opaqueNamed=$named -and [string]::IsNullOrWhiteSpace([string]$item.CommandLine);
      $scopeKnown=![string]::IsNullOrWhiteSpace([string]$item.CommandLine) -and ![string]::IsNullOrWhiteSpace([string]$item.ExecutablePath);
      $command=([string]$item.CommandLine).Replace('/','\\').ToLowerInvariant();
      $executable=([string]$item.ExecutablePath).Replace('/','\\').ToLowerInvariant();
      $related=$command.Contains($marker+'\\') -or $command.Contains('"'+$marker+'"') -or $executable.StartsWith($marker+'\\');
      if($directCollectorChild -and $conhost){$related=$command.Contains($marker) -or $executable.Contains($marker)};
      foreach($profile in $scope.profilePaths){$profileMarker=([string]$profile).Replace('/','\\').ToLowerInvariant();if($command.Contains($profileMarker) -or ($directCollectorChild -and $conhost -and $executable.Contains($profileMarker))){$related=$true}};
    }
    $historicalParent=$historicalParentPids.ContainsKey([string]$item.ParentProcessId);
    if(!$known -and !$related -and !$opaqueNamed -and !$historicalParent -and !$directCollectorChild){continue};
    $row=@{pid=[int]$item.ProcessId;parentPid=[int]$item.ParentProcessId;name=$item.Name;createdAt=$birth};
    if($known){$owned+=$row;continue};
    $row.scopeReason=$(if($opaqueNamed){'UNSCOPED_OPAQUE_NAMED_CANDIDATE'}elseif($related){'PROJECT_OR_RUN_PROFILE_MATCH'}elseif($historicalParent){'UNVERIFIED_HISTORICAL_PARENT_CANDIDATE'}else{'DIAGNOSTIC_COLLECTOR_DIRECT_CHILD_CANDIDATE'});
    $unknown+=$row;if($opaqueNamed){$opaque+=$row};
    if($directCollectorChild -and $conhost) {
      $nativeBirth=$null;$nativeVerified=$false;
      if($birth -and $scopeKnown -and !$related) {
        try {
          $childHandle=[Diagnostics.Process]::GetProcessById([int]$item.ProcessId);$heldChildren+=$childHandle;$null=$childHandle.Handle;
          $nativeBirth=$childHandle.StartTime.ToUniversalTime().ToFileTimeUtc();
          $nativeVerified=[decimal]::Floor([decimal]$nativeBirth/10) -eq [decimal]::Floor([decimal](BirthFileTime $birth)/10);
        } catch {$nativeVerified=$false};
      }
      $collectorCandidates+=@{pid=$row.pid;parentPid=$row.parentPid;name=$row.name;createdAt=$birth;
        nativeCreationFileTime=$(if($null -ne $nativeBirth){[string]$nativeBirth}else{$null});
        nativeBirthVerified=$nativeVerified;scopeKnownNonProjectProfile=($scopeKnown -and !$related)};
    }
  }
  # Evidence only, from this same complete CIM array. Never query/open a parent
  # again, or turn a missing parent into exit/ownership/termination authority.
  # Hashtable keys are not reliable Sort-Object property descriptors in PS5.
  # Explicit expressions match the consumer's numeric PID ordering.
  $historicalCandidates=@($unknown | Where-Object {$_.scopeReason -eq 'UNVERIFIED_HISTORICAL_PARENT_CANDIDATE'} | Sort-Object @{Expression={[int]$_.pid}},@{Expression={[int]$_.parentPid}},@{Expression={[string]$_.createdAt}});
  $historicalObservations=@();$historicalReuseProofs=@();$heldReuse=@();
  function KnownNonProjectScope($row){
    if(!$row -or [string]::IsNullOrWhiteSpace([string]$row.CommandLine) -or [string]::IsNullOrWhiteSpace([string]$row.ExecutablePath)){return $false};
    if([string]$row.Name -match '^(node|chrome|chromium|headless_shell|electron|VERIDIA)\\.exe$'){return $false};
    $command=([string]$row.CommandLine).Replace('/','\\').ToLowerInvariant();$executable=([string]$row.ExecutablePath).Replace('/','\\').ToLowerInvariant();
    if($command.Contains($marker) -or $executable.Contains($marker)){return $false};
    foreach($profile in $scope.profilePaths){$m=([string]$profile).Replace('/','\\').ToLowerInvariant();if($command.Contains($m) -or $executable.Contains($m)){return $false}};
    return $true;
  };
  function NoKnownOwnedAncestor($row){
    $seen=@{};$current=$row;
    for($depth=0;$depth -lt 64;$depth++){
      if($null -eq $current.ParentProcessId -or [double]$current.ParentProcessId -ne [int]$current.ParentProcessId){return $false};
      $descendantBirth=RowBirth $current;if(!$descendantBirth){return $false};
      $parentId=[int]$current.ParentProcessId;
      if($parentId -eq 0){return $true};
      if($parentId -lt 0 -or $seen.ContainsKey([string]$parentId) -or $parentId -eq $PID -or
        $parentId -eq [int]$scope.wrapperIdentity.pid -or $historicalParentPids.ContainsKey([string]$parentId)){return $false};
      $seen[[string]$parentId]=$true;$rows=@($items | Where-Object {[int]$_.ProcessId -eq $parentId});
      if($rows.Count -ne 1){return $false};$current=$rows[0];
      if($null -eq $current.ParentProcessId){return $false};
      if([int]$current.ProcessId -eq 4 -and [int]$current.ParentProcessId -eq 0 -and [string]$current.Name -ieq 'System'){return $true};
      $ancestorBirth=RowBirth $current;
      if(!$ancestorBirth -or [DateTimeOffset]::Parse($ancestorBirth) -gt [DateTimeOffset]::Parse($descendantBirth)){return $false};
      # Missing scope anywhere in the live chain is uncertainty, not exclusion.
      if([string]::IsNullOrWhiteSpace([string]$current.CommandLine) -or [string]::IsNullOrWhiteSpace([string]$current.ExecutablePath)){return $false};
      $command=([string]$current.CommandLine).Replace('/','\\').ToLowerInvariant();$executable=([string]$current.ExecutablePath).Replace('/','\\').ToLowerInvariant();
      if($command.Contains($marker) -or $executable.Contains($marker)){return $false};
      foreach($profile in $scope.profilePaths){$m=([string]$profile).Replace('/','\\').ToLowerInvariant();if($command.Contains($m) -or $executable.Contains($m)){return $false}};
    };
    return $false;
  };
  foreach($candidate in @($historicalCandidates | Select-Object -First 16)) {
    $parents=@($items | Where-Object {[int]$_.ProcessId -eq [int]$candidate.parentPid} | Sort-Object ProcessId,ParentProcessId);
    $parentRows=@($parents | Select-Object -First 4 | ForEach-Object { @{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=$_.Name;createdAt=(RowBirth $_)} });
    $historicalObservations+=@{candidate=@{pid=$candidate.pid;parentPid=$candidate.parentPid;name=$candidate.name;createdAt=$candidate.createdAt};
      currentParentRowCount=$parents.Count;currentParentRows=$parentRows;currentParentRowsTruncated=($parents.Count -gt 4);
      parentObservation=$(if($parents.Count -eq 0){'ABSENT_IN_THIS_SNAPSHOT'}elseif($parents.Count -eq 1){'ONE_ROW_IN_THIS_SNAPSHOT'}else{'MULTIPLE_ROWS_IN_THIS_SNAPSHOT'})};
    # Observation only: never adopt a candidate or grant termination authority.
    # A current parent incarnation born before the child and held alive occupies
    # that PID throughout the child's birth, under the existing UTC birth-order
    # contract. Any missing scope, ambiguous row or native failure stays UNKNOWN.
    $children=@($items | Where-Object {[int]$_.ProcessId -eq [int]$candidate.pid});
    if($parents.Count -ne 1 -or $children.Count -ne 1){continue};
    $p=$parents[0];$c=$children[0];$pb=RowBirth $p;$cb=RowBirth $c;
    if(!$pb -or !$cb -or !(KnownNonProjectScope $p) -or !(KnownNonProjectScope $c) -or !(NoKnownOwnedAncestor $p)){continue};
    try {
      $ph=[Diagnostics.Process]::GetProcessById([int]$p.ProcessId);$heldChildren+=$ph;$null=$ph.Handle;
      $ch=[Diagnostics.Process]::GetProcessById([int]$c.ProcessId);$heldChildren+=$ch;$null=$ch.Handle;
      $pn=$ph.StartTime.ToUniversalTime().ToFileTimeUtc();$cn=$ch.StartTime.ToUniversalTime().ToFileTimeUtc();
      if($ph.HasExited -or $ch.HasExited -or ($ph.ProcessName+'.exe') -ine [string]$p.Name -or ($ch.ProcessName+'.exe') -ine [string]$c.Name -or
        [decimal]::Floor([decimal]$pn/10) -ne [decimal]::Floor([decimal](BirthFileTime $pb)/10) -or
        [decimal]::Floor([decimal]$cn/10) -ne [decimal]::Floor([decimal](BirthFileTime $cb)/10) -or $pn -ge $cn){continue};
      $proof=@{child=@{pid=[int]$c.ProcessId;parentPid=[int]$c.ParentProcessId;name=[string]$c.Name;createdAt=$cb;nativeCreationFileTime=[string]$cn};
        parent=@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;name=[string]$p.Name;createdAt=$pb;nativeCreationFileTime=[string]$pn};
        sameSnapshotUniqueRows=$true;childScopeKnownNonProjectProfile=$true;parentScopeKnownNonProjectProfile=$true;
        noKnownOwnedAncestorSameSnapshot=$true;
        sameHandlesLiveAtBothBoundaries=$false;nativeIdentityMatchesAtBothBoundaries=$false;
        ownershipGranted=$false;terminationAuthorized=$false};
      $heldReuse+=@{proof=$proof;parent=$ph;child=$ch;parentBirth=$pn;childBirth=$cn};$historicalReuseProofs+=$proof;
    } catch {continue};
  }
  foreach($held in $heldReuse){
    try {
      $held.proof.sameHandlesLiveAtBothBoundaries=(!$held.parent.HasExited -and !$held.child.HasExited);
      $held.proof.nativeIdentityMatchesAtBothBoundaries=($held.parent.StartTime.ToUniversalTime().ToFileTimeUtc() -eq $held.parentBirth -and
        $held.child.StartTime.ToUniversalTime().ToFileTimeUtc() -eq $held.childBirth -and
        ($held.parent.ProcessName+'.exe') -ieq $held.proof.parent.name -and ($held.child.ProcessName+'.exe') -ieq $held.proof.child.name);
    } catch {$held.proof.sameHandlesLiveAtBothBoundaries=$false;$held.proof.nativeIdentityMatchesAtBothBoundaries=$false};
  }
  $queryEnded=[DateTime]::UtcNow;
  $collector=@{pid=[int]$self.ProcessId;parentPid=[int]$self.ParentProcessId;name=$self.Name;createdAt=$collectorBirth;
    nativeCreationFileTime=[string]$collectorNative;callerIdentity=@{pid=[int]$wrapper.ProcessId;parentPid=[int]$wrapper.ParentProcessId;name=$wrapper.Name;createdAt=$wrapperBirth};callerNativeCreationFileTime=[string]$wrapperNative;
    identityVerified=$true;directCallerVerified=$true;queryStartedAt=$queryStarted.ToString('o');queryEndedAt=$queryEnded.ToString('o');
    queryStartedFileTime=[string]$queryStarted.ToFileTimeUtc();queryEndedFileTime=[string]$queryEnded.ToFileTimeUtc();
    birthPrecision='CIM_MICROSECOND_MATCH_NATIVE_FILETIME_FLOOR10';ownershipGranted=$false;terminationAuthorized=$false};
  @{ownedProcesses=@($owned);unknownProcesses=@($unknown);opaqueUnscopedCandidates=@($opaque);opaqueUnscopedCandidateCount=@($opaque).Count;
    wrapperIdentityVerified=$true;diagnosticCollector=$collector;diagnosticCollectorCandidates=@($collectorCandidates);historicalParentReuseCandidates=@($historicalReuseProofs);
    historicalParentObservations=@{schemaVersion=1;scope='SAME_CIM_SNAPSHOT_HISTORICAL_PARENT_OBSERVATION_ONLY';candidateLimit=16;
      candidateTotal=$historicalCandidates.Count;candidateTruncated=($historicalCandidates.Count -gt 16);records=@($historicalObservations);
      queryStartedAt=$collector.queryStartedAt;queryEndedAt=$collector.queryEndedAt;ownershipGranted=$false;terminationAuthorized=$false};
    scope='NAMED_PROJECT_OR_RUN_PROFILE_OR_EXACT_CAPTURED_BIRTH_OR_UNVERIFIED_HISTORICAL_PARENT';
    scopeLimitations=@('SAMPLED_NOT_EXHAUSTIVE','OPAQUE_NAMED_CANDIDATES_ARE_UNKNOWN_NOT_OWNED','HISTORICAL_PARENT_PID_IS_NOT_TERMINATION_AUTHORITY','COLLECTOR_DIRECT_CHILD_EXCLUSION_IS_OBSERVATION_ONLY')} | ConvertTo-Json -Depth 8 -Compress
} finally {
  foreach($heldChild in $heldChildren){$heldChild.Dispose()};
  if($wrapperHandle){$wrapperHandle.Dispose()};if($collectorHandle){$collectorHandle.Dispose()};
}`;
  const result = execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", input: JSON.stringify({ projectRoot, profilePaths, identities, wrapperIdentity }), windowsHide: true, timeout: timeoutMs,
  });
  if (result.error || result.status !== 0) throw new Error("E2E scoped residual 测量失败；禁止猜测0或终止未知进程");
  const snapshot = JSON.parse(result.stdout.trim());
  const collector = snapshot.diagnosticCollector;
  const fileTime = value => typeof value === "string" && /^\d{17,18}$/u.test(value) ? BigInt(value) : null;
  const canonicalBirth = item => validBirth(item) && new Date(item.createdAt).toISOString() === item.createdAt.slice(0, 23) + "Z";
  const cimFileTime = item => canonicalBirth(item) ? BigInt(Date.parse(item.createdAt)) * 10_000n + 116444736000000000n + BigInt(item.createdAt.slice(23, 27)) : null;
  const collectorNative = fileTime(collector?.nativeCreationFileTime);
  const callerNative = fileTime(collector?.callerNativeCreationFileTime);
  const queryStart = fileTime(collector?.queryStartedFileTime), queryEnd = fileTime(collector?.queryEndedFileTime);
  if (!Array.isArray(snapshot.ownedProcesses) || !Array.isArray(snapshot.unknownProcesses) || snapshot.wrapperIdentityVerified !== true ||
    !Array.isArray(snapshot.opaqueUnscopedCandidates) || !Number.isSafeInteger(snapshot.opaqueUnscopedCandidateCount) ||
    snapshot.opaqueUnscopedCandidateCount !== snapshot.opaqueUnscopedCandidates.length || !Array.isArray(snapshot.scopeLimitations) ||
    !Array.isArray(snapshot.diagnosticCollectorCandidates) || !canonicalBirth(collector) || !canonicalBirth(wrapperIdentity) ||
    typeof collector.name !== "string" || !/^powershell\.exe$/iu.test(collector.name) ||
    !Number.isSafeInteger(collector.pid) || collector.pid < 1 || collector.parentPid !== wrapperIdentity.pid ||
    collector.identityVerified !== true || collector.directCallerVerified !== true ||
    collector.ownershipGranted !== false || collector.terminationAuthorized !== false ||
    collector.birthPrecision !== "CIM_MICROSECOND_MATCH_NATIVE_FILETIME_FLOOR10" || collectorNative === null ||
    cimFileTime(collector) / 10n !== collectorNative / 10n ||
    !queryStart || !queryEnd || collectorNative > queryStart || queryStart > queryEnd ||
    cimFileTime({ createdAt: collector.queryStartedAt }) !== queryStart || cimFileTime({ createdAt: collector.queryEndedAt }) !== queryEnd ||
    !collector.callerIdentity || ["pid", "parentPid", "name", "createdAt"].some(key => collector.callerIdentity[key] !== wrapperIdentity[key]) ||
    callerNative === null || collectorNative < callerNative ||
    callerNative / 10n !== cimFileTime(wrapperIdentity) / 10n) {
    throw new Error("E2E scoped residual 测量不完整");
  }
  // Exclusions never extend captured identities or termination authority.
  // Preserve the complete pre-exclusion list and every identity proof.
  const excluded = [], excludedCollector = [], unknown = [], excludedReusedParent = [];
  for (const row of snapshot.unknownProcesses) {
    const candidates = snapshot.diagnosticCollectorCandidates.filter(candidate => candidate.pid === row.pid && candidate.createdAt === row.createdAt);
    const candidate = candidates.length === 1 ? candidates[0] : undefined;
    const childNative = fileTime(candidate?.nativeCreationFileTime);
    if (typeof row.name === "string" && row.name.toLowerCase() === "conhost.exe" && row.parentPid === collector.pid &&
      ["DIAGNOSTIC_COLLECTOR_DIRECT_CHILD_CANDIDATE", "UNVERIFIED_HISTORICAL_PARENT_CANDIDATE"].includes(row.scopeReason) &&
      canonicalBirth(row) && candidate?.parentPid === row.parentPid && candidate.name === row.name &&
      candidate.scopeKnownNonProjectProfile === true && candidate.nativeBirthVerified === true &&
      childNative !== null && childNative / 10n === cimFileTime(row) / 10n && childNative >= collectorNative && childNative <= queryEnd) {
      excludedCollector.push({ ...row, exclusion: "DIAGNOSTIC_COLLECTOR_DIRECT_CHILD_OBSERVATION_ONLY",
        collectorIdentity: collector, nativeCreationFileTime: candidate.nativeCreationFileTime,
        ownershipGranted: false, terminationAuthorized: false });
      continue;
    }
    // An older nonnamed child cannot belong to any captured later PPID
    // incarnation. An unproved current-collector child cannot use that shortcut.
    const parents = identities.filter(parent => parent.pid === row.parentPid);
    const namedScope = typeof row.name !== "string" || /^(?:node|chrome|chromium|headless_shell|electron|VERIDIA)\.exe$/iu.test(row.name);
    if (row.parentPid !== collector.pid && row.scopeReason === "UNVERIFIED_HISTORICAL_PARENT_CANDIDATE" && !namedScope && canonicalBirth(row) && parents.length > 0 &&
      parents.every(parent => canonicalBirth(parent) && row.createdAt < parent.createdAt)) {
      excluded.push({ ...row, exclusion: "CHILD_BIRTH_PRECEDES_ALL_CAPTURED_PARENT_INCARNATIONS",
        capturedParentIdentities: parents.map(({ pid, parentPid, createdAt }) => ({ pid, parentPid, createdAt })),
        ownershipGranted: false, terminationAuthorized: false });
    } else {
      const proofs = Array.isArray(snapshot.historicalParentReuseCandidates) && snapshot.historicalParentReuseCandidates.length <= 16 ?
        snapshot.historicalParentReuseCandidates.filter(proof => proof?.child?.pid === row.pid && proof.child.createdAt === row.createdAt) : [];
      const proof = proofs.length === 1 ? proofs[0] : undefined;
      const parentNative = fileTime(proof?.parent?.nativeCreationFileTime), currentChildNative = fileTime(proof?.child?.nativeCreationFileTime);
      const parentBirths = parents.map(parent => fileTime(parent.nativeBirthStamp));
      const sameRow = (a, b) => a && ["pid", "parentPid", "name", "createdAt"].every(key => a[key] === b[key]);
      const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
      const proofShape = exactKeys(proof, ["child", "parent", "sameSnapshotUniqueRows", "childScopeKnownNonProjectProfile",
        "parentScopeKnownNonProjectProfile", "noKnownOwnedAncestorSameSnapshot", "sameHandlesLiveAtBothBoundaries", "nativeIdentityMatchesAtBothBoundaries", "ownershipGranted", "terminationAuthorized"]) &&
        [proof.child, proof.parent].every(item => exactKeys(item, ["pid", "parentPid", "name", "createdAt", "nativeCreationFileTime"]) &&
          Number.isSafeInteger(item.pid) && item.pid > 0 && item.pid <= 2147483647 &&
          Number.isSafeInteger(item.parentPid) && item.parentPid >= 0 && item.parentPid <= 2147483647 &&
          typeof item.name === "string" && /^[\p{L}\p{N}_. ()\[\]-]{1,260}$/u.test(item.name));
      if (row.parentPid !== collector.pid && row.scopeReason === "UNVERIFIED_HISTORICAL_PARENT_CANDIDATE" && !namedScope &&
        canonicalBirth(row) && parents.length > 0 && parentBirths.every((birth, i) => birth !== null && canonicalBirth(parents[i]) && birth / 10n === cimFileTime(parents[i]) / 10n) &&
        proofShape && proof.sameSnapshotUniqueRows === true && proof.childScopeKnownNonProjectProfile === true && proof.parentScopeKnownNonProjectProfile === true &&
        proof.noKnownOwnedAncestorSameSnapshot === true && proof.parent.parentPid !== wrapperIdentity.pid && proof.parent.parentPid !== collector.pid &&
        !identities.some(identity => identity.pid === proof.parent.parentPid) &&
        proof.sameHandlesLiveAtBothBoundaries === true && proof.nativeIdentityMatchesAtBothBoundaries === true &&
        proof.ownershipGranted === false && proof.terminationAuthorized === false && sameRow(proof.child, row) &&
        canonicalBirth(proof.parent) && proof.parent.pid === row.parentPid && typeof proof.parent.name === "string" &&
        !/^(?:node|chrome|chromium|headless_shell|electron|VERIDIA)\.exe$/iu.test(proof.parent.name) &&
        parentNative !== null && currentChildNative !== null && currentChildNative / 10n === cimFileTime(row) / 10n &&
        parentNative / 10n === cimFileTime(proof.parent) / 10n && parentNative < currentChildNative &&
        parentBirths.every(birth => birth < parentNative) && parentNative <= queryStart && currentChildNative <= queryStart) {
        excludedReusedParent.push({ ...row, exclusion: "CURRENT_NATIVE_PARENT_INCARNATION_PRECEDES_CHILD_BIRTH",
          evidence: proof, capturedParentIdentities: parents.map(ownershipIdentityProjection),
          timeOrderingAssumption: "UTC_PROCESS_CREATION_ORDER_SAME_AS_EXISTING_CHILD_BEFORE_PARENT_GUARD",
          ownershipGranted: false, terminationAuthorized: false });
      } else unknown.push(row);
    }
  }
  const eligible = rows => rows.filter(row => row.scopeReason === "UNVERIFIED_HISTORICAL_PARENT_CANDIDATE")
    .sort((a, b) => a.pid - b.pid || a.parentPid - b.parentPid || String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""), "en"));
  const rawCandidates = eligible(snapshot.unknownProcesses), remainingCandidates = eligible(unknown);
  const rawEvidence = snapshot.historicalParentObservations;
  const emptyEvidence = reason => ({ schemaVersion: 1, status: remainingCandidates.length ? "NOT_MEASURED" : "NOT_APPLICABLE",
    reason, scope: "SAME_CIM_SNAPSHOT_HISTORICAL_PARENT_OBSERVATION_ONLY", candidateLimit: 16,
    boundScope: "RAW_PRE_EXCLUSION_CANDIDATES", remainingUnknownCandidateCount: remainingCandidates.length,
    unobservedRemainingUnknownCandidateCount: remainingCandidates.length, records: [],
    ownershipGranted: false, terminationAuthorized: false, originalUnknownClassificationChanged: false });
  let historicalParentFailureDiagnostics = emptyEvidence("NO_REMAINING_HISTORICAL_PARENT_UNKNOWN");
  if (remainingCandidates.length) {
    let rejectionCode = "ENVELOPE_CONTRACT", rejectionRecordIndex = null;
    // This is unvalidated observation evidence, never ownership/exit proof.
    // Do not copy arbitrary raw keys, command lines, paths or exception text.
    const numberProjection = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647 ? value : null;
    const birthProjection = value => typeof value === "string" && /^[0-9TZ:+.\-]{1,40}$/u.test(value) ? value : null;
    const rowProjection = value => ({ pid: numberProjection(value?.pid), parentPid: numberProjection(value?.parentPid),
      name: typeof value?.name === "string" && /^[\p{L}\p{N}_. ()\[\]-]{1,260}$/u.test(value.name) ? value.name : null,
      createdAt: birthProjection(value?.createdAt),
      unexpectedKeys: value && typeof value === "object" && !Array.isArray(value) ?
        Object.keys(value).some(key => !["pid", "parentPid", "name", "createdAt"].includes(key)) : false });
    const rawRecords = Array.isArray(rawEvidence?.records) ? rawEvidence.records : [];
    const observationCapture = { status: "UNVALIDATED_SAME_SNAPSHOT_CAPTURE", candidateLimit: 16, parentRowLimit: 4,
      candidateTotal: numberProjection(rawEvidence?.candidateTotal), candidateTruncated: typeof rawEvidence?.candidateTruncated === "boolean" ? rawEvidence.candidateTruncated : null,
      queryStartedAt: birthProjection(rawEvidence?.queryStartedAt), queryEndedAt: birthProjection(rawEvidence?.queryEndedAt),
      recordCount: rawRecords.length, recordsTruncated: rawRecords.length > 16,
      records: rawRecords.slice(0, 16).map(item => ({ candidate: rowProjection(item?.candidate),
        currentParentRowCount: numberProjection(item?.currentParentRowCount),
        currentParentRowsTruncated: typeof item?.currentParentRowsTruncated === "boolean" ? item.currentParentRowsTruncated : null,
        parentObservation: ["ABSENT_IN_THIS_SNAPSHOT", "ONE_ROW_IN_THIS_SNAPSHOT", "MULTIPLE_ROWS_IN_THIS_SNAPSHOT"].includes(item?.parentObservation) ? item.parentObservation : null,
        currentParentRows: Array.isArray(item?.currentParentRows) ? item.currentParentRows.slice(0, 4).map(rowProjection) : [],
        unexpectedKeys: item && typeof item === "object" && !Array.isArray(item) ? Object.keys(item).some(key =>
          !["candidate", "currentParentRowCount", "currentParentRows", "currentParentRowsTruncated", "parentObservation"].includes(key)) : false })),
      ownershipGranted: false, terminationAuthorized: false };
    try {
      const sameKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value) &&
        JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
      const safeRow = row => sameKeys(row, ["pid", "parentPid", "name", "createdAt"]) &&
        Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid <= 2147483647 &&
        Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 && row.parentPid <= 2147483647 &&
        typeof row.name === "string" && /^[\p{L}\p{N}_. ()\[\]-]{1,260}$/u.test(row.name) &&
        (row.createdAt === null || canonicalBirth(row));
      const equalRow = (a, b) => ["pid", "parentPid", "name", "createdAt"].every(key => a[key] === b[key]);
      if (!sameKeys(rawEvidence, ["schemaVersion", "scope", "candidateLimit", "candidateTotal", "candidateTruncated", "records",
        "queryStartedAt", "queryEndedAt", "ownershipGranted", "terminationAuthorized"]) || rawEvidence.schemaVersion !== 1 ||
        rawEvidence.scope !== "SAME_CIM_SNAPSHOT_HISTORICAL_PARENT_OBSERVATION_ONLY" || rawEvidence.candidateLimit !== 16 ||
        rawEvidence.candidateTotal !== rawCandidates.length || rawEvidence.candidateTruncated !== (rawCandidates.length > 16) ||
        rawEvidence.queryStartedAt !== collector.queryStartedAt || rawEvidence.queryEndedAt !== collector.queryEndedAt ||
        rawEvidence.ownershipGranted !== false || rawEvidence.terminationAuthorized !== false ||
        !Array.isArray(rawEvidence.records) || rawEvidence.records.length !== Math.min(16, rawCandidates.length)) throw new Error("INVALID_DIAGNOSTIC");
      const records = [];
      for (const [index, item] of rawEvidence.records.entries()) {
        rejectionRecordIndex = index;
        rejectionCode = "RECORD_KEYS_CANDIDATE_IDENTITY_OR_BINDING";
        if (!sameKeys(item, ["candidate", "currentParentRowCount", "currentParentRows", "currentParentRowsTruncated", "parentObservation"]) ||
          !safeRow(item.candidate) || !equalRow(item.candidate, rawCandidates[index])) throw new Error("INVALID_DIAGNOSTIC");
        rejectionCode = "PARENT_ARRAY_COUNT_OR_OBSERVATION";
        if (!Number.isSafeInteger(item.currentParentRowCount) || item.currentParentRowCount < 0 ||
          !Array.isArray(item.currentParentRows) || item.currentParentRows.length !== Math.min(4, item.currentParentRowCount) ||
          item.currentParentRowsTruncated !== (item.currentParentRowCount > 4) ||
          item.parentObservation !== (item.currentParentRowCount === 0 ? "ABSENT_IN_THIS_SNAPSHOT" : item.currentParentRowCount === 1 ? "ONE_ROW_IN_THIS_SNAPSHOT" : "MULTIPLE_ROWS_IN_THIS_SNAPSHOT")) throw new Error("INVALID_DIAGNOSTIC");
        rejectionCode = "PARENT_IDENTITY_BINDING_OR_ORDER";
        if (item.currentParentRows.some(row => !safeRow(row) || row.pid !== item.candidate.parentPid) ||
          item.currentParentRows.some((row, i, rows) => i > 0 && rows[i - 1].parentPid > row.parentPid)) throw new Error("INVALID_DIAGNOSTIC");
        if (!remainingCandidates.some(candidate => equalRow(candidate, item.candidate))) continue;
        const capturedParents = identities.filter(parent => parent.pid === item.candidate.parentPid)
          .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""), "en") || a.parentPid - b.parentPid);
        const project = row => {
          rejectionCode = "CAPTURED_PARENT_IDENTITY";
          if (!Number.isSafeInteger(row.pid) || row.pid <= 0 || row.pid > 2147483647 ||
            !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 || row.parentPid > 2147483647) throw new Error("INVALID_DIAGNOSTIC");
          const full = fileTime(row.nativeBirthStamp), canonical = cimFileTime(row);
          return { pid: row.pid, parentPid: row.parentPid,
            name: typeof row.name === "string" && /^[\p{L}\p{N}_. ()\[\]-]{1,260}$/u.test(row.name) ? row.name : "NOT_AVAILABLE",
            createdAt: canonicalBirth(row) ? row.createdAt : null,
            nativeBirthStamp: full !== null && canonical !== null && full / 10n === canonical / 10n ? row.nativeBirthStamp : null };
        };
        records.push({ candidate: project(item.candidate), parentObservation: item.parentObservation,
          currentParentRowCount: item.currentParentRowCount, currentParentRowsTruncated: item.currentParentRowsTruncated,
          currentParentRows: item.currentParentRows.map(project), capturedParentIdentityCount: capturedParents.length,
          capturedParentIdentitiesTruncated: capturedParents.length > 4, capturedParentIdentities: capturedParents.slice(0, 4).map(project),
          ownershipGranted: false, terminationAuthorized: false, originalUnknownClassificationChanged: false });
      }
      historicalParentFailureDiagnostics = { ...emptyEvidence("VALIDATED_SAME_SNAPSHOT_OBSERVATION_ONLY"), status: "RECORDED",
        queryStartedAt: collector.queryStartedAt, queryEndedAt: collector.queryEndedAt,
        rawCandidateCount: rawCandidates.length, rawCandidatesTruncated: rawCandidates.length > 16,
        unobservedRemainingUnknownCandidateCount: remainingCandidates.length - records.length, records };
    } catch {
      // Diagnostic failure never replaces or relaxes the original UNKNOWN rows.
      historicalParentFailureDiagnostics = { ...emptyEvidence("MALFORMED_OR_UNBOUND_DIAGNOSTIC_NOT_TRUSTED"),
        rejection: { code: rejectionCode, recordIndex: rejectionRecordIndex }, observationCapture };
    }
  }
  const snapshotWithoutRawParentEvidence = { ...snapshot };
  delete snapshotWithoutRawParentEvidence.historicalParentObservations;
  delete snapshotWithoutRawParentEvidence.historicalParentReuseCandidates;
  return { ...snapshotWithoutRawParentEvidence, rawUnknownProcesses: [...snapshot.unknownProcesses], unknownProcesses: unknown,
    historicalParentFailureDiagnostics,
    excludedHistoricalParentCandidates: excluded, excludedDiagnosticCollectorCandidates: excludedCollector,
    excludedReusedHistoricalParentCandidates: excludedReusedParent,
    diagnosticCollectorObservation: excludedCollector.length > 0 ? "OBSERVED" : "NOT_OBSERVED" };
}

export function matchingOwnedProcesses(processes, identities) {
  const expected = new Set(identities
    .filter(item => typeof item.createdAt === "string" && item.createdAt.length > 0)
    .map(item => `${item.pid}:${item.createdAt}`));
  return processes.filter(item => typeof item.createdAt === "string" && item.createdAt.length > 0 && expected.has(`${item.pid}:${item.createdAt}`));
}

export function planWindowsTreeTermination(processes, identities, rootPid) {
  const owned = matchingOwnedProcesses(processes, identities);
  if (owned.some(item => item.pid === rootPid)) return [rootPid];
  const live = new Set(owned.map(item => item.pid));
  return owned.filter(item => !live.has(item.parentPid)).map(item => item.pid);
}

export function orderOwnedProcessesLeafFirst(identities, wrapperPid = process.pid) {
  const unique = new Map();
  for (const item of identities) {
    if (!Number.isSafeInteger(item.pid) || item.pid < 1 || item.pid === wrapperPid ||
      typeof item.createdAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(item.createdAt) ||
      !Number.isFinite(Date.parse(item.createdAt))) throw new Error("E2E 进程终止拒绝未知物理身份");
    if (unique.has(item.pid)) throw new Error("E2E 进程终止拒绝重复 PID 身份");
    unique.set(item.pid, item);
  }
  const depth = item => {
    let current = item;
    let value = 0;
    const visited = new Set([item.pid]);
    while (unique.has(current.parentPid)) {
      if (visited.has(current.parentPid)) throw new Error("E2E 进程所有权树存在循环");
      visited.add(current.parentPid);
      current = unique.get(current.parentPid);
      value += 1;
    }
    return value;
  };
  return [...unique.values()].sort((left, right) => depth(right) - depth(left));
}

export function terminateWindowsOwnedProcesses(identities, execute = spawnSync, timeoutMs = 5_000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5_000) throw new Error("无效 E2E Handle 终止期限");
  const ordered = orderOwnedProcessesLeafFirst(identities);
  if (ordered.length === 0) return { terminatedPids: [], exitedPids: [] };
  const encoded = Buffer.from(JSON.stringify(ordered.map(({ pid, createdAt }) => ({ pid, createdAt }))), "utf8").toString("base64");
  const script = `$ErrorActionPreference='Stop';
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json;
$handles = @(); $terminated = @(); $exited = @();
try {
  foreach ($identity in $expected) {
    try { $process = [Diagnostics.Process]::GetProcessById([int]$identity.pid); $null = $process.Handle }
    catch {
      if (@(Get-CimInstance Win32_Process -Filter "ProcessId=$($identity.pid)").Count -ne 0) { throw 'LIVE_PROCESS_HANDLE_UNAVAILABLE' }
      $exited += [int]$identity.pid; continue
    }
    $handles += $process;
    $actual = $process.StartTime.ToUniversalTime().ToFileTimeUtc();
    $captured = [DateTimeOffset]::ParseExact($identity.createdAt, 'yyyy-MM-ddTHH:mm:ss.fffffffZ', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).UtcDateTime.ToFileTimeUtc();
    if ([decimal]::Floor([decimal]$actual / 10) -ne [decimal]::Floor([decimal]$captured / 10)) { throw 'LIVE_PROCESS_BIRTH_MISMATCH' }
  }
  # All retained native handles are birth-validated before ANY termination.
  # Input is leaf-first. Kill reuses this Process object's opened OS handle;
  # it never reopens a raw PID which could now belong to an unrelated process.
  foreach ($process in $handles) { if (!$process.HasExited) { $process.Kill(); $terminated += $process.Id } }
  @{terminatedPids=@($terminated); exitedPids=@($exited)} | ConvertTo-Json -Depth 3 -Compress
} finally { foreach ($process in $handles) { $process.Dispose() } }`;
  const result = execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: timeoutMs });
  if (result.error || result.status !== 0) throw new Error("E2E 已捕获进程物理身份验证或 Handle 终止失败；禁止猜测 PID");
  return JSON.parse(result.stdout.trim());
}

export function readServerSnapshots(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter(name => /^server-process-\d+\.json$/u.test(name))
    .flatMap(name => {
      try { return [JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))]; }
      catch { return []; }
    });
}

export function exportFailureDiagnostics({ runDirectory, outputDirectory, metadata, runtime, secrets = [] }) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const rawLog = path.join(runDirectory, "next-server.log");
  const log = fs.existsSync(rawLog) ? fs.readFileSync(rawLog, "utf8").split(/\r?\n/u).slice(-300).join("\n") : "SERVER_LOG_UNAVAILABLE";
  fs.writeFileSync(path.join(outputDirectory, "next-server.log"), `${redactE2eDiagnosticText(log, secrets)}\n`);
  const report = redactE2eDiagnosticValue({ ...metadata, runtime,
    serverProcesses: readServerSnapshots(path.join(runDirectory, "server-diagnostics")) }, secrets);
  fs.writeFileSync(path.join(outputDirectory, "run.json"), `${JSON.stringify(report, null, 2)}\n`);
}
