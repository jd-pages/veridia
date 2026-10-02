import { performance } from "node:perf_hooks";

export class E2eInitialIdentityError extends Error {
  constructor(evidence) {
    super("E2E_SERVER_INITIAL_PROCESS_IDENTITY: creator-held process/birth identity unavailable or mismatched");
    this.name = "E2eInitialIdentityError";
    this.evidence = evidence;
  }
}
// The creator's ChildProcess is the authority here, not an arbitrary PID or
// process-name allowlist. libuv SIG0 tests that retained Windows process handle
// without sending a signal/terminating anything. Pin liveness across the native
// census; a live original handle cannot have its PID recycled during that read.
// Preserve the actual native birth for every subsequent census/termination.
export function captureInitialOwnedRoot(child, { capture, parentPid, name, commandIdentity, now = () => performance.now() }) {
  const started = now();
  const evidence = { stage: "SPAWN_RETURNED", spawnReturnedPid: child.pid ?? null, capturedAt: new Date().toISOString(),
    spawnReturnedAt: child.e2eSpawnReturnedAt ?? null,
    expectedCreatorPid: parentPid, actualParentPid: null, nativeBirthTime: null, commandIdentity,
    creatorHandleLiveBefore: false, creatorHandleLiveAfter: false, elapsedMs: null,
    closeState: { exitCode: child.exitCode ?? null, signal: child.signalCode ?? null }, status: "FAILED", failure: null };
  const live = () => child.exitCode === null && child.signalCode === null && child.kill(0) === true;
  let runtime;
  try {
    if (!Number.isSafeInteger(child.pid) || child.pid < 1 || !live()) throw new Error("CREATOR_HANDLE_NOT_LIVE_BEFORE_CAPTURE");
    evidence.creatorHandleLiveBefore = true;
    evidence.stage = "NATIVE_IDENTITY_CAPTURE";
    runtime = capture(12000);
    const actual = runtime.processes.find(row => row.pid === child.pid);
    evidence.actualParentPid = actual?.parentPid ?? null;
    evidence.nativeBirthTime = actual?.createdAt ?? null;
    if (!live()) throw new Error("CREATOR_HANDLE_NOT_LIVE_AFTER_CAPTURE");
    evidence.creatorHandleLiveAfter = true;
    if (!actual || actual.parentPid !== parentPid || actual.name?.toLowerCase() !== name.toLowerCase() ||
      typeof actual.createdAt !== "string" || !Number.isFinite(Date.parse(actual.createdAt))) throw new Error("NATIVE_CREATOR_OR_BIRTH_MISMATCH");
    if (now() - started > 12000) throw new Error("NATIVE_IDENTITY_CAPTURE_DEADLINE");
    child.e2eOwnershipFence = { pid: child.pid, parentPid, name, expectedCreatedAt: actual.createdAt };
    evidence.stage = "CREATOR_HANDLE_AND_NATIVE_BIRTH_BOUND";
    evidence.status = "PASS";
  } catch (error) {
    // A provider exception may contain a raw command; retain only fixed stage,
    // typed code and measured native values, never error.message / argv / env.
    evidence.failure = /^(CREATOR_HANDLE_NOT_LIVE_|NATIVE_CREATOR_OR_BIRTH_MISMATCH|NATIVE_IDENTITY_CAPTURE_DEADLINE)/u.test(error.message ?? "")
      ? error.message : "NATIVE_IDENTITY_PROVIDER_FAILED";
    evidence.closeState = { exitCode: child.exitCode ?? null, signal: child.signalCode ?? null };
    evidence.elapsedMs = now() - started;
    throw new E2eInitialIdentityError(evidence);
  }
  evidence.elapsedMs = now() - started;
  return { runtime, evidence };
}

export async function closeRejectedCreatorChild(child, deadlineMs = 2000) {
  // Only the creator-held ChildProcess; no PID lookup, tree adoption, taskkill,
  // name matching or claim that any unknown descendants have been cleaned.
  if (!child) return { closeObserved: true, unknownDescendantState: "NOT_MEASURED" };
  let closed = child.exitCode !== null || child.signalCode !== null;
  let timer;
  if (!closed) {
    const close = new Promise(resolve => child.once("close", () => { closed = true; resolve(); }));
    try { child.kill(); } catch {}
    await Promise.race([close, new Promise(resolve => { timer = setTimeout(resolve, deadlineMs); })]);
    clearTimeout(timer);
  }
  child.unref();
  child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
  return { closeObserved: closed, exitCode: child.exitCode ?? null, signal: child.signalCode ?? null,
    unknownDescendantState: "UNVERIFIED_FAIL_CLOSED_NOT_ADOPTED" };
}
