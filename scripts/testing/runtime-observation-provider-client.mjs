import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { TextDecoder } from "node:util";

// Read-only persistent native census. Importing this module starts no provider.
const CAP_MS = 15_000;
const FRAME_BYTES_CAP = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BIRTH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u;
const STAMP = /^\d{17,18}$/u;
const PRECISE_UTC_SOURCE = "GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME";
const FILETIME_MAX = 2650467743999999999n;
const positiveFileTime = value => typeof value === "string" && /^[1-9]\d{0,18}$/u.test(value) && BigInt(value) <= FILETIME_MAX;
const birthTicks = value => {
  if (typeof value !== "string" || !BIRTH.test(value) || !Number.isFinite(Date.parse(value))) return null;
  if (new Date(Date.parse(value)).toISOString() !== value.slice(0, 23) + "Z") return null;
  return BigInt(Date.parse(value)) * 10_000n + 116444736000000000n + BigInt(value.slice(23, 27));
};
const safeCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,96}$/u.test(value) ? value : "UNCLASSIFIED_PROVIDER_ERROR";
const NATIVE_FAILURE_CATEGORIES = new Set([
  "NATIVE_LAYOUT_UNSUPPORTED", "NATIVE_NTDLL_UNAVAILABLE", "NATIVE_BASIC_EXPORT_UNAVAILABLE",
  "NATIVE_QUERY_DEADLINE", "NATIVE_HANDLE_UNAVAILABLE", "NATIVE_HELD_PID_MISMATCH", "NATIVE_BASIC_ABI_UNSUPPORTED",
  "NATIVE_HELD_BASIC_INVALID", "NATIVE_HELD_BIRTH_UNAVAILABLE", "NATIVE_HELD_IMAGE_UNAVAILABLE", "NATIVE_HELD_NAME_INVALID",
  "NATIVE_PROCESS_HANDLE_CLOSE_FAILED", "NATIVE_RETAINED_IDENTITY_RECHECK_FAILED", "NATIVE_RETAINED_LIVENESS_RECHECK_FAILED",
  "NATIVE_PROVIDER_CALLER_IDENTITY_MISMATCH", "NATIVE_PROCESS_SNAPSHOT_FAILED", "NATIVE_PROCESS_FIRST_FAILED",
  "NATIVE_PROCESS_ROW_INVALID", "NATIVE_PROCESS_ITERATION_INCOMPLETE", "NATIVE_PROCESS_EMPTY_INVENTORY",
  "NATIVE_SNAPSHOT_CLOSE_FAILED", "NATIVE_TCP_TABLE_FAILED", "NATIVE_TCP_TABLE_BOUNDS_INVALID", "NATIVE_TCP_ROW_INVALID",
  "NATIVE_QUERY_INPUT_INVALID", "PROVIDER_INPUT_INVALID", "PROVIDER_PARTIAL_COMMAND_AT_EOF", "PROVIDER_COMMAND_TOO_LARGE",
  "PROVIDER_COMMAND_BINDING_INVALID", "UNKNOWN_NATIVE_OR_PROTOCOL_FAILURE",
  "SPI_SYSTEM_EXPORT_UNAVAILABLE", "SPI_VERSION_EXPORT_UNAVAILABLE", "SPI_UNAPPROVED_OS_ABI",
  "SPI_PROVIDER_BINDING_ALREADY_ESTABLISHED", "SPI_PROVIDER_BINDING_UNAVAILABLE", "SPI_IMAGE_NAME_INVALID", "SPI_IMAGE_UTF16_INVALID",
  "SPI_RETURN_LENGTH_INVALID", "SPI_ENTRY_BOUNDS_INVALID", "SPI_THREAD_OR_NEXT_BOUNDS_INVALID", "SPI_INVENTORY_LIMIT_EXCEEDED",
  "SPI_PID_INVALID_OR_DUPLICATE", "SPI_IDLE_SENTINEL_INVALID", "SPI_UNICODE_BOUNDS_INVALID", "SPI_BIRTH_OUTSIDE_CAPTURE_UTC_BOUND",
  "SPI_EMPTY_INVENTORY", "SPI_QUERY_NTSTATUS_FAILED", "SPI_SELECTED_HELD_BINDING_MISMATCH", "SPI_SELECTED_HELD_COUNT_INVALID",
  "SPI_SELECTED_SNAPSHOT_MISMATCH", "SPI_WORKING_SET_UNREPRESENTABLE",
  "SPI_PRECISE_UTC_EXPORT_UNAVAILABLE", "SPI_PRECISE_UTC_BOUND_INVALID",
]);
export const safeNativeFailureCategory = value => NATIVE_FAILURE_CATEGORIES.has(value) ? value : "UNKNOWN_NATIVE_OR_PROTOCOL_FAILURE";
// Failure provenance only: no process ownership or inferred exit authority.
function validateBirthGuardFailure(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  if (JSON.stringify(keys) !== '["branch","clockSource","creationSigned","parentPid","pid","utcBirthUpperBound"]' ||
      !["NON_POSITIVE_BIRTH", "AFTER_PRECISE_UTC_BOUND"].includes(value.branch) ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0x7fffffff ||
      !Number.isSafeInteger(value.parentPid) || value.parentPid < 0 || value.parentPid > 0x7fffffff ||
      typeof value.creationSigned !== "string" || !/^(?:0|-?[1-9]\d{0,18})$/u.test(value.creationSigned) ||
      !positiveFileTime(value.utcBirthUpperBound) || value.clockSource !== PRECISE_UTC_SOURCE) {
    throw new Error("PROVIDER_BIRTH_GUARD_FAILURE_INVALID");
  }
  const creation = BigInt(value.creationSigned), upper = BigInt(value.utcBirthUpperBound);
  if (creation < -9223372036854775808n || creation > 9223372036854775807n ||
      (value.branch === "NON_POSITIVE_BIRTH" ? creation > 0n : creation <= upper)) {
    throw new Error("PROVIDER_BIRTH_GUARD_FAILURE_INVALID");
  }
  return { branch: value.branch, pid: value.pid, parentPid: value.parentPid, creationSigned: value.creationSigned,
    utcBirthUpperBound: value.utcBirthUpperBound, clockSource: value.clockSource };
}
const IDENTITY_FAILURE_OPERATIONS = Object.freeze({
  NATIVE_HANDLE_UNAVAILABLE: "OPEN_PROCESS",
  NATIVE_HELD_PID_MISMATCH: "GET_PROCESS_ID",
  NATIVE_HELD_BASIC_INVALID: "NT_QUERY_BASIC",
  NATIVE_HELD_BIRTH_UNAVAILABLE: "GET_PROCESS_TIMES",
  NATIVE_HELD_IMAGE_UNAVAILABLE: "QUERY_FULL_PROCESS_IMAGE_NAME",
  NATIVE_HELD_NAME_INVALID: "VALIDATE_IMAGE_BASENAME",
  UNKNOWN_NATIVE_IDENTITY_READ_FAILURE: "UNKNOWN",
});

// Provenance only: a Win32 code (including 87) is never proof of exit or authority.
export function validateNativeIdentityFailure(value) {
  const keys = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const win32Valid = value?.win32Error === null || Number.isSafeInteger(value?.win32Error) && value.win32Error >= 0 && value.win32Error <= 0xffffffff;
  const ntValid = value?.ntStatus === null || Number.isSafeInteger(value?.ntStatus) && value.ntStatus >= -0x80000000 && value.ntStatus <= 0x7fffffff;
  if (JSON.stringify(keys) !== '["code","ntStatus","operation","win32Error"]' ||
      !Object.hasOwn(IDENTITY_FAILURE_OPERATIONS, value.code) || IDENTITY_FAILURE_OPERATIONS[value.code] !== value.operation ||
      !win32Valid || !ntValid ||
      (value.operation === "NT_QUERY_BASIC" ? value.ntStatus === null || value.win32Error !== null : value.ntStatus !== null) ||
      value.operation === "OPEN_PROCESS" && value.win32Error === null ||
      ["UNKNOWN", "VALIDATE_IMAGE_BASENAME"].includes(value.operation) && value.win32Error !== null) {
    throw new Error("PROVIDER_OPAQUE_FAILURE_PROVENANCE_INVALID");
  }
  return { code: value.code, operation: value.operation, win32Error: value.win32Error, ntStatus: value.ntStatus };
}

export function createPersistentRuntimeProvider({ runId, observerId, wrapperIdentity, port,
  startupDeadlineMs: callerStartupDeadlineMs, spawnImpl = spawn, now = () => performance.now(),
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  const wrapperTicks = birthTicks(wrapperIdentity?.createdAt);
  const providerPath = fileURLToPath(new URL("./runtime-observation-provider.ps1", import.meta.url));
  const nativeSourcePath = fileURLToPath(new URL("./runtime-observation-native.cs", import.meta.url));
  if (!/^[A-Za-z0-9_.-]{1,256}$/u.test(runId || "") || !UUID.test(observerId || "") ||
      !Number.isSafeInteger(wrapperIdentity?.pid) || wrapperIdentity.pid < 1 || wrapperTicks === null || wrapperTicks % 10n !== 0n ||
      !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PROVIDER_CLIENT_INPUT_INVALID");
  }
  const startedMs = now(), startupDeadlineMs = callerStartupDeadlineMs ?? startedMs + CAP_MS;
  if (!Number.isFinite(startupDeadlineMs) || startupDeadlineMs <= startedMs || startupDeadlineMs > startedMs + CAP_MS) throw new Error("PROVIDER_STARTUP_DEADLINE_INVALID");
  const receipts = [];
  let state = "STARTING", firstFailure = null, providerIdentity = null, spawnFailed = false;
  let child, startupTimer, sequence = 0, pending = null, stopPromise, stopDeadlineMs;
  let eofSent = false, eofAcknowledged = false, stdoutEnded = false, closeObserved = false;
  let exitObserved = false, exitCode = null, closeCode = null, joined = false;
  let buffer = "", stderrBytes = 0;
  // Fatal byte validation; retain BOM so framing does not silently broaden.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let resolveReady, rejectReady, resolveClosed;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => undefined);
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const receipt = (event, fields = {}) => receipts.push({ event, atMs: now(), ...fields });
  const nativeFailureReceipt = (message, fields = {}) => {
    const category = safeNativeFailureCategory(message.nativeErrorCategory);
    let birthGuardFailure;
    if (category === "SPI_BIRTH_OUTSIDE_CAPTURE_UTC_BOUND") birthGuardFailure = validateBirthGuardFailure(message.birthGuardFailure);
    else if (message.birthGuardFailure !== undefined && message.birthGuardFailure !== null) throw new Error("PROVIDER_BIRTH_GUARD_CATEGORY_INVALID");
    receipt("NATIVE_FAILURE_CATEGORY", { ...fields, category, ...(birthGuardFailure ? { birthGuardFailure } : {}) });
    if (message.nativeSecondaryErrorCategory !== undefined && message.nativeSecondaryErrorCategory !== null) {
      if (message.nativeSecondaryErrorCategory !== "NATIVE_PROCESS_HANDLE_CLOSE_FAILED") throw new Error("PROVIDER_NATIVE_SECONDARY_CATEGORY_INVALID");
      receipt("NATIVE_SECONDARY_FAILURE_CATEGORY", { ...fields, category: message.nativeSecondaryErrorCategory });
    }
  };
  const snapshot = () => ({ status: firstFailure ? "FAILED" : joined ? "PASSED" : "NOT_COMPLETE", state,
    firstFailure, runId, observerId, port, wrapperPid: wrapperIdentity.pid, wrapperCreatedAt: wrapperIdentity.createdAt,
    providerPid: child?.pid ?? null, providerParentPid: providerIdentity ? wrapperIdentity.pid : null,
    providerNativeBirthStamp: providerIdentity?.providerNativeBirthStamp ?? null, providerCreatedAt: providerIdentity?.providerCreatedAt ?? null,
    wrapperNativeBirthStamp: providerIdentity?.wrapperNativeBirthStamp ?? null,
    startedMs, startupDeadlineMs, stopDeadlineMs: stopDeadlineMs ?? null,
    sequence, inFlightSequence: pending?.sequence ?? null, eofSent, eofAcknowledged,
    stdoutEnded, exitObserved, closeObserved, exitCode, closeCode, joined, stderrBytes,
    receipts: receipts.map(row => ({ ...row })) });
  const annotated = code => {
    const error = new Error(code);
    Object.defineProperty(error, "observation", { get: snapshot }); return error;
  };
  const fail = code => {
    const safe = safeCode(code); firstFailure ??= safe;
    receipt("STICKY_FAILURE", { code: safe });
    clearTimer(startupTimer); rejectReady(annotated(firstFailure));
    if (pending) pending.reject(annotated(firstFailure));
  };
  const bound = (operation, deadlineMs, failureCode) => new Promise((resolve, reject) => {
    const remaining = deadlineMs - now();
    if (!Number.isFinite(remaining) || remaining <= 0) { fail(failureCode); reject(annotated(firstFailure)); return; }
    const timer = setTimer(() => { fail(failureCode); reject(annotated(firstFailure)); }, remaining);
    operation.then(value => {
      clearTimer(timer);
      if (now() >= deadlineMs) { fail(failureCode); reject(annotated(firstFailure)); }
      else if (firstFailure) reject(annotated(firstFailure));
      else resolve(value);
    }, () => { clearTimer(timer); reject(annotated(firstFailure || failureCode)); });
  });
  const basicIdentityMatches = message => message && message.runId === runId && message.observerId === observerId &&
    message.wrapperPid === wrapperIdentity.pid && message.port === port && message.providerPid === child?.pid &&
    message.providerParentPid === wrapperIdentity.pid && message.callerWrapperCanonicalBirth === wrapperIdentity.createdAt &&
    typeof message.callerWrapperNativeBirthStamp === "string" && STAMP.test(message.callerWrapperNativeBirthStamp) &&
    BigInt(message.callerWrapperNativeBirthStamp) / 10n === wrapperTicks / 10n &&
    typeof message.providerNativeBirthStamp === "string" && STAMP.test(message.providerNativeBirthStamp) &&
    BigInt(message.providerNativeBirthStamp) >= wrapperTicks;
  const identityMatches = message => basicIdentityMatches(message) && providerIdentity &&
    message.providerNativeBirthStamp === providerIdentity.providerNativeBirthStamp &&
    message.callerWrapperNativeBirthStamp === providerIdentity.wrapperNativeBirthStamp;


  function sendEofWhenIdle() {
    if (state !== "STOPPING" || pending || eofSent || closeObserved) return;
    eofSent = true;
    receipt("STDIN_EOF_REQUESTED", { sequence });
    try { child.stdin.end(); } catch { fail("PROVIDER_STDIN_EOF_FAILED"); }
  }

  function frame(message) {
    try {
      if (message.event === "READY") {
        if (!basicIdentityMatches(message)) throw new Error("PROVIDER_READY_IDENTITY_INVALID");
        if (providerIdentity) throw new Error("PROVIDER_READY_DUPLICATE");
        const canonicalProviderBirth = birthTicks(message.providerCreatedAt);
        if (canonicalProviderBirth === null || canonicalProviderBirth % 10n !== 0n ||
            canonicalProviderBirth / 10n !== BigInt(message.providerNativeBirthStamp) / 10n) {
          throw new Error("PROVIDER_READY_BIRTH_INVALID");
        }
        providerIdentity = { providerPid: child.pid, providerNativeBirthStamp: message.providerNativeBirthStamp, providerCreatedAt: message.providerCreatedAt,
          wrapperNativeBirthStamp: message.callerWrapperNativeBirthStamp };
        receipt("READY_RECEIVED", { providerPid: message.providerPid, providerNativeBirthStamp: message.providerNativeBirthStamp,
          providerParentPid: message.providerParentPid, wrapperNativeBirthStamp: message.callerWrapperNativeBirthStamp });
        if (state !== "STARTING" || now() >= startupDeadlineMs) throw new Error("PROVIDER_READY_PHASE_OR_DEADLINE_INVALID");
        clearTimer(startupTimer); state = "RUNNING"; resolveReady(snapshot()); return;
      }
      if (message.event === "FAILED") {
        nativeFailureReceipt(message);
        throw new Error("PROVIDER_SETUP_OR_PROTOCOL_FAILED");
      }
      if (!identityMatches(message)) throw new Error("PROVIDER_FRAME_IDENTITY_INVALID");
      if (message.event === "EOF_ACK") {
        if (state !== "STOPPING" || !eofSent || pending || eofAcknowledged || message.eofObserved !== true || message.sequence !== sequence ||
            !Number.isFinite(message.providerElapsedMs) || message.providerElapsedMs < 0 || now() >= stopDeadlineMs) {
          throw new Error("PROVIDER_EOF_ACK_INVALID");
        }
        eofAcknowledged = true; receipt("NATIVE_EOF_ACK", { sequence }); return;
      }
      if (message.event !== "QUERY_RESULT" || !pending || message.sequence !== pending.sequence) throw new Error("PROVIDER_QUERY_SEQUENCE_INVALID");
      const current = pending;
      let runtime;
      try {
        if (!Number.isFinite(message.providerElapsedMs) || message.providerElapsedMs < 0 ||
            message.providerElapsedMs > current.remainingMs || now() >= current.deadlineMs ||
            stopDeadlineMs !== undefined && now() >= stopDeadlineMs) throw new Error("PROVIDER_QUERY_ACTUAL_DEADLINE_EXHAUSTED");
        if (message.error !== null) {
          nativeFailureReceipt(message, { sequence: current.sequence });
          throw new Error(safeCode(message.error));
        }
        if (message.birthGuardFailure !== undefined && message.birthGuardFailure !== null) throw new Error("PROVIDER_BIRTH_GUARD_CATEGORY_INVALID");
        runtime = validateNativeRuntimeSnapshot(message.runtime, { port, wrapperIdentity, providerIdentity });
        if (runtime.providerElapsedMs > message.providerElapsedMs || runtime.providerElapsedMs >= current.remainingMs) {
          throw new Error("PROVIDER_RUNTIME_ELAPSED_INVALID");
        }
        if (now() >= current.deadlineMs || stopDeadlineMs !== undefined && now() >= stopDeadlineMs) {
          throw new Error("PROVIDER_QUERY_ACTUAL_DEADLINE_EXHAUSTED");
        }
        receipt("QUERY_RESULT_VALIDATED", { sequence: current.sequence, providerElapsedMs: message.providerElapsedMs,
          processCount: runtime.processes.length, portCount: runtime.ports.length,
          snapshotIdentityCount: runtime.processes.filter(row => row.pid !== 0).length,
          idleSentinelCount: runtime.processes.filter(row => row.pid === 0).length,
          heldComparisonCount: runtime.heldComparisons.length, osBuild: runtime.spiCoverage.osBuild,
          layoutProfile: runtime.spiCoverage.layoutProfile });
        if (firstFailure) current.reject(annotated(firstFailure)); else current.resolve(runtime);
      } catch (error) { fail(error.message); }
      finally {
        clearTimer(current.timer); pending = null; current.resolveDone(); sendEofWhenIdle();
      }
    } catch (error) { fail(error?.message || "PROVIDER_FRAME_INVALID"); }
  }

  try {
    child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", providerPath,
      "-SourcePath", nativeSourcePath, "-RunId", runId, "-ObserverId", observerId,
      "-WrapperPid", String(wrapperIdentity.pid), "-WrapperCreatedAt", wrapperIdentity.createdAt, "-Port", String(port)],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    // Subscribe before pid validation: failed spawn emits an asynchronous error
    // with no pid; it must not become an unhandled process error.
    child?.once?.("error", () => fail("PROVIDER_PROCESS_ERROR"));
    child?.stdin?.on?.("error", () => fail("PROVIDER_STDIN_STREAM_ERROR"));
    child?.stdout?.on?.("error", () => fail("PROVIDER_STDOUT_STREAM_ERROR"));
    child?.stderr?.on?.("error", () => fail("PROVIDER_STDERR_STREAM_ERROR"));
    if (!child || !Number.isSafeInteger(child.pid) || child.pid < 1 || !child.stdin || !child.stdout || !child.stderr) {
      throw new Error("PROVIDER_SPAWN_IDENTITY_INVALID");
    }
    receipt("PROVIDER_SPAWNED", { providerPid: child.pid });
    child.stdout.on("data", chunk => {
      let decoded;
      try { decoded = decoder.decode(chunk, { stream: true }); }
      catch { fail("PROVIDER_STDOUT_UTF8_INVALID"); buffer = ""; return; }
      try {
        buffer += decoded;
        if (Buffer.byteLength(buffer, "utf8") > FRAME_BYTES_CAP && !buffer.includes("\n")) throw new Error("PROVIDER_FRAME_SIZE_EXCEEDED");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          if (Buffer.byteLength(line, "utf8") > FRAME_BYTES_CAP || !line.trim()) throw new Error("PROVIDER_FRAME_SIZE_OR_EMPTY_INVALID");
          frame(JSON.parse(line));
        }
        if (Buffer.byteLength(buffer, "utf8") > FRAME_BYTES_CAP) throw new Error("PROVIDER_FRAME_SIZE_EXCEEDED");
      } catch (error) { fail(error?.message?.startsWith("PROVIDER_") ? error.message : "PROVIDER_JSON_FRAME_INVALID"); buffer = ""; }
    });
    child.stdout.on("end", () => {
      stdoutEnded = true;
      try {
        if (decoder.decode() || buffer.trim() || !eofAcknowledged) fail("PROVIDER_STDOUT_END_WITHOUT_VALID_EOF_ACK");
      } catch { fail("PROVIDER_STDOUT_UTF8_INVALID"); }
      receipt("PROVIDER_STDOUT_END");
    });
    child.stderr.on("data", chunk => { stderrBytes += chunk.length; if (stderrBytes > 100000) fail("PROVIDER_STDERR_SIZE_EXCEEDED"); });
    child.once("exit", (code, signal) => {
      exitObserved = true; exitCode = code;
      // Exit may precede pipe drainage. EOF_ACK is mandatory at close/join,
      // not prematurely at exit; code0 alone can never authorize a join.
      if (state !== "STOPPING" || !eofSent || code !== 0 || signal !== null) fail("PROVIDER_UNEXPECTED_NATIVE_EXIT");
      receipt("PROVIDER_NATIVE_EXIT", { code, signal: signal === null ? null : "NON_NULL" });
    });
    child.once("close", (code, signal) => {
      closeObserved = true; closeCode = code; joined = true;
      if (!exitObserved || exitCode !== code || code !== 0 || signal !== null || !stdoutEnded || !eofAcknowledged || !eofSent || state !== "STOPPING") {
        fail("PROVIDER_NATIVE_JOIN_INVALID");
      }
      if (pending) { clearTimer(pending.timer); pending.resolveDone(); pending = null; }
      clearTimer(startupTimer); state = "STOPPED"; receipt("PROVIDER_NATIVE_CLOSE", { code }); resolveClosed();
    });
    const remaining = startupDeadlineMs - now();
    if (remaining <= 0) fail("PROVIDER_STARTUP_ACTUAL_DEADLINE_EXHAUSTED");
    else startupTimer = setTimer(() => fail("PROVIDER_READY_DEADLINE_EXHAUSTED"), remaining);
  } catch (error) {
    spawnFailed = !child || !Number.isSafeInteger(child.pid) || child.pid < 1;
    fail(error.message || "PROVIDER_SPAWN_FAILED");
    if (spawnFailed && child?.once) child.once("close", (code) => {
      closeObserved = true; closeCode = code; state = "STOPPED";
      receipt("UNPROVEN_SPAWN_CLOSE", { code }); resolveClosed();
    });
  }

  return { ready, closed, snapshot, query({ deadlineMs }) {
    const sentMs = now();
    if (firstFailure || state !== "RUNNING" || pending) {
      fail(firstFailure || (pending ? "PROVIDER_QUERY_OVERLAP" : "PROVIDER_QUERY_PHASE_INVALID"));
      return Promise.reject(annotated(firstFailure));
    }
    if (!Number.isFinite(deadlineMs) || deadlineMs <= sentMs || deadlineMs > sentMs + CAP_MS) {
      fail("PROVIDER_QUERY_DEADLINE_INVALID"); return Promise.reject(annotated(firstFailure));
    }
    let resolve, reject, resolveDone;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const done = new Promise(yes => { resolveDone = yes; });
    const remainingMs = Math.floor(deadlineMs - sentMs);
    if (remainingMs < 1) { fail("PROVIDER_QUERY_DEADLINE_INVALID"); return Promise.reject(annotated(firstFailure)); }
    const current = pending = { sequence: ++sequence, deadlineMs, remainingMs, resolve, reject, done, resolveDone };
    current.timer = setTimer(() => fail("PROVIDER_QUERY_DEADLINE_EXHAUSTED"), deadlineMs - now());
    receipt("QUERY_SENT", { sequence, sentMs, deadlineMs, remainingMs });
    if (now() >= deadlineMs) {
      fail("PROVIDER_QUERY_ACTUAL_DEADLINE_EXHAUSTED");
      clearTimer(current.timer); pending = null; current.resolveDone(); return result;
    }
    try {
      child.stdin.write(JSON.stringify({ command: "QUERY", runId, observerId, sequence, port, remainingMs,
        wrapperPid: wrapperIdentity.pid, providerPid: child.pid }) + "\n");
      if (now() >= deadlineMs) fail("PROVIDER_QUERY_ACTUAL_DEADLINE_EXHAUSTED");
    } catch { fail("PROVIDER_STDIN_QUERY_FAILED"); }
    return result;
  }, stop(deadlineMs) {
    if (stopPromise) return stopPromise;
    stopDeadlineMs = deadlineMs;
    if (spawnFailed) { stopPromise = Promise.reject(annotated(firstFailure)); return stopPromise; }
    if (state === "STARTING") fail("PROVIDER_STOP_BEFORE_READY");
    if (closeObserved) {
      stopPromise = firstFailure ? Promise.reject(annotated(firstFailure)) : Promise.resolve(snapshot()); return stopPromise;
    }
    state = "STOPPING"; clearTimer(startupTimer); receipt("STOP_REQUESTED", { deadlineMs, sequence, inFlight: !!pending });
    const stopNow = now();
    if (!Number.isFinite(deadlineMs) || deadlineMs <= stopNow || deadlineMs > stopNow + CAP_MS) {
      fail("PROVIDER_STOP_DEADLINE_INVALID"); sendEofWhenIdle(); stopPromise = Promise.reject(annotated(firstFailure)); return stopPromise;
    }
    sendEofWhenIdle();
    stopPromise = bound((async () => { if (pending) await pending.done; sendEofWhenIdle(); await closed; return snapshot(); })(),
      deadlineMs, "PROVIDER_STOP_DEADLINE_EXHAUSTED");
    return stopPromise;
  } };
}


export function validateNativeRuntimeSnapshot(runtime, { port, wrapperIdentity, providerIdentity }) {
    if (!runtime || !Array.isArray(runtime.processes) || !Array.isArray(runtime.ports) || runtime.processes.length > 32768 || runtime.ports.length > 4096) {
      throw new Error("PROVIDER_RUNTIME_SCHEMA_INVALID");
}

    const pids = new Set(), rowsByPid = new Map();
    for (const row of runtime.processes) {
      if (!row || !Number.isSafeInteger(row.pid) || row.pid < 0 || pids.has(row.pid) ||
          !Number.isSafeInteger(row.parentPid) || row.parentPid < 0 ||
          !(row.workingSetBytes === undefined || row.workingSetBytes === null || Number.isSafeInteger(row.workingSetBytes) && row.workingSetBytes >= 0)) {
        throw new Error("PROVIDER_PROCESS_ROW_INVALID");
      }
      pids.add(row.pid);
      rowsByPid.set(row.pid, row);
      if (row.pid === 0) {
        if (row.parentPid !== 0 || row.name !== null || row.createdAt !== null || row.nativeBirthStamp !== null ||
            row.nativeIdentityStatus !== "SPI_IDLE_SENTINEL_NO_AUTHORITY" ||
            row.parentIdentityProof !== "SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY" ||
            row.liveAtCaptureEnd !== null || row.ownershipAuthority !== false || row.nativeIdentityFailure !== undefined) {
          throw new Error("PROVIDER_IDLE_SENTINEL_INVALID");
        }
      } else if (row.nativeIdentityStatus === "SNAPSHOT_ONLY_BIRTH_PARENT_NAME_OBSERVATION") {
        const ticks = birthTicks(row.createdAt);
        if (ticks === null || typeof row.nativeBirthStamp !== "string" || !STAMP.test(row.nativeBirthStamp) ||
            ticks % 10n !== 0n || ticks / 10n !== BigInt(row.nativeBirthStamp) / 10n ||
            typeof row.name !== "string" || !row.name || row.name.length > 260 || /[\u0000-\u001f\\/\uD800-\uDFFF]/u.test(row.name) ||
            row.liveAtCaptureEnd !== null || row.parentIdentityProof !== "SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY" ||
            row.ownershipAuthority !== false || row.nativeIdentityFailure !== undefined) {
          throw new Error("PROVIDER_SNAPSHOT_IDENTITY_INVALID");
        }
      } else throw new Error("PROVIDER_NATIVE_IDENTITY_STATUS_INVALID");
    }
    for (const row of runtime.ports) {
      if (!row || row.port !== port || !Number.isSafeInteger(row.pid) || row.pid < 1 || row.state !== "LISTEN" ||
          !["IPv4", "IPv6"].includes(row.family)) throw new Error("PROVIDER_PORT_ROW_INVALID");
      // Native provider has no address field; distinct listeners may share pid/port/family.
    }
    if (runtime.nativeProvider !== "SPI_SNAPSHOT_HELD_ROOTS_IPHELPER_WMI_FREE" || runtime.publicAbiGuarantee !== "NOT_GUARANTEED" ||
        JSON.stringify(runtime.tcpFamiliesComplete) !== '["IPv4","IPv6"]' ||
        !Number.isFinite(runtime.providerElapsedMs) || runtime.providerElapsedMs < 0 || !runtime.processes.length) {
      throw new Error("PROVIDER_COVERAGE_INCOMPLETE");
    }
    const coverage = runtime.spiCoverage;
    if (!coverage || ![26100, 26200].includes(coverage.osBuild) || coverage.architecture !== "AMD64" ||
        coverage.layoutProfile !== "SPI_X64_PREFIX256_THREAD80_CREATE32_IMAGE56_PID80_PARENT88" || coverage.queryStatus !== 0 ||
        coverage.bufferCapacity !== 8 * 1024 * 1024 || !Number.isSafeInteger(coverage.returnLength) ||
        coverage.returnLength < runtime.processes.length * 256 || coverage.returnLength > coverage.bufferCapacity ||
        coverage.inventoryComplete !== true || typeof coverage.snapshotCompletedUtcFileTime !== "string" ||
        !STAMP.test(coverage.snapshotCompletedUtcFileTime) || !positiveFileTime(coverage.snapshotCompletedUtcFileTime) ||
        coverage.clockSource !== PRECISE_UTC_SOURCE) throw new Error("PROVIDER_SPI_COVERAGE_INVALID");
    const snapshotCompleted = BigInt(coverage.snapshotCompletedUtcFileTime);
    if (runtime.processes.some(row => row.pid !== 0 && BigInt(row.nativeBirthStamp) > snapshotCompleted)) {
      throw new Error("PROVIDER_SNAPSHOT_BIRTH_AFTER_CAPTURE");
    }
    if (!Array.isArray(runtime.heldComparisons) || runtime.heldComparisons.length !== 2) throw new Error("PROVIDER_HELD_COMPARISONS_INVALID");
    const compared = new Set();
    for (const expected of [
      { pid: wrapperIdentity.pid, createdAt: wrapperIdentity.createdAt, name: "node.exe" },
      { pid: providerIdentity.providerPid, createdAt: providerIdentity.providerCreatedAt, name: "powershell.exe" },
    ]) {
      const row = rowsByPid.get(expected.pid);
      if (!row || row.nativeIdentityStatus !== "SNAPSHOT_ONLY_BIRTH_PARENT_NAME_OBSERVATION" ||
          row.createdAt !== expected.createdAt || row.name.toLowerCase() !== expected.name ||
          (expected.pid === providerIdentity.providerPid
            ? row.parentPid !== wrapperIdentity.pid || row.nativeBirthStamp !== providerIdentity.providerNativeBirthStamp
            : row.nativeBirthStamp !== providerIdentity.wrapperNativeBirthStamp)) {
        throw new Error("PROVIDER_SELF_OR_WRAPPER_CENSUS_IDENTITY_INVALID");
      }
      const matches = runtime.heldComparisons.filter(proof => proof?.pid === expected.pid);
      const proof = matches[0];
      if (matches.length !== 1 || compared.has(expected.pid) || !proof || proof.parentPid !== row.parentPid ||
          typeof proof.name !== "string" || proof.name.toLowerCase() !== row.name.toLowerCase() ||
          proof.createdAt !== row.createdAt || proof.nativeBirthStamp !== row.nativeBirthStamp ||
          proof.nativeWaitResultBefore !== 258 || proof.nativeWaitResultAfter !== 258 ||
          proof.sameHandleLiveAtBothBoundaries !== true || proof.snapshotMatchesHeld !== true) {
        throw new Error("PROVIDER_HELD_COMPARISON_MISMATCH");
      }
      compared.add(expected.pid);
    }
    return runtime;
  }

export function validateNativeProviderReceipt(receipt, { runId, observerId, port, wrapperIdentity, providerIdentity,
  sequence, receivedMs, stopRequestedMs, stopDeadlineMs, terminal = false }) {
  const providerBirth = birthTicks(receipt?.providerCreatedAt);
  if (!receipt || receipt.runId !== runId || receipt.observerId !== observerId || receipt.port !== port ||
      receipt.wrapperPid !== wrapperIdentity.pid || receipt.wrapperCreatedAt !== wrapperIdentity.createdAt ||
      typeof receipt.wrapperNativeBirthStamp !== "string" || !STAMP.test(receipt.wrapperNativeBirthStamp) ||
      BigInt(receipt.wrapperNativeBirthStamp) / 10n !== birthTicks(wrapperIdentity.createdAt) / 10n ||
      !Number.isSafeInteger(receipt.providerPid) || receipt.providerPid < 1 || receipt.providerParentPid !== wrapperIdentity.pid ||
      providerBirth === null || typeof receipt.providerNativeBirthStamp !== "string" || !STAMP.test(receipt.providerNativeBirthStamp) ||
      providerBirth % 10n !== 0n || providerBirth / 10n !== BigInt(receipt.providerNativeBirthStamp) / 10n ||
      providerBirth < birthTicks(wrapperIdentity.createdAt) || !Number.isFinite(receipt.startedMs) || receipt.startedMs > receivedMs ||
      !Number.isFinite(receipt.startupDeadlineMs) || receipt.startupDeadlineMs <= receipt.startedMs ||
      receipt.startupDeadlineMs > receipt.startedMs + CAP_MS || receipt.firstFailure !== null ||
      providerIdentity && (receipt.providerPid !== providerIdentity.providerPid || receipt.providerNativeBirthStamp !== providerIdentity.providerNativeBirthStamp ||
        receipt.providerCreatedAt !== providerIdentity.providerCreatedAt || receipt.wrapperNativeBirthStamp !== providerIdentity.wrapperNativeBirthStamp)) throw new Error("PROVIDER_RECEIPT_IDENTITY_INVALID");
  if (!terminal) {
    if (receipt.state !== "RUNNING" || receipt.joined !== false || receipt.status !== "NOT_COMPLETE") throw new Error("PROVIDER_READY_RECEIPT_INVALID");
  } else if (receipt.status !== "PASSED" || receipt.state !== "STOPPED" || receipt.sequence !== sequence ||
      receipt.eofSent !== true || receipt.eofAcknowledged !== true || receipt.stdoutEnded !== true || receipt.exitObserved !== true ||
      receipt.closeObserved !== true || receipt.joined !== true || receipt.exitCode !== 0 || receipt.closeCode !== 0 ||
      !Number.isFinite(receipt.stopDeadlineMs) || receipt.stopDeadlineMs <= stopRequestedMs ||
      receipt.stopDeadlineMs > stopDeadlineMs || receivedMs >= receipt.stopDeadlineMs) throw new Error("PROVIDER_FINAL_JOIN_RECEIPT_INVALID");
  return receipt;
}
