import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startWindowsRuntimeObservation, validRuntimeObservationQueryDeadline, extendOwnedProcessIdentities } from "../../scripts/testing/e2e-server-infrastructure.mjs";
import type { OwnershipFailureDiagnostic } from "../../scripts/testing/e2e-server-infrastructure.mjs";

class FakeWorker extends EventEmitter {
  threadId = 7;
  commands: Record<string, unknown>[] = [];
  postMessage(message: Record<string, unknown>) { this.commands.push(message); }
}
const birth = "2026-10-01T12:00:00.0000000Z";
const providerBirth = "2026-10-01T12:00:01.0000000Z";
const stamp = (value: string) => String(BigInt(Date.parse(value)) * 10000n + 116444736000000000n);
const wrapperIdentity = { pid: process.pid, parentPid: 1, name: "node.exe", createdAt: birth };
const liveRow = (pid: number, parentPid: number, name: string, createdAt: string) => ({ pid, parentPid, name, createdAt,
  nativeBirthStamp: stamp(createdAt), nativeIdentityStatus: "SNAPSHOT_ONLY_BIRTH_PARENT_NAME_OBSERVATION" as const,
  parentIdentityProof: "SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY" as const, liveAtCaptureEnd: null, ownershipAuthority: false as const });
const idleRow = { pid: 0, parentPid: 0, name: null, createdAt: null, nativeBirthStamp: null,
  nativeIdentityStatus: "SPI_IDLE_SENTINEL_NO_AUTHORITY", parentIdentityProof: "SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY",
  liveAtCaptureEnd: null, ownershipAuthority: false } as const;
const heldComparison = (row: ReturnType<typeof liveRow>) => ({ pid: row.pid, parentPid: row.parentPid, name: row.name,
  createdAt: row.createdAt, nativeBirthStamp: row.nativeBirthStamp, nativeWaitResultBefore: 258, nativeWaitResultAfter: 258,
  sameHandleLiveAtBothBoundaries: true, snapshotMatchesHeld: true });
const nativeRuntime = (rows: Record<string, unknown>[] = [liveRow(42, 1, "node.exe", birth)]) => ({
  processes: [liveRow(process.pid, 1, "node.exe", birth), liveRow(200, process.pid, "powershell.exe", providerBirth), ...rows],
  ports: [], nativeProvider: "SPI_SNAPSHOT_HELD_ROOTS_IPHELPER_WMI_FREE", providerElapsedMs: 1, tcpFamiliesComplete: ["IPv4", "IPv6"], publicAbiGuarantee: "NOT_GUARANTEED",
  heldComparisons: [heldComparison(liveRow(process.pid, 1, "node.exe", birth)), heldComparison(liveRow(200, process.pid, "powershell.exe", providerBirth))],
  spiCoverage: { osBuild: 26200, architecture: "AMD64", layoutProfile: "SPI_X64_PREFIX256_THREAD80_CREATE32_IMAGE56_PID80_PARENT88",
    queryStatus: 0, returnLength: 4096, bufferCapacity: 8388608, inventoryComplete: true,
    snapshotCompletedUtcFileTime: stamp("2026-10-01T12:00:02.0000000Z"), clockSource: "GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME" } });
const opaqueRow = (pid: number, parentPid: number) => ({ pid, parentPid, name: "node.exe", createdAt: null, nativeBirthStamp: null,
  nativeIdentityStatus: "OPAQUE_NO_HELD_IDENTITY_NO_AUTHORITY", parentIdentityProof: "TOOLHELP_SNAPSHOT_OPAQUE_NO_AUTHORITY", liveAtCaptureEnd: false,
  nativeIdentityFailure: { code: "NATIVE_HANDLE_UNAVAILABLE", operation: "OPEN_PROCESS", win32Error: 5, ntStatus: null } });
function ownershipDiagnostic(action: () => unknown): OwnershipFailureDiagnostic {
  try { action(); throw new Error("Expected ownership rejection"); }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    const value = (error as Error & { ownershipDiagnostic?: OwnershipFailureDiagnostic }).ownershipDiagnostic;
    expect(value).toBeDefined(); return value!;
  }
}
const untrustedProcesses = (rows: unknown[]) => rows as Parameters<typeof extendOwnedProcessIdentities>[0];
describe("nonblocking serial Windows census coordinator (pure, no native calls)", () => {
  let clock: number;
  beforeEach(() => { vi.useFakeTimers(); clock = 1000; });
  afterEach(() => vi.useRealTimers());
  const fixture = (record = vi.fn(), constructorCost = 0) => {
    const worker = new FakeWorker(); let data: Record<string, unknown> = {};
    const observer = startWindowsRuntimeObservation({ runId: "unit-run", port: 3100, wrapperIdentity, record }, {
      createWorker: value => { data = value; clock += constructorCost; return worker as unknown as Worker; },
      now: () => clock, timeOrigin: 123,
    });
    const providerStartedMs = clock;
    const identity = () => ({ ...data, workerThreadId: worker.threadId, timeOrigin: 123 });
    const providerReceipt = () => ({ status: "NOT_COMPLETE", state: "RUNNING", firstFailure: null, runId: data.runId,
      observerId: data.observerId, port: 3100, wrapperPid: process.pid, wrapperCreatedAt: birth,
      providerPid: 200, providerParentPid: process.pid, providerNativeBirthStamp: stamp(providerBirth), providerCreatedAt: providerBirth,
      wrapperNativeBirthStamp: stamp(birth),
      startedMs: providerStartedMs, startupDeadlineMs: data.startupDeadlineMs, sequence: 0, receipts: [], joined: false });
    const ready = () => worker.emit("message", { ...identity(), event: "READY", readyMs: clock, nativeProviderIdentity: providerReceipt() });
    const result = (extra: Record<string, unknown> = {}) => {
      const query = worker.commands.findLast(command => command.command === "QUERY")!;
      clock += 3;
      worker.emit("message", { ...identity(), event: "QUERY_RESULT", sequence: query.sequence,
        provider: "SPI_SNAPSHOT_HELD_ROOTS_IPHELPER_WMI_FREE", queryStartedMs: Number(query.sentMs) + 1, queryEndedMs: clock - 1,
        queryStartedAt: "2026-10-01T12:00:00.000Z", queryEndedAt: "2026-10-01T12:00:00.001Z",
        error: null, runtime: nativeRuntime(), ...extra });
    };
    const advance = async (ms: number) => { clock += ms; await vi.advanceTimersByTimeAsync(ms); };
    const ack = (extra: Record<string, unknown> = {}) => worker.emit("message", { ...identity(), event: "STOP_ACK",
      sequence: worker.commands.findLast(command => command.command === "STOP")?.sequence, acknowledgedMs: clock,
      nativeProviderJoin: { ...providerReceipt(), status: "PASSED", state: "STOPPED", joined: true,
        sequence: worker.commands.findLast(command => command.command === "STOP")?.sequence,
        stopDeadlineMs: worker.commands.findLast(command => command.command === "STOP")?.deadlineMs,
        eofSent: true, eofAcknowledged: true, stdoutEnded: true, exitObserved: true, closeObserved: true, exitCode: 0, closeCode: 0 }, ...extra });
    const stop = async () => { const done = observer.stop(clock + 1000); ack(); worker.emit("exit", 0); return done; };
    return { observer, worker, record, ready, result, advance, stop, identity, ack };
  };
  it("returns an owned object immediately, joins naturally and preserves raw native births/query provenance", async () => {
    const f = fixture(); expect(f.worker.commands).toEqual([]);
    f.ready(); await f.observer.ready; f.result();
    const row = f.record.mock.calls[0][0].processes[0]; expect(row.createdAt).toBe(birth);
    const snapshot = await f.stop();
    expect(snapshot).toMatchObject({ status: "PASSED", sampleCount: 1, workerJoined: true, workerExitCode: 0 });
    expect(snapshot.receipts.find(row => row.event === "QUERY_RESULT")).toMatchObject({ provider: "SPI_SNAPSHOT_HELD_ROOTS_IPHELPER_WMI_FREE", error: null, workerThreadId: 7 });
    expect(snapshot.stopAcknowledged).toBe(true);
  });
  it("never queues a second census while the first is active and reports coalesced desired ticks", async () => {
    const f = fixture(); f.ready(); await f.observer.ready;
    await f.advance(2000);
    expect(f.worker.commands.filter(row => row.command === "QUERY")).toHaveLength(1);
    expect(f.observer.snapshot().coalescedTicks).toBe(1);
    const stopped = f.observer.stop(clock + 1000); f.result(); f.ack(); f.worker.emit("exit", 0);
    expect((await stopped).status).toBe("PASSED");
  });
  it("bounds missing READY at the unchanged 15s cap without granting fake zero census", async () => {
    const f = fixture(); const ready = expect(f.observer.ready).rejects.toThrow("READY deadline");
    await f.advance(15000); await ready;
    expect(f.record).not.toHaveBeenCalled(); expect((await f.stop()).status).toBe("FAILED");
  });
  it("rejects a zero exit before READY rather than hanging", async () => {
    const f = fixture(); f.worker.emit("exit", 0);
    await expect(f.observer.ready).rejects.toThrow("unexpected worker exit");
    expect((await f.observer.stop(clock + 1000)).status).toBe("FAILED");
  });
  it("keeps unexpected zero idle exit sticky after a valid sample", async () => {
    const f = fixture(); f.ready(); await f.observer.ready; f.result(); f.worker.emit("exit", 0);
    expect((await f.observer.stop(clock + 1000)).status).toBe("FAILED");
  });
  it.each(["observerId", "runId", "workerThreadId", "timeOrigin", "sequence"])("rejects foreign/stale %s without ownership adoption", async field => {
    const f = fixture(); f.ready(); await f.observer.ready;
    f.result({ [field]: field === "workerThreadId" || field === "timeOrigin" || field === "sequence" ? 999 : "foreign" });
    expect(f.record).not.toHaveBeenCalled();
    const done = f.observer.stop(clock + 1000); f.worker.emit("exit", 0);
    expect((await done).status).toBe("FAILED");
  });
  it("provider failure cannot be presented as a successful empty snapshot", async () => {
    const f = fixture(); f.ready(); await f.observer.ready;
    f.result({ error: "native provider failed", runtime: { processes: [], ports: [] } });
    expect(f.observer.snapshot().receipts.find(row => row.event === "QUERY_RESULT")).toMatchObject({
      runtimeValidated: false, processCount: null, portCount: null });
    expect(f.record).not.toHaveBeenCalled(); expect((await f.stop()).error).toBe("native provider failed");
  });
  it("retains the idle sentinel, but rejects missing or malformed birth, opaque claims and duplicate PID", async () => {
    for (const processes of [
      [{ pid: 42, parentPid: 1, name: "node.exe" }],
      [{ pid: 42, parentPid: 1, name: "node.exe", createdAt: "bad" }],
      [{ pid: 42, parentPid: 1, name: "node.exe", createdAt: birth }, { pid: 42, parentPid: 1, name: "node.exe", createdAt: birth }],
    ]) {
      const f = fixture(); f.ready(); await f.observer.ready; f.result({ runtime: { processes, ports: [] } });
      expect(f.record).not.toHaveBeenCalled(); expect((await f.stop()).status).toBe("FAILED");
    }
    const opaque = fixture(); opaque.ready(); await opaque.observer.ready;
    opaque.result({ runtime: nativeRuntime([opaqueRow(42, 1)]) });
    expect(opaque.record).not.toHaveBeenCalled(); expect((await opaque.stop()).status).toBe("FAILED");
    const f = fixture(); f.ready(); await f.observer.ready; f.result({ runtime: nativeRuntime([idleRow]) });
    expect(f.record.mock.calls[0][0].processes[2].createdAt).toBeNull(); expect((await f.stop()).status).toBe("PASSED");
  });
  it("fails a future/regressing query window and does not adopt a valid-looking zero", async () => {
    const f = fixture(); f.ready(); await f.observer.ready;
    f.result({ queryStartedMs: clock + 100, runtime: { processes: [], ports: [] } });
    expect(f.record).not.toHaveBeenCalled(); expect((await f.stop()).status).toBe("FAILED");
  });
  it("retains a main ownership callback failure", async () => {
    const f = fixture(vi.fn(() => { throw new Error("birth fence failed"); }));
    f.ready(); await f.observer.ready; f.result(); expect((await f.stop()).error).toBe("birth fence failed");
  });
  it("rejects overdue actual results at the unchanged query cap", async () => {
    const f = fixture(); f.ready(); await f.observer.ready; await f.advance(15001); f.result();
    expect(f.record).not.toHaveBeenCalled(); expect((await f.stop()).status).toBe("FAILED");
  });
  it("checks actual elapsed even if the overdue timer has not delivered", async () => {
    const f = fixture(); f.ready(); await f.observer.ready; clock += 15001; f.result();
    expect(f.record).not.toHaveBeenCalled(); expect((await f.stop()).status).toBe("FAILED");
  });
  it("rejects malformed provider arrays and foreign port data", async () => {
    for (const runtime of [{ processes: {}, ports: [] },
      { processes: [], ports: [{ pid: 42, port: 3101, state: "LISTEN" }] }]) {
      const f = fixture(); f.ready(); await f.observer.ready; f.result({ runtime });
      expect(f.record).not.toHaveBeenCalled(); expect((await f.stop()).status).toBe("FAILED");
    }
  });
  it("stopping during STARTING preserves ownership and rejects a late READY", async () => {
    const f = fixture(); const stopped = f.observer.stop(clock + 1000);
    await expect(f.observer.ready).rejects.toThrow("stopped before READY");
    f.ready(); f.worker.emit("exit", 0);
    expect((await stopped).status).toBe("FAILED");
    expect(f.worker.commands.filter(row => row.command === "QUERY")).toHaveLength(0);
  });
  it("caches the first stop deadline/rejection and retains actual later natural-exit state", async () => {
    const f = fixture(); f.ready(); await f.observer.ready;
    const first = f.observer.stop(clock + 50), rejected = expect(first).rejects.toThrow("caller stop deadline");
    await f.advance(51); await rejected;
    expect(f.observer.snapshot().workerJoined).toBe(false);
    const second = f.observer.stop(clock + 45000); expect(second).toBe(first);
    await expect(second).rejects.toThrow("caller stop deadline");
    f.result(); f.worker.emit("exit", 0);
    expect(f.observer.snapshot()).toMatchObject({ status: "FAILED", workerJoined: true, stopDeadlineMs: 1050 });
    expect(f.worker.commands.filter(row => row.command === "STOP")).toHaveLength(1);
    expect(f.record).not.toHaveBeenCalled();
  });
  it("allows a multi-minute observation without a constructor physical-cleanup lifetime", async () => {
    const f = fixture(); f.ready(); await f.observer.ready; f.result();
    // Move the monotonic clock, not queued timer callbacks; next fresh query is
    // dispatched by one desired tick and is bound to its current phase.
    clock += 120000; await vi.advanceTimersByTimeAsync(2000); f.result();
    expect((await f.stop()).status).toBe("PASSED");
  });
  it("deducts Worker construction from the original absolute 15s READY budget", async () => {
    const f = fixture(vi.fn(), 500), ready = expect(f.observer.ready).rejects.toThrow("READY deadline");
    await f.advance(14499); expect(f.observer.snapshot().error).toBeUndefined();
    await f.advance(1); await ready;
    expect(clock).toBe(16000); expect((await f.stop()).status).toBe("FAILED");
  });
  it("accepts the exact sent+15000 floating deadline without subtractive-rounding rejection", () => {
    const sent = 16000.123456789, deadline = sent + 15000;
    expect(deadline - sent).not.toBe(15000);
    expect(validRuntimeObservationQueryDeadline(sent, deadline)).toBe(true);
    expect(validRuntimeObservationQueryDeadline(sent, deadline + 1)).toBe(false);
  });
  it("does not mistake a delayed idle exit event for an acknowledged STOP", async () => {
    const f = fixture(); f.ready(); await f.observer.ready; f.result();
    const stopped = f.observer.stop(clock + 1000);
    // The worker had already exited idle; its queued exit callback arrives only
    // after the caller sends STOP. No actual STOP handler acknowledgement exists.
    f.worker.emit("exit", 0);
    expect((await stopped)).toMatchObject({ status: "FAILED", stopAcknowledged: false });
  });
  it.each(["observerId", "sequence", "acknowledgedMs"])("rejects invalid STOP_ACK %s before natural exit", async field => {
    const f = fixture(); f.ready(); await f.observer.ready; f.result();
    const stopped = f.observer.stop(clock + 1000);
    f.ack({ [field]: field === "observerId" ? "foreign" : 999 }); f.worker.emit("exit", 0);
    expect((await stopped).status).toBe("FAILED");
  });
  it("keeps compact census receipts while the main callback receives the complete validated native inventory", async () => {
    const f = fixture(); f.ready(); await f.observer.ready; f.result();
    const snapshot = await f.stop(), receipt = snapshot.receipts.find(row => row.event === "QUERY_RESULT")!;
    expect(receipt).toMatchObject({ runtimeValidated: true, processCount: 3, portCount: 0 });
    expect(receipt).not.toHaveProperty("runtime");
    expect(f.record.mock.calls[0][0].processes).toHaveLength(3);
    expect(JSON.stringify(snapshot.receipts.filter(row => row.event === "QUERY_RESULT"))).not.toContain(birth);
  });
  it("caps the observer subphase once at first STOP so relay latency cannot enlarge its shared 15s", async () => {
    const f = fixture(); f.ready(); await f.observer.ready; f.result();
    const firstStopMs = clock;
    const stop = f.observer.stop(clock + 45000);
    expect(f.worker.commands.findLast(row => row.command === "STOP")?.deadlineMs).toBe(firstStopMs + 15000);
    expect(f.observer.snapshot().stopDeadlineMs).toBe(firstStopMs + 15000);
    expect(f.observer.stop(clock + 60000)).toBe(stop);
    clock += 100; f.ack(); f.worker.emit("exit", 0);
    expect((await stop).status).toBe("PASSED");
    expect(f.observer.snapshot().stopDeadlineMs).toBe(firstStopMs + 15000);
  });
  it("adds failure-only exact candidate/parent identity and fixed native cause without granting ownership", () => {
    const parent = liveRow(42, 1, "node.exe", birth);
    const child = { ...opaqueRow(43, 42), commandLine: "DO_NOT_LOG", password: "DO_NOT_LOG", arbitraryField: { secret: "DO_NOT_LOG" } };
    const diagnostic = ownershipDiagnostic(() => extendOwnedProcessIdentities(untrustedProcesses([parent, child]), [parent]));
    expect(diagnostic).toMatchObject({ kind: "LIVE_PARENT_CHILD_IDENTITY_UNAVAILABLE", ownershipGranted: false,
      candidate: { pid: 43, parentPid: 42, createdAt: null, nativeIdentityStatus: "OPAQUE_NO_HELD_IDENTITY_NO_AUTHORITY",
        nativeIdentityFailure: { code: "NATIVE_HANDLE_UNAVAILABLE", operation: "OPEN_PROCESS", win32Error: 5, ntStatus: null } },
      capturedRootIdentity: { pid: 42, createdAt: birth },
      parent: { pid: 42, createdAt: birth }, capturedCandidateIdentityCount: 0, capturedParentIdentityCount: 1 });
    expect(JSON.stringify(diagnostic)).not.toContain("DO_NOT_LOG");
  });
  it("bounds prior captured PID birth history explicitly and keeps the failure distinct", () => {
    const captured = Array.from({ length: 20 }, (_, index) => liveRow(42, 1, "node.exe", `2026-10-01T12:00:${String(index).padStart(2, "0")}.0000000Z`));
    const candidate = { ...opaqueRow(42, 1), name: "SECRET/".repeat(1000), nativeIdentityFailure: { code: "SECRET", operation: "SECRET", win32Error: -1, ntStatus: 2 ** 40 } };
    const diagnostic = ownershipDiagnostic(() => extendOwnedProcessIdentities(untrustedProcesses([candidate]), captured));
    expect(diagnostic).toMatchObject({ kind: "CAPTURED_PID_IDENTITY_UNAVAILABLE", capturedCandidateIdentityCount: 20,
      identityHistoryTruncated: true, candidate: { name: "NOT_AVAILABLE", nativeIdentityFailure: {
        code: "UNKNOWN_NATIVE_IDENTITY_READ_FAILURE", operation: "UNKNOWN", win32Error: null, ntStatus: null } } });
    expect(diagnostic.capturedCandidateIdentities).toHaveLength(4);
    expect(Buffer.byteLength(JSON.stringify(diagnostic))).toBeLessThan(8192); expect(JSON.stringify(diagnostic)).not.toContain("SECRET");
  });
  it("only the record callback failure adds bounded query identity diagnostic; clean native join cannot rescue sticky failure", async () => {
    const parent = liveRow(42, 1, "node.exe", birth);
    const f = fixture(vi.fn(() => extendOwnedProcessIdentities(untrustedProcesses([parent, opaqueRow(43, 42)]), [parent])));
    f.ready(); await f.observer.ready;
    f.result({ runtime: nativeRuntime([parent]) });
    const receipt = f.observer.snapshot().receipts.find(row => row.event === "QUERY_RESULT")!;
    expect(receipt).toMatchObject({ runtimeValidated: true, ownershipFailureDiagnostic: { candidate: { pid: 43 }, ownershipGranted: false } });
    expect(receipt).not.toHaveProperty("runtime");
    const final = await f.stop();
    expect(final).toMatchObject({ status: "FAILED", workerJoined: true, nativeProviderJoin: { status: "PASSED", joined: true },
      firstOwnershipFailureDiagnostic: { sequence: 1, workerThreadId: 7, diagnostic: { candidate: { pid: 43 } } } });
  });
  it("normal successful receipts and arbitrary callback errors never get fabricated ownership diagnostics", async () => {
    const pass = fixture(); pass.ready(); await pass.observer.ready; pass.result();
    expect((await pass.stop())).not.toHaveProperty("firstOwnershipFailureDiagnostic");
    expect(pass.observer.snapshot().receipts.find(row => row.event === "QUERY_RESULT")).not.toHaveProperty("ownershipFailureDiagnostic");
    const fail = fixture(vi.fn(() => { throw new Error("ordinary callback error"); }));
    fail.ready(); await fail.observer.ready; fail.result(); const result = await fail.stop();
    expect(result.status).toBe("FAILED"); expect(result).not.toHaveProperty("firstOwnershipFailureDiagnostic");
  });
  it("inventory cannot infer exit from a legacy held-exit label with no current birth", () => {
    const parent = liveRow(42, 1, "node.exe", birth);
    const exited = { ...liveRow(43, 42, "node.exe", providerBirth), createdAt: null,
      nativeIdentityStatus: "HELD_HANDLE_EXITED_NO_AUTHORITY", liveAtCaptureEnd: false };
    expect(() => extendOwnedProcessIdentities(untrustedProcesses([parent, exited]), [parent])).toThrow("子进程缺少");
  });
  it("diagnostic getter failures cannot replace the actual callback failure", async () => {
    const error = new Error("original ownership failure");
    Object.defineProperty(error, "ownershipDiagnostic", { get: () => { throw new Error("diagnostic getter failure"); } });
    const f = fixture(vi.fn(() => { throw error; })); f.ready(); await f.observer.ready; f.result();
    expect((await f.stop()).error).toBe("original ownership failure");
  });
});
