import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { describe, expect, test } from "vitest";
import { BUILD_LOCK_DIAGNOSTICS_POLICY, createBuildLockDiagnosticsFixtureController, redactBuildLockDiagnosticText,
  readBuildLockDiagnosticsEvidence } from "../../scripts/testing/build-lock-diagnostics.mjs";

const root = process.cwd(), head = "a".repeat(40), sourceFingerprint = "b".repeat(64);
const birth = "134352873660197859";
const context = { head, sourceFingerprint, environment: { NODE_ENV: "test" as const } };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function file(session: { receiptRelativePath: string }, name: string) { return path.join(root, path.dirname(session.receiptRelativePath), name); }
function json(filename: string) { return JSON.parse(fs.readFileSync(filename, "utf8")); }
async function waitForOwnedProof(session: { receiptRelativePath: string }, reason: string) {
  const deadline = process.hrtime.bigint() + 4000000000n;
  while (process.hrtime.bigint() < deadline) {
    const proofPath = file(session, "worker-exit-proof.json"), stopPath = file(session, "stop.json");
    if (fs.existsSync(proofPath) && fs.existsSync(stopPath)) {
      const proof = json(proofPath), stop = json(stopPath);
      if (proof.workerExited === true && stop.reason === reason) return proof;
    }
    await pause(25);
  }
  throw new Error(`OWNED_NATIVE_REASON_PROOF_DEADLINE_${reason}`);
}
function fixture(mode: "NORMAL" | "IGNORE_STOP" | "STALL_GUARDIAN_AFTER_PROOF" | "INVALID_QUERY_SESSION" = "NORMAL", policy = {}) {
  return createBuildLockDiagnosticsFixtureController({ fixture: { id: randomUUID(), mode,
    policy: { leaseMs: 15000, readyMs: 15000, graceMs: 350, finalMs: 650, ...policy } } });
}
function mock({ unlinkFailure = false, receiptFailure = false, omitProof = false, wrongBirth = false, readinessObservedMs = null as number | null, finalizationLate = false } = {}) {
  const children: ChildProcess[] = [], writes: string[] = [];
  let committed = false;
  let configuration: Record<string, unknown>, directory = "";
  function record(name: string, fields: Record<string, unknown>) {
    const role = ["worker-ready.json", "worker-summary.json", "worker-end.json"].includes(name) ? "Worker" :
      ["guardian-armed.json", "guardian-end.json", "worker-exit-proof.json"].includes(name) ? "Guardian" : "Supervisor";
    fs.writeFileSync(path.join(directory, name), `${JSON.stringify({ invocationId: configuration.invocationId, nonce: configuration.nonce,
      target: configuration.target, supportIdentity: configuration.supportIdentity, label: configuration.label,
      emitterRole: role, emitterPid: role === "Worker" ? 21003 : role === "Guardian" ? 21002 : 21001, emitterNativeStartFileTime: birth,
      utc: new Date().toISOString(), qpcTicks: "1000", qpcFrequency: "10000000", ...fields })}\n`, { flag: "wx" });
  }
  const spawnChild = ((_: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { pid: children.length ? 21002 : 21001, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: () => { queueMicrotask(() => child.emit("close", null, "SIGTERM")); return true; }, unref: () => child }) as unknown as ChildProcess;
    children.push(child);
    if (children.length === 2) {
      configuration = json(args[args.indexOf("-Configuration") + 1]); directory = String(configuration.directory);
      queueMicrotask(() => {
        record("supervisor-created.json", { pid: 21001, parentPid: process.pid, nativeStartFileTime: birth, creatorNativeStartFileTime: birth });
        record("worker-created.json", { pid: 21003, parentPid: 21001, nativeStartFileTime: birth, supervisorNativeStartFileTime: birth, creatorNativeStartFileTime: birth });
        record("guardian-armed.json", { pid: 21002, parentPid: process.pid, nativeStartFileTime: birth, supervisorNativeStartFileTime: birth, workerPid: 21003, workerNativeStartFileTime: wrongBirth ? "134352873660197860" : birth, workerHandleHeld: true });
        record("worker-ready.json", { pid: 21003, parentPid: 21001, nativeStartFileTime: birth, firstQueryValid: true, rmEndResult: 0, targetFileOpen: "NEVER", targetExistsMetadataOnly: false });
      });
    }
    return child;
  }) as unknown as typeof spawn;
  const io = { ...fs,
    writeFileSync: ((filename: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const name = String(filename); writes.push(name);
      if (receiptFailure && name.endsWith("receipt.json")) throw Object.assign(new Error("fixture write failure"), { code: "EACCES" });
      (fs.writeFileSync as (...args: unknown[]) => void)(filename, ...args);
      if (name.endsWith("stop.json")) queueMicrotask(() => {
        record("worker-summary.json", { pid: 21003, nativeStartFileTime: birth, startedAt: configuration.leaseDeadlineUtc ? new Date(Date.parse(String(configuration.leaseDeadlineUtc)) - Number(configuration.leaseMs)).toISOString() : new Date().toISOString(),
          endedAt: new Date().toISOString(), samples: 2, ownerStateChanges: 1, rmQueryErrors: 0, maxGapMs: 75, maxQueryMs: 1, meanQueryMs: 1, rmEndResult: 0, reason: "STOP_SIGNAL", failure: null });
        if (!omitProof) record("worker-exit-proof.json", { pid: 21003, nativeStartFileTime: birth, workerExited: true, forced: false, reason: "STOP_SIGNAL", proof: "SAME_PREARMED_NATIVE_HANDLE_WAIT_SIGNALED", guardianPid: 21002, guardianNativeStartFileTime: birth });
        for (const [index, role] of ["supervisor", "guardian"].entries()) { record(`${role}-end.json`, { pid: children[index].pid, nativeStartFileTime: birth, failure: null, forced: false, reason: "STOP_SIGNAL" }); children[index].emit("close", 0, null); }
      });
    }) as typeof fs.writeFileSync,
    renameSync: ((oldPath: fs.PathLike, newPath: fs.PathLike) => { fs.renameSync(oldPath, newPath); committed = true; }) as typeof fs.renameSync,
    unlinkSync: ((filename: fs.PathLike) => { if (unlinkFailure) throw Object.assign(new Error("fixture cleanup failure"), { code: "EACCES" }); fs.unlinkSync(filename); }) as typeof fs.unlinkSync };
  const controller = createBuildLockDiagnosticsFixtureController({ platform: "win32", io, spawnChild,
    ...(readinessObservedMs === null && !finalizationLate ? {} : { monotonic: () => finalizationLate && committed ? 700000 : directory && fs.existsSync(path.join(directory, "worker-ready.json")) ? readinessObservedMs ?? 0 : 0 }),
    fixture: { id: randomUUID(), policy: { readyMs: 500, graceMs: 50, finalMs: 100 } } });
  return { controller, writes, children };
}

describe("failure-only Build lock diagnostics: injected controller", () => {
  test("independent lease is not a formal Build timeout", () => {
    expect(BUILD_LOCK_DIAGNOSTICS_POLICY).toMatchObject({ leaseMs: 660000, readyMs: 15000, graceMs: 3000, finalMs: 1000, releaseRemoteExport: "NOT_IMPLEMENTED" });
  });
  test("success creates compact receipt after real bound readiness and owned cleanup", async () => {
    const { controller, writes } = mock(); const session = await controller.begin(context); const started = new Date().toISOString();
    const result = await controller.end(session, { buildStatus: 0, buildStartedAt: started, buildEndedAt: new Date().toISOString() });
    expect(result).toMatchObject({ status: "PASSED", retention: "COMPACT_SUCCESS", native: { workerExitConfirmed: true, creatorForceStopped: false } });
    expect(writes.filter(value => value.endsWith("receipt.json") || value.endsWith("compact-pending.json"))).toHaveLength(1);
    expect(fs.readdirSync(path.dirname(file(session, "receipt.json")))).toEqual(["receipt.json"]);
  });
  test("failed native Build is retained without replacing its primary error", async () => {
    const { controller } = mock(); const session = await controller.begin(context); const primary = Object.assign(new Error("primary native failure"), { code: "EBUSY" });
    const started = new Date().toISOString(); const result = await controller.end(session, { buildStatus: 1, buildStartedAt: started, buildEndedAt: new Date().toISOString(), buildError: primary });
    expect(result).toMatchObject({ status: "PASSED", retention: "FAILED_EVIDENCE_RETAINED", nativeBuild: { status: "FAILED", exitStatus: 1, primaryError: { code: "EBUSY" } } });
    expect(primary.message).toBe("primary native failure"); expect(fs.existsSync(file(session, "worker-exit-proof.json"))).toBe(true);
  });
  test("missing worker proof never fabricates zero or a green result", async () => {
    const { controller } = mock({ omitProof: true }); const session = await controller.begin(context);
    expect(await controller.end(session)).toMatchObject({ status: "DIAGNOSTICS_INCOMPLETE", native: { workerExitConfirmed: false } });
  });
  test("changed native birth rejects readiness, then closes only original children", async () => {
    const { controller, children } = mock({ wrongBirth: true }); await expect(controller.begin(context)).rejects.toThrow("NATIVE_READINESS_IDENTITY_INCOMPLETE");
    expect(children).toHaveLength(2);
  });
  test("ready observed exactly at deadline is allowed, one millisecond late is rejected", async () => {
    const boundary = mock({ readinessObservedMs: 500 }); const session = await boundary.controller.begin(context);
    expect(session.status).toBe("READY"); await boundary.controller.end(session);
    await expect(mock({ readinessObservedMs: 501 }).controller.begin(context)).rejects.toThrow("NATIVE_READY_DEADLINE");
  });
  test("late final serialization/flush cannot produce a local diagnostic PASS", async () => {
    const { controller } = mock({ finalizationLate: true }); const session = await controller.begin(context); const started = new Date().toISOString();
    expect(await controller.end(session, { buildStatus: 0, buildStartedAt: started, buildEndedAt: new Date().toISOString() })).toMatchObject({ status: "DIAGNOSTICS_INCOMPLETE", receiptSha256: null, nativeBuild: { status: "EXIT0" } });
  });
  test("receipt write failure preserves native Build failure and returns incomplete", async () => {
    const { controller, writes } = mock({ receiptFailure: true }); const session = await controller.begin(context); const started = new Date().toISOString();
    const result = await controller.end(session, { buildStatus: 1, buildStartedAt: started, buildEndedAt: new Date().toISOString(), buildError: { name: "SpawnError", code: "EIO" } });
    expect(result).toMatchObject({ status: "DIAGNOSTICS_INCOMPLETE", receiptSha256: null, nativeBuild: { primaryError: { code: "EIO" } } });
    expect(writes.filter(value => value.endsWith("receipt.json"))).toHaveLength(1);
  });
  test("cleanup failure cannot admit a durable green final receipt", async () => {
    const { controller } = mock({ unlinkFailure: true }); const session = await controller.begin(context); const started = new Date().toISOString();
    expect(await controller.end(session, { buildStatus: 0, buildStartedAt: started, buildEndedAt: new Date().toISOString() })).toMatchObject({ status: "DIAGNOSTICS_INCOMPLETE" });
    expect(fs.existsSync(file(session, "receipt.json"))).toBe(false);
    expect(fs.existsSync(file(session, "compact-pending.json"))).toBe(true);
  });
  test("non-Windows reports null native measurements and never calls native adapter", async () => {
    let invoked = false;
    const controller = createBuildLockDiagnosticsFixtureController({ platform: "linux", spawnChild: (() => { invoked = true; throw new Error("not allowed"); }) as unknown as typeof spawn, fixture: { id: randomUUID() } });
    const session = await controller.begin(context); const result = await controller.end(session);
    expect(result).toMatchObject({ status: "NOT_APPLICABLE", native: null, readiness: null }); expect(invoked).toBe(false);
  });
  test("source identity invalid and repeated end fail closed", async () => {
    const { controller } = mock(); await expect(controller.begin({ ...context, head: "unknown" })).rejects.toThrow("SOURCE_IDENTITY");
    const session = await controller.begin(context); await controller.end(session);
    expect(await controller.end(session)).toMatchObject({ status: "DIAGNOSTICS_INCOMPLETE" });
  });
  test("inline command payloads, credentials, bearer and URL userinfo are withheld", () => {
    const text = redactBuildLockDiagnosticText("node -e console.log('secret=DO_NOT_EXPORT'); another payload");
    expect(text).not.toContain("DO_NOT_EXPORT"); expect(text).not.toContain("another payload");
    expect(redactBuildLockDiagnosticText("node --eval=DO_NOT_EXPORT another payload")).not.toContain("DO_NOT_EXPORT");
    expect(redactBuildLockDiagnosticText("powershell -Command:DO_NOT_EXPORT another payload")).not.toContain("another payload");
    expect(redactBuildLockDiagnosticText("token=DO_NOT_EXPORT bearer abcdef https://user:pass@example.test")).not.toContain("DO_NOT_EXPORT");
  });
  test("actual unique reader rejects synthetic, foreign and stale receipts", () => {
    expect(() => readBuildLockDiagnosticsEvidence(".playwright/foreign/receipt.json", { root, head, sourceFingerprint, startedAt: new Date().toISOString(), now: new Date().toISOString() })).toThrow("CONTEXT_INVALID");
  });
});

describe("actual native owned GUID lifecycle (never formal Build)", () => {
  test("absent trace is not opened/created; actual valid empty RM query is ready", async () => {
    if (process.platform !== "win32") { const c = createBuildLockDiagnosticsFixtureController({ fixture: { id: randomUUID() } }); expect(await c.end(await c.begin(context))).toMatchObject({ status: "NOT_APPLICABLE", native: null }); return; }
    const c = fixture(); const session = await c.begin(context);
    expect(json(file(session, "worker-ready.json"))).toMatchObject({ firstQueryValid: true, targetExistsMetadataOnly: false, targetFileOpen: "NEVER" });
    const target = json(file(session, "configuration.json")).target; expect(fs.existsSync(target)).toBe(false);
    expect(await c.end(session)).toMatchObject({ status: "PASSED", native: { workerExitConfirmed: true, creatorForceStopped: false } });
    expect(fs.existsSync(target)).toBe(false);
  }, 25000);
  test("actual invalid-session RM error is not misreported as a valid empty query", async () => {
    if (process.platform !== "win32") { const c = createBuildLockDiagnosticsFixtureController({ fixture: { id: randomUUID() } }); expect(await c.end(await c.begin(context))).toMatchObject({ status: "NOT_APPLICABLE" }); return; }
    const c = fixture("INVALID_QUERY_SESSION");
    await expect(c.begin(context)).rejects.toThrow("RM_QUERY_");
  }, 25000);
  test("independent held Guardian proves worker exit after creator-owned supervisor termination", async () => {
    if (process.platform !== "win32") { expect(process.platform).not.toBe("win32"); return; }
    const c = fixture(); const session = await c.begin(context); expect(c.terminateOwnedSupervisor(session)).toBe(true);
    await waitForOwnedProof(session, "SUPERVISOR_EXITED"); const result = await c.end(session);
    expect(result).toMatchObject({ status: "DIAGNOSTICS_INCOMPLETE", native: { workerExitConfirmed: true } });
    expect(json(file(session, "worker-exit-proof.json"))).toMatchObject({ event: "WORKER_EXITED_BOUND_HANDLE", workerExited: true, proof: "SAME_PREARMED_NATIVE_HANDLE_WAIT_SIGNALED" });
  }, 25000);
  test("control EOF stops owned workers and is incomplete, not normal-success", async () => {
    if (process.platform !== "win32") { expect(process.platform).not.toBe("win32"); return; }
    const c = fixture(); const session = await c.begin(context); c.closeOwnedControl(session); await waitForOwnedProof(session, "CREATOR_EXIT_OR_CONTROL_EOF");
    expect(await c.end(session)).toMatchObject({ status: "DIAGNOSTICS_INCOMPLETE", native: { workerExitConfirmed: true } });
  }, 25000);
  test("Guardian stalled after worker proof has bounded original-creator close path", async () => {
    if (process.platform !== "win32") { expect(process.platform).not.toBe("win32"); return; }
    const c = fixture("STALL_GUARDIAN_AFTER_PROOF"); const session = await c.begin(context); const started = Date.now();
    const result = await c.end(session);
    expect(Date.now() - started).toBeLessThan(1700);
    expect(result).toMatchObject({ status: "DIAGNOSTICS_INCOMPLETE", native: { workerExitConfirmed: true, creatorForceStopped: true, guardian: { actualCloseObserved: true } } });
  }, 25000);
  test("noncooperative owned worker is terminated through retained birth-bound handle, never green", async () => {
    if (process.platform !== "win32") { expect(process.platform).not.toBe("win32"); return; }
    const c = fixture("IGNORE_STOP"); const session = await c.begin(context);
    expect(await c.end(session)).toMatchObject({ status: "DIAGNOSTICS_INCOMPLETE", native: { workerExitConfirmed: true } });
    expect(json(file(session, "worker-exit-proof.json"))).toMatchObject({ workerExited: true });
  }, 25000);
  test.each(["lease", "lease-startup-delay"])("independent lease expires during synchronous child with %s startup", mode => {
    if (process.platform !== "win32") { expect(process.platform).not.toBe("win32"); return; }
    const result = spawnSync(process.execPath, [path.join(root, "tests/fixtures/build-lock-diagnostics-child.cjs"), mode, randomUUID()],
      { cwd: root, windowsHide: true, timeout: 25000, encoding: "utf8", env: { NODE_ENV: "test", SystemRoot: process.env.SystemRoot } });
    expect(result.status, result.stderr).toBe(0); const value = JSON.parse(result.stdout.trim());
    expect(value).toMatchObject({ label: "SYNTHETIC_TOOL_VALIDATION", evidence: { status: "DIAGNOSTICS_INCOMPLETE", native: { workerExitConfirmed: true } }, proof: { workerExited: true } });
    expect(value.leaseWindow).toMatchObject({ readyMs: 15000, activeLeaseMs: 6000, injectedStartupDelayMs: mode === "lease-startup-delay" ? 6500 : 0 });
    expect(Date.parse(value.leaseWindow.blockStartedAt)).toBeLessThan(Date.parse(value.leaseWindow.leaseDeadlineUtc));
    expect(Date.parse(value.leaseWindow.blockEndedAt)).toBeGreaterThanOrEqual(Date.parse(value.leaseWindow.leaseDeadlineUtc));
    expect(value.nativeLeaseStop).toMatchObject({ reason: "LEASE_EXPIRED", invocationId: value.proof.invocationId, nonce: value.proof.nonce, supportIdentity: value.proof.supportIdentity });
    expect(["Supervisor", "Guardian"]).toContain(value.nativeLeaseStop.emitterRole);
    expect(Date.parse(value.nativeLeaseStop.utc)).toBeGreaterThanOrEqual(Date.parse(value.leaseWindow.leaseDeadlineUtc));
    expect(Date.parse(value.nativeLeaseStop.utc)).toBeLessThanOrEqual(Date.parse(value.leaseWindow.blockEndedAt));
    expect(value.worker).toMatchObject({ failure: null, reason: "LEASE_EXPIRED", pid: value.proof.pid, nativeStartFileTime: value.proof.nativeStartFileTime });
    expect(value.proof.forced).toBe(false);
    expect(Date.parse(value.proof.utc)).toBeGreaterThanOrEqual(Date.parse(value.leaseWindow.blockStartedAt));
    expect(Date.parse(value.proof.utc)).toBeLessThanOrEqual(Date.parse(value.leaseWindow.blockEndedAt));
  }, 30000);
  test("public monitor observes exact target fatal error without consuming/replacing it", () => {
    const id = randomUUID(), nonce = randomUUID(), directory = path.join(root, ".playwright/build-lock-diagnostics-fixtures", `lab-${id}`);
    fs.mkdirSync(directory, { recursive: true }); const child = path.join(root, "tests/fixtures/build-lock-diagnostics-child.cjs");
    const result = spawnSync(process.execPath, ["--require", path.join(root, "scripts/testing/build-trace-failure-monitor.cjs"), child, "build"],
      { windowsHide: true, encoding: "utf8", timeout: 10000, env: { NODE_ENV: "test", VERIDIA_BUILD_LOCK_TOKEN: id, VERIDIA_BUILD_LOCK_NONCE: nonce, VERIDIA_BUILD_LOCK_DIRECTORY: directory,
        VERIDIA_BUILD_LOCK_TARGET: path.join(directory, "trace"), VERIDIA_BUILD_LOCK_ENTRY: child } });
    expect(result.status).toBe(1); expect(result.stderr).toContain("SYNTHETIC fatal error");
    const errors = fs.readdirSync(directory).filter(name => name.startsWith("trace-ebusy-")); expect(errors).toHaveLength(1);
    expect(json(path.join(directory, errors[0]))).toMatchObject({ code: "EBUSY", errno: -4082, syscall: "open", nonce });
    expect(fs.readFileSync(path.join(directory, errors[0]), "utf8")).not.toContain("DO_NOT_EXPORT_THIS_SECRET");
  });
  test("monitor storage failure preserves original fatal error and exit1", () => {
    const child = path.join(root, "tests/fixtures/build-lock-diagnostics-child.cjs");
    const result = spawnSync(process.execPath, ["--require", path.join(root, "scripts/testing/build-trace-failure-monitor.cjs"), child, "build"],
      { windowsHide: true, encoding: "utf8", timeout: 10000, env: { NODE_ENV: "test", VERIDIA_BUILD_LOCK_TOKEN: randomUUID(), VERIDIA_BUILD_LOCK_NONCE: randomUUID(),
        VERIDIA_BUILD_LOCK_DIRECTORY: path.join(root, ".playwright/build-lock-diagnostics-fixtures", `lab-${randomUUID()}`, "absent"), VERIDIA_BUILD_LOCK_TARGET: path.join(root, ".playwright/build-lock-diagnostics-fixtures", `lab-${randomUUID()}`, "trace"), VERIDIA_BUILD_LOCK_ENTRY: child } });
    expect(result.status).toBe(1); expect(result.stderr).toContain("SYNTHETIC fatal error"); expect(result.stderr).toContain("VERIDIA_BUILD_LOCK_MONITOR_INCOMPLETE");
  });
});
