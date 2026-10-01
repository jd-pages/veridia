import { test } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createPersistentRuntimeProvider, safeNativeFailureCategory, validateNativeIdentityFailure } from "../../scripts/testing/runtime-observation-provider-client.mjs";
import { extendOwnedProcessIdentities } from "../../scripts/testing/e2e-server-infrastructure.mjs";

// Fake pipes/process only: no PowerShell, native census, browser, server, or DB.
const runId = "PURE-11111111-1111-4111-8111-111111111111";
const observerId = "22222222-2222-4222-8222-222222222222";
const wrapperIdentity = { pid: 100, createdAt: "2026-10-01T00:00:00.0000000Z" };
const providerCreatedAt = "2026-10-01T00:00:01.0000000Z";
const stamp = (value: string) => String(BigInt(Date.parse(value)) * 10000n + 116444736000000000n + BigInt(value.slice(23, 27)));
const verified = (pid: number, parentPid: number, name: string, createdAt: string) => ({ pid, parentPid, name, createdAt,
  nativeBirthStamp: stamp(createdAt), nativeIdentityStatus: "SNAPSHOT_ONLY_BIRTH_PARENT_NAME_OBSERVATION" as const, workingSetBytes: 1000,
  parentIdentityProof: "SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY" as const, liveAtCaptureEnd: null, ownershipAuthority: false as const });
const idle = { pid: 0, parentPid: 0, name: null, createdAt: null, nativeBirthStamp: null,
  nativeIdentityStatus: "SPI_IDLE_SENTINEL_NO_AUTHORITY", parentIdentityProof: "SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY",
  liveAtCaptureEnd: null, ownershipAuthority: false } as const;
const comparison = (row: ReturnType<typeof verified>) => ({ pid: row.pid, parentPid: row.parentPid, name: row.name,
  createdAt: row.createdAt, nativeBirthStamp: row.nativeBirthStamp, nativeWaitResultBefore: 258, nativeWaitResultAfter: 258,
  sameHandleLiveAtBothBoundaries: true, snapshotMatchesHeld: true });
const opaque = { pid: 4, parentPid: 0, name: "System", createdAt: null, nativeBirthStamp: null,
  nativeIdentityStatus: "OPAQUE_NO_HELD_IDENTITY_NO_AUTHORITY", liveAtCaptureEnd: false,
  parentIdentityProof: "TOOLHELP_SNAPSHOT_OPAQUE_NO_AUTHORITY",
  nativeIdentityFailure: { code: "NATIVE_HANDLE_UNAVAILABLE", operation: "OPEN_PROCESS", win32Error: 5, ntStatus: null } };

interface FixtureRuntime { processes: Record<string, unknown>[]; ports: unknown[]; nativeProvider?: string;
  providerElapsedMs: number; tcpFamiliesComplete?: string[]; heldComparisons: Record<string, unknown>[];
  spiCoverage: Record<string, unknown>; publicAbiGuarantee?: string; }
class FakeProvider extends EventEmitter {
  pid = 200; endCount = 0; stdout = new EventEmitter(); stderr = new EventEmitter();
  stdin: EventEmitter & { write(value: string): void; end(): void } = Object.assign(new EventEmitter(),
    { write: () => undefined, end: () => undefined });
}
function fixture({ spawnCost = 0, spawnThrow = false } = {}) {
  let clock = 0, nextTimer = 0;
  const timers = new Map<number, { fn: () => void; at: number; delay: number }>(), writes: Record<string, unknown>[] = [], child = new FakeProvider();
  child.pid = 200; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { write: (value: string) => { writes.push(JSON.parse(value)); return undefined; }, end: () => { child.endCount++; } });
  child.endCount = 0;
  const client = createPersistentRuntimeProvider({ runId, observerId, wrapperIdentity, port: 3100,
    now: () => clock, setTimer: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay, delay }); return id; },
    clearTimer: id => { timers.delete(Number(id)); }, spawnImpl: (command, args, options) => {
      assert.equal(command, "powershell.exe"); assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
      assert.equal(args[args.indexOf("-ExecutionPolicy") + 1], "Bypass");
      assert.equal(args[args.indexOf("-File") + 1].replaceAll("\\", "/").endsWith("/scripts/testing/runtime-observation-provider.ps1"), true);
      clock += spawnCost;
      if (spawnThrow) throw new Error("FAKE_SPAWN_FAILURE");
      return child;
    } });
  const identity = { runId, observerId, wrapperPid: 100, providerPid: 200, port: 3100,
    providerParentPid: 100, providerNativeBirthStamp: stamp(providerCreatedAt), callerWrapperCanonicalBirth: wrapperIdentity.createdAt,
    callerWrapperNativeBirthStamp: stamp(wrapperIdentity.createdAt) };
  const frameBytes = (row: Record<string, unknown>) => Buffer.from(JSON.stringify({ ...identity, ...row }) + "\n");
  const frame = (row: Record<string, unknown>) => child.stdout.emit("data", frameBytes(row));
  const runtime = (): FixtureRuntime => ({ processes: [verified(100, 50, "node.exe", wrapperIdentity.createdAt),
    verified(200, 100, "powershell.exe", providerCreatedAt), { ...idle }], ports: [],
    nativeProvider: "SPI_SNAPSHOT_HELD_ROOTS_IPHELPER_WMI_FREE", providerElapsedMs: 1, tcpFamiliesComplete: ["IPv4", "IPv6"], publicAbiGuarantee: "NOT_GUARANTEED",
    heldComparisons: [comparison(verified(100, 50, "node.exe", wrapperIdentity.createdAt)), comparison(verified(200, 100, "powershell.exe", providerCreatedAt))],
    spiCoverage: { osBuild: 26200, architecture: "AMD64", layoutProfile: "SPI_X64_PREFIX256_THREAD80_CREATE32_IMAGE56_PID80_PARENT88",
      queryStatus: 0, returnLength: 4096, bufferCapacity: 8388608, inventoryComplete: true,
      snapshotCompletedUtcFileTime: stamp("2026-10-01T00:00:02.0000000Z"), clockSource: "GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME" } });
  const ready = (overrides: Record<string, unknown> = {}) => frame({ event: "READY", providerCreatedAt, ...overrides });
  const result = (overrides: Record<string, unknown> = {}) => frame({ event: "QUERY_RESULT", sequence: client.snapshot().sequence,
    providerElapsedMs: 2, error: null, runtime: runtime(), ...overrides });
  const finish = ({ ack = true, sequence = client.snapshot().sequence, code = 0, signal = null } = {}) => {
    if (ack) frame({ event: "EOF_ACK", sequence, eofObserved: true, providerElapsedMs: clock });
    child.stdout.emit("end"); child.emit("exit", code, signal); child.emit("close", code, signal);
  };
  const advance = (amount: number, fire = true) => { clock += amount; if (fire) {
    const due = [...timers].filter(([, timer]) => timer.at <= clock);
    for (const [id, timer] of due) if (timers.delete(id)) timer.fn();
  } };
  return { client, child, writes, timers, frame, frameBytes, runtime, ready, result, finish, advance, now: () => clock };
}
const rejectCode = async (promise: Promise<unknown>, code: string) => assert.rejects(promise, error => error instanceof Error && error.message === code);
const enter = async (value: ReturnType<typeof fixture>) => { value.ready(); await value.client.ready; };
const joined = async (value: ReturnType<typeof fixture>) => { const stop = value.client.stop(value.now() + 1000); value.finish(); return stop; };
const untrustedProcesses = (rows: unknown[]) => rows as Parameters<typeof extendOwnedProcessIdentities>[0];

test("valid READY/query/EOF/native close; compact receipts retain no inventory", async () => {
  const f = fixture(); await enter(f);
  const query = f.client.query({ deadlineMs: 15000 }); f.result();
  const runtime = await query;
  assert.equal(runtime.processes.length, 3); assert.equal(runtime.processes[2].createdAt, null);
  assert.deepEqual(f.writes[0], { command: "QUERY", runId, observerId, sequence: 1, port: 3100,
    remainingMs: 15000, wrapperPid: 100, providerPid: 200 });
  const final = await joined(f);
  assert.equal(final.status, "PASSED"); assert.equal(final.joined, true);
  const receipt = final.receipts.find(row => row.event === "QUERY_RESULT_VALIDATED");
  assert.ok(receipt);
  assert.equal(receipt.processCount, 3); assert.equal(receipt.idleSentinelCount, 1); assert.equal(receipt.heldComparisonCount, 2);
  assert.equal(runtime.processes[0].liveAtCaptureEnd, null); assert.equal(runtime.processes[0].ownershipAuthority, false);
  assert.equal(JSON.stringify(final).includes('"processes"'), false);
});
test("READY budget includes synchronous provider spawn/compile setup cost", async () => {
  const f = fixture({ spawnCost: 500 });
  assert.equal([...f.timers.values()][0].delay, 14500);
  f.advance(14500); await rejectCode(f.client.ready, "PROVIDER_READY_DEADLINE_EXHAUSTED");
});
test("inventory cannot claim an exited held identity", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const runtime = f.runtime(); runtime.processes.push({ ...verified(300, 100, "chrome.exe", providerCreatedAt),
    createdAt: null, liveAtCaptureEnd: false, nativeIdentityStatus: "HELD_HANDLE_EXITED_NO_AUTHORITY" });
  f.result({ runtime }); await rejectCode(query, "PROVIDER_NATIVE_IDENTITY_STATUS_INVALID");
  const stop = f.client.stop(1000); f.finish(); await rejectCode(stop, "PROVIDER_NATIVE_IDENTITY_STATUS_INVALID");
});
test("actual late READY fails even before overdue timer callback delivery", async () => {
  const f = fixture(); f.advance(15000, false); f.ready();
  await rejectCode(f.client.ready, "PROVIDER_READY_PHASE_OR_DEADLINE_INVALID");
});
test("missing READY and pre-ready native exit cannot hang or pass", async () => {
  const f = fixture(); f.child.emit("exit", 0, null);
  await rejectCode(f.client.ready, "PROVIDER_UNEXPECTED_NATIVE_EXIT");
});
for (const [name, overrides, code] of [
  ["foreign observer", { observerId: "33333333-3333-4333-8333-333333333333" }, "PROVIDER_READY_IDENTITY_INVALID"],
  ["wrong parent", { providerParentPid: 99 }, "PROVIDER_READY_IDENTITY_INVALID"],
  ["wrong wrapper birth", { callerWrapperCanonicalBirth: providerCreatedAt }, "PROVIDER_READY_IDENTITY_INVALID"],
  ["wrong wrapper full birth", { callerWrapperNativeBirthStamp: stamp(providerCreatedAt) }, "PROVIDER_READY_IDENTITY_INVALID"],
  ["canonical/native birth mismatch", { providerCreatedAt: wrapperIdentity.createdAt }, "PROVIDER_READY_BIRTH_INVALID"],
  ["nonmicrosecond canonical birth", { providerCreatedAt: "2026-10-01T00:00:01.0000001Z" }, "PROVIDER_READY_BIRTH_INVALID"],
] as [string, Record<string, unknown>, string][]) test(`READY rejects ${name}`, async () => {
  const f = fixture(); f.ready(overrides); await rejectCode(f.client.ready, code);
});
test("query stale UUID rejects without claiming zero runtime", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.result({ observerId: "33333333-3333-4333-8333-333333333333" });
  await rejectCode(query, "PROVIDER_FRAME_IDENTITY_INVALID");
  assert.equal(f.client.snapshot().receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
});
test("query sequence gap is sticky failed", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 }); f.result({ sequence: 2 });
  await rejectCode(query, "PROVIDER_QUERY_SEQUENCE_INVALID");
});
test("READY full wrapper birth remains bound even for a within-floor100ns frame drift", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.result({ callerWrapperNativeBirthStamp: String(BigInt(stamp(wrapperIdentity.createdAt)) + 1n) });
  await rejectCode(query, "PROVIDER_FRAME_IDENTITY_INVALID");
});
test("overlapping query is rejected; original pending query cannot rescue status", async () => {
  const f = fixture(); await enter(f); const original = f.client.query({ deadlineMs: 1000 });
  const overlap = f.client.query({ deadlineMs: 1000 });
  await rejectCode(overlap, "PROVIDER_QUERY_OVERLAP"); await rejectCode(original, "PROVIDER_QUERY_OVERLAP");
  f.result(); const stop = f.client.stop(1000); f.finish(); await rejectCode(stop, "PROVIDER_QUERY_OVERLAP");
});
test("native query error is sticky, never fake successful zero", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.result({ runtime: null, error: "NATIVE_CENSUS_FAILED_NO_FALLBACK" });
  await rejectCode(query, "NATIVE_CENSUS_FAILED_NO_FALLBACK");
  assert.equal(f.client.snapshot().receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
});
test("actual elapsed query deadline rejects before delayed timer", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.advance(1000, false); f.result(); await rejectCode(query, "PROVIDER_QUERY_ACTUAL_DEADLINE_EXHAUSTED");
});
test("query duration cannot exceed supplied native remaining budget", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.result({ providerElapsedMs: 1001 }); await rejectCode(query, "PROVIDER_QUERY_ACTUAL_DEADLINE_EXHAUSTED");
});
test("query deadline cannot enlarge 15s or round a submillisecond remainder to zero", async () => {
  const f = fixture(); await enter(f);
  await rejectCode(f.client.query({ deadlineMs: 15001 }), "PROVIDER_QUERY_DEADLINE_INVALID");
  const g = fixture(); await enter(g);
  await rejectCode(g.client.query({ deadlineMs: 0.5 }), "PROVIDER_QUERY_DEADLINE_INVALID");
  assert.equal(g.writes.length, 0);
});
for (const [name, mutate, code] of [
  ["empty full inventory", runtime => runtime.processes = [], "PROVIDER_COVERAGE_INCOMPLETE"],
  ["duplicate PID", runtime => runtime.processes.push({ ...runtime.processes[0] }), "PROVIDER_PROCESS_ROW_INVALID"],
  ["idle invented birth", runtime => runtime.processes[2].createdAt = providerCreatedAt, "PROVIDER_IDLE_SENTINEL_INVALID"],
  ["opaque wrapper", runtime => runtime.processes[0] = { ...opaque, pid: 100, name: "node.exe" }, "PROVIDER_NATIVE_IDENTITY_STATUS_INVALID"],
  ["wrapper PID reuse", runtime => runtime.processes[0] = verified(100, 50, "node.exe", providerCreatedAt), "PROVIDER_SELF_OR_WRAPPER_CENSUS_IDENTITY_INVALID"],
  ["wrong provider name", runtime => runtime.processes[1].name = "chrome.exe", "PROVIDER_SELF_OR_WRAPPER_CENSUS_IDENTITY_INVALID"],
  ["snapshot falsely not live", runtime => runtime.processes[1].liveAtCaptureEnd = false, "PROVIDER_SNAPSHOT_IDENTITY_INVALID"],
  ["parent metadata falsely authoritative", runtime => runtime.processes[0].parentIdentityProof = "OWNERSHIP_GRANTED", "PROVIDER_SNAPSHOT_IDENTITY_INVALID"],
  ["null malformed TCP row", runtime => runtime.ports = [null], "PROVIDER_PORT_ROW_INVALID"],
  ["foreign listener port", runtime => runtime.ports = [{ pid: 100, port: 3101, family: "IPv4", state: "LISTEN" }], "PROVIDER_PORT_ROW_INVALID"],
  ["provider marker absent", runtime => delete runtime.nativeProvider, "PROVIDER_COVERAGE_INCOMPLETE"],
  ["missing TCP family completion", runtime => delete runtime.tcpFamiliesComplete, "PROVIDER_COVERAGE_INCOMPLETE"],
  ["partial TCP family completion", runtime => runtime.tcpFamiliesComplete = ["IPv4"], "PROVIDER_COVERAGE_INCOMPLETE"],
] as [string, (runtime: FixtureRuntime) => void, string][]) test(`runtime rejects ${name}`, async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const runtime = f.runtime(); mutate(runtime); f.result({ runtime }); await rejectCode(query, code);
});
test("stop in flight drains query then sends EOF; natural join required", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const stop = f.client.stop(1000); assert.equal(f.child.endCount, 0);
  f.result(); await query; assert.equal(f.child.endCount, 1);
  assert.equal(f.client.snapshot().joined, false); f.finish(); assert.equal((await stop).status, "PASSED");
});
test("idle exit delayed until stop lacks actual EOF ACK and fails", async () => {
  const f = fixture(); await enter(f); const stop = f.client.stop(1000); f.finish({ ack: false });
  await rejectCode(stop, "PROVIDER_STDOUT_END_WITHOUT_VALID_EOF_ACK");
});
test("EOF ACK is not itself a native join", async () => {
  const f = fixture(); await enter(f); const stop = f.client.stop(1000);
  f.frame({ event: "EOF_ACK", sequence: 0, eofObserved: true, providerElapsedMs: 1 });
  assert.equal(f.client.snapshot().joined, false);
  f.advance(1000); await rejectCode(stop, "PROVIDER_STOP_DEADLINE_EXHAUSTED");
});
test("stop budget is first caller's cached absolute deadline, late close cannot green", async () => {
  const f = fixture(); await enter(f); const stop = f.client.stop(100);
  assert.equal(f.client.stop(15000), stop);
  f.advance(100); await rejectCode(stop, "PROVIDER_STOP_DEADLINE_EXHAUSTED"); f.finish();
  assert.equal(f.client.snapshot().joined, true); assert.equal(f.client.snapshot().status, "FAILED");
  assert.equal(f.client.stop(30000), stop); assert.equal(f.client.snapshot().stopDeadlineMs, 100);
});
test("native close without stdout end cannot pass", async () => {
  const f = fixture(); await enter(f); const stop = f.client.stop(1000);
  f.frame({ event: "EOF_ACK", sequence: 0, eofObserved: true, providerElapsedMs: 1 });
  f.child.emit("exit", 0, null); f.child.emit("close", 0, null);
  await rejectCode(stop, "PROVIDER_NATIVE_JOIN_INVALID");
});
test("natural exit may precede valid EOF ACK pipe drainage, but close still requires both", async () => {
  const f = fixture(); await enter(f); const stop = f.client.stop(1000);
  f.child.emit("exit", 0, null); assert.equal(f.client.snapshot().joined, false);
  f.frame({ event: "EOF_ACK", sequence: 0, eofObserved: true, providerElapsedMs: 1 });
  f.child.stdout.emit("end"); f.child.emit("close", 0, null);
  assert.equal((await stop).status, "PASSED");
});
test("first stop cannot enlarge the unchanged 15s provider cap", async () => {
  const f = fixture(); await enter(f); await rejectCode(f.client.stop(15001), "PROVIDER_STOP_DEADLINE_INVALID");
  assert.equal(f.client.snapshot().joined, false);
});
test("nonzero native exit remains failed after valid EOF ACK", async () => {
  const f = fixture(); await enter(f); const stop = f.client.stop(1000); f.finish({ code: 1 });
  await rejectCode(stop, "PROVIDER_UNEXPECTED_NATIVE_EXIT");
});
test("spawn failure returns rejected READY/stop, never fabricated joined", async () => {
  const f = fixture({ spawnThrow: true }); await rejectCode(f.client.ready, "FAKE_SPAWN_FAILURE");
  await rejectCode(f.client.stop(1000), "FAKE_SPAWN_FAILURE"); assert.equal(f.client.snapshot().joined, false);
});
test("malformed and oversized stdout cannot become successful empty results", async () => {
  const f = fixture(); f.child.stdout.emit("data", Buffer.from("{not json}\n"));
  await rejectCode(f.client.ready, "PROVIDER_JSON_FRAME_INVALID");
  const g = fixture(); g.child.stdout.emit("data", Buffer.alloc(4 * 1024 * 1024 + 1, 65));
  await rejectCode(g.client.ready, "PROVIDER_FRAME_SIZE_EXCEEDED");
});
test("asynchronous EPIPE/pipe errors are sticky safe failures, never unhandled exceptions", async () => {
  for (const stream of ["stdin", "stdout", "stderr"] as const) {
    const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
    assert.doesNotThrow(() => f.child[stream].emit("error", Object.assign(new Error("synthetic"), { code: "EPIPE" })));
    await rejectCode(query, `PROVIDER_${stream.toUpperCase()}_STREAM_ERROR`);
    f.result(); const stop = f.client.stop(1000); f.finish();
    await rejectCode(stop, `PROVIDER_${stream.toUpperCase()}_STREAM_ERROR`);
    assert.equal(f.client.snapshot().joined, true); assert.equal(f.client.snapshot().status, "FAILED");
  }
});
test("fixed native error category retained safely; arbitrary error text is never retained", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.result({ runtime: null, error: "NATIVE_CENSUS_FAILED_NO_FALLBACK", nativeErrorCategory: "NATIVE_TCP_TABLE_FAILED" });
  await rejectCode(query, "NATIVE_CENSUS_FAILED_NO_FALLBACK");
  assert.equal(f.client.snapshot().receipts.find(row => row.event === "NATIVE_FAILURE_CATEGORY")?.category, "NATIVE_TCP_TABLE_FAILED");
  assert.equal(safeNativeFailureCategory("secret or command-line text"), "UNKNOWN_NATIVE_OR_PROTOCOL_FAILURE");
});
test("safe SPI primary and handle-release secondary retained without replacing first failure", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.result({ runtime: null, error: "NATIVE_CENSUS_FAILED_NO_FALLBACK", nativeErrorCategory: "SPI_SELECTED_SNAPSHOT_MISMATCH",
    nativeSecondaryErrorCategory: "NATIVE_PROCESS_HANDLE_CLOSE_FAILED" });
  await rejectCode(query, "NATIVE_CENSUS_FAILED_NO_FALLBACK");
  const final = f.client.snapshot(); assert.equal(final.firstFailure, "NATIVE_CENSUS_FAILED_NO_FALLBACK");
  assert.equal(final.receipts.find(row => row.event === "NATIVE_FAILURE_CATEGORY")?.category, "SPI_SELECTED_SNAPSHOT_MISMATCH");
  assert.equal(final.receipts.find(row => row.event === "NATIVE_SECONDARY_FAILURE_CATEGORY")?.category, "NATIVE_PROCESS_HANDLE_CLOSE_FAILED");
});
test("arbitrary secondary failure text is rejected and never enters receipts", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.result({ runtime: null, error: "NATIVE_CENSUS_FAILED_NO_FALLBACK", nativeErrorCategory: "SPI_QUERY_NTSTATUS_FAILED",
    nativeSecondaryErrorCategory: "DO_NOT_LOG_RAW_PATH" });
  await rejectCode(query, "PROVIDER_NATIVE_SECONDARY_CATEGORY_INVALID");
  assert.equal(JSON.stringify(f.client.snapshot()).includes("DO_NOT_LOG_RAW_PATH"), false);
});
test("captured PID opaque/null identity cannot silently prove its exit", () => {
  const captured = verified(300, 100, "chrome.exe", providerCreatedAt);
  assert.throws(() => extendOwnedProcessIdentities(untrustedProcesses([{ ...opaque, pid: 300 }]), [captured]), /已捕获 PID/u);
});
test("new opaque child of a live captured parent fails without adoption", () => {
  const captured = verified(300, 100, "chrome.exe", providerCreatedAt);
  assert.throws(() => extendOwnedProcessIdentities(untrustedProcesses([captured, { ...opaque, pid: 301, parentPid: 300 }]), [captured]), /子进程缺少/u);
});
test("null identity cannot claim exit of the same captured birth", () => {
  const captured = verified(300, 100, "chrome.exe", providerCreatedAt);
  const exited = { ...captured, createdAt: null, liveAtCaptureEnd: false, nativeIdentityStatus: "HELD_HANDLE_EXITED_NO_AUTHORITY" };
  assert.throws(() => extendOwnedProcessIdentities(untrustedProcesses([exited]), [captured]), /已捕获 PID/u);
  assert.throws(() => extendOwnedProcessIdentities(untrustedProcesses([{ ...exited, nativeBirthStamp: stamp(wrapperIdentity.createdAt) }]), [captured]), /已捕获 PID/u);
});

for (const evidence of [
  { code: "NATIVE_HANDLE_UNAVAILABLE", operation: "OPEN_PROCESS", win32Error: 87, ntStatus: null },
  { code: "NATIVE_HELD_PID_MISMATCH", operation: "GET_PROCESS_ID", win32Error: null, ntStatus: null },
  { code: "NATIVE_HELD_BASIC_INVALID", operation: "NT_QUERY_BASIC", win32Error: null, ntStatus: -1073741811 },
  { code: "NATIVE_HELD_BIRTH_UNAVAILABLE", operation: "GET_PROCESS_TIMES", win32Error: 5, ntStatus: null },
  { code: "NATIVE_HELD_IMAGE_UNAVAILABLE", operation: "QUERY_FULL_PROCESS_IMAGE_NAME", win32Error: null, ntStatus: null },
  { code: "NATIVE_HELD_NAME_INVALID", operation: "VALIDATE_IMAGE_BASENAME", win32Error: null, ntStatus: null },
  { code: "UNKNOWN_NATIVE_IDENTITY_READ_FAILURE", operation: "UNKNOWN", win32Error: null, ntStatus: null },
]) test(`opaque provenance validates exact ${evidence.operation} fields without authority`, () => {
  const copy = validateNativeIdentityFailure(evidence);
  assert.deepEqual(copy, evidence); assert.notEqual(copy, evidence);
});

for (const [name, mutate] of [
  ["missing provenance", (row: Record<string, unknown>) => delete row.nativeIdentityFailure],
  ["unknown code", (row: Record<string, unknown>) => row.nativeIdentityFailure = { ...opaque.nativeIdentityFailure, code: "secret-path-or-exception" }],
  ["unknown operation", (row: Record<string, unknown>) => row.nativeIdentityFailure = { ...opaque.nativeIdentityFailure, operation: "RAW_COMMAND" }],
  ["wrong code operation pairing", (row: Record<string, unknown>) => row.nativeIdentityFailure = { ...opaque.nativeIdentityFailure, operation: "GET_PROCESS_TIMES" }],
  ["extra sensitive field", (row: Record<string, unknown>) => row.nativeIdentityFailure = { ...opaque.nativeIdentityFailure, path: "not-permitted" }],
  ["negative Win32", (row: Record<string, unknown>) => row.nativeIdentityFailure = { ...opaque.nativeIdentityFailure, win32Error: -1 }],
  ["oversized Win32", (row: Record<string, unknown>) => row.nativeIdentityFailure = { ...opaque.nativeIdentityFailure, win32Error: 4294967296 }],
  ["fractional Win32", (row: Record<string, unknown>) => row.nativeIdentityFailure = { ...opaque.nativeIdentityFailure, win32Error: 5.5 }],
  ["string Win32", (row: Record<string, unknown>) => row.nativeIdentityFailure = { ...opaque.nativeIdentityFailure, win32Error: "5" }],
  ["missing OpenProcess Win32", (row: Record<string, unknown>) => row.nativeIdentityFailure = { ...opaque.nativeIdentityFailure, win32Error: null }],
  ["NTSTATUS on Win32 operation", (row: Record<string, unknown>) => row.nativeIdentityFailure = { ...opaque.nativeIdentityFailure, ntStatus: 0 }],
  ["NTSTATUS outside int32", (row: Record<string, unknown>) => row.nativeIdentityFailure = { code: "NATIVE_HELD_BASIC_INVALID", operation: "NT_QUERY_BASIC", win32Error: null, ntStatus: 2147483648 }],
  ["missing NTSTATUS", (row: Record<string, unknown>) => row.nativeIdentityFailure = { code: "NATIVE_HELD_BASIC_INVALID", operation: "NT_QUERY_BASIC", win32Error: null, ntStatus: null }],
] as [string, (row: Record<string, unknown>) => unknown][]) test(`historical failure diagnostic rejects ${name} safely`, () => {
  const row: Record<string, unknown> = { ...opaque, nativeIdentityFailure: { ...opaque.nativeIdentityFailure } };
  mutate(row);
  assert.throws(() => validateNativeIdentityFailure(row.nativeIdentityFailure), /PROVIDER_OPAQUE_FAILURE_PROVENANCE_INVALID/u);
});

test("Win32 87 provenance does not prove exit or permit adoption", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const runtime = f.runtime(); runtime.processes.push({ ...opaque, pid: 301, parentPid: 100,
    nativeIdentityFailure: { ...opaque.nativeIdentityFailure, win32Error: 87 } });
  f.result({ runtime }); await rejectCode(query, "PROVIDER_NATIVE_IDENTITY_STATUS_INVALID");
  assert.equal(f.client.snapshot().receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
});

test("snapshot rows cannot carry opaque failures and inventory never accepts held exit claims", async () => {
  for (const exited of [false, true]) {
    const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
    const runtime = f.runtime(); runtime.processes.push({ ...verified(300, 100, "chrome.exe", providerCreatedAt),
      ...(exited ? { createdAt: null, liveAtCaptureEnd: false, nativeIdentityStatus: "HELD_HANDLE_EXITED_NO_AUTHORITY" } : {}),
      nativeIdentityFailure: { ...opaque.nativeIdentityFailure } });
    f.result({ runtime }); await rejectCode(query, exited ? "PROVIDER_NATIVE_IDENTITY_STATUS_INVALID" : "PROVIDER_SNAPSHOT_IDENTITY_INVALID");
  }
});

for (const build of [26100, 26200]) test(`SPI snapshot accepts only explicitly profiled build ${build}, without endpoint-live claims`, async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const runtime = f.runtime(); runtime.spiCoverage.osBuild = build;
  runtime.processes.push(verified(300, 100, "chrome.exe", providerCreatedAt));
  runtime.processes.push(verified(301, 100, "valid-😀.exe", providerCreatedAt));
  f.result({ runtime }); const received = await query;
  assert.equal(received.processes[3].liveAtCaptureEnd, null); assert.equal(received.processes[3].ownershipAuthority, false);
  assert.equal(extendOwnedProcessIdentities(received.processes, [verified(100, 50, "node.exe", wrapperIdentity.createdAt)]).some(row => row.pid === 300), true);
  assert.equal((await joined(f)).status, "PASSED");
});
test("snapshot birth ordering prevents reused-parent adoption and retains historical identities", () => {
  const parent = verified(100, 50, "node.exe", providerCreatedAt);
  const olderChild = verified(300, 100, "chrome.exe", wrapperIdentity.createdAt);
  assert.deepEqual(extendOwnedProcessIdentities([parent, olderChild, idle], [parent]), [parent]);
  const reusedParent = verified(100, 50, "node.exe", "2026-10-01T00:00:02.0000000Z");
  assert.deepEqual(extendOwnedProcessIdentities([reusedParent, olderChild], [parent]), [parent]);
  assert.deepEqual(extendOwnedProcessIdentities([], [parent]), [parent]); // absence is not an exit assertion
});
for (const [name, mutate, code] of [
  ["missing snapshot birth", r => r.processes[0].createdAt = null, "PROVIDER_SNAPSHOT_IDENTITY_INVALID"],
  ["snapshot full/canonical birth mismatch", r => r.processes[0].nativeBirthStamp = stamp(providerCreatedAt), "PROVIDER_SNAPSHOT_IDENTITY_INVALID"],
  ["snapshot fabricated held status", r => r.processes[0].nativeIdentityStatus = "HELD_HANDLE_PID_PARENT_BIRTH_NAME_VERIFIED", "PROVIDER_NATIVE_IDENTITY_STATUS_INVALID"],
  ["snapshot invented end liveness", r => r.processes[0].liveAtCaptureEnd = true, "PROVIDER_SNAPSHOT_IDENTITY_INVALID"],
  ["snapshot invented authority", r => r.processes[0].ownershipAuthority = true, "PROVIDER_SNAPSHOT_IDENTITY_INVALID"],
  ["unpaired UTF16 name", r => r.processes.push(verified(300, 100, "bad-\uD800.exe", providerCreatedAt)), "PROVIDER_SNAPSHOT_IDENTITY_INVALID"],
  ["within-floor wrapper census drift", r => { r.processes[0].nativeBirthStamp = String(BigInt(stamp(wrapperIdentity.createdAt)) + 1n); r.heldComparisons[0].nativeBirthStamp = r.processes[0].nativeBirthStamp; }, "PROVIDER_SELF_OR_WRAPPER_CENSUS_IDENTITY_INVALID"],
  ["idle invented parent", r => r.processes[2].parentPid = 100, "PROVIDER_IDLE_SENTINEL_INVALID"],
  ["idle invented name", r => r.processes[2].name = "Idle", "PROVIDER_IDLE_SENTINEL_INVALID"],
  ["missing selected comparison", r => r.heldComparisons.pop(), "PROVIDER_HELD_COMPARISONS_INVALID"],
  ["extra selected comparison", r => r.heldComparisons.push({ ...r.heldComparisons[0] }), "PROVIDER_HELD_COMPARISONS_INVALID"],
  ["duplicate selected comparison", r => r.heldComparisons[1] = { ...r.heldComparisons[0] }, "PROVIDER_HELD_COMPARISON_MISMATCH"],
  ["foreign selected PID", r => r.heldComparisons[1].pid = 999, "PROVIDER_HELD_COMPARISON_MISMATCH"],
  ["selected parent mismatch", r => r.heldComparisons[0].parentPid = 999, "PROVIDER_HELD_COMPARISON_MISMATCH"],
  ["selected name mismatch", r => r.heldComparisons[0].name = "chrome.exe", "PROVIDER_HELD_COMPARISON_MISMATCH"],
  ["selected birth mismatch", r => r.heldComparisons[0].nativeBirthStamp = stamp(providerCreatedAt), "PROVIDER_HELD_COMPARISON_MISMATCH"],
  ["selected canonical mismatch", r => r.heldComparisons[0].createdAt = providerCreatedAt, "PROVIDER_HELD_COMPARISON_MISMATCH"],
  ["selected early exit", r => r.heldComparisons[0].nativeWaitResultBefore = 0, "PROVIDER_HELD_COMPARISON_MISMATCH"],
  ["selected late wait failure", r => r.heldComparisons[0].nativeWaitResultAfter = 4294967295, "PROVIDER_HELD_COMPARISON_MISMATCH"],
  ["selected missing live proof", r => r.heldComparisons[0].sameHandleLiveAtBothBoundaries = false, "PROVIDER_HELD_COMPARISON_MISMATCH"],
  ["selected missing equality proof", r => r.heldComparisons[0].snapshotMatchesHeld = false, "PROVIDER_HELD_COMPARISON_MISMATCH"],
  ["unapproved future build", r => r.spiCoverage.osBuild = 26201, "PROVIDER_SPI_COVERAGE_INVALID"],
  ["wrong architecture", r => r.spiCoverage.architecture = "ARM64", "PROVIDER_SPI_COVERAGE_INVALID"],
  ["unknown layout", r => r.spiCoverage.layoutProfile = "AUTODETECT", "PROVIDER_SPI_COVERAGE_INVALID"],
  ["NT query error", r => r.spiCoverage.queryStatus = -1073741820, "PROVIDER_SPI_COVERAGE_INVALID"],
  ["incomplete buffer", r => r.spiCoverage.inventoryComplete = false, "PROVIDER_SPI_COVERAGE_INVALID"],
  ["oversized buffer", r => r.spiCoverage.returnLength = 8388609, "PROVIDER_SPI_COVERAGE_INVALID"],
  ["short buffer", r => r.spiCoverage.returnLength = 255, "PROVIDER_SPI_COVERAGE_INVALID"],
  ["different buffer cap", r => r.spiCoverage.bufferCapacity = 16777216, "PROVIDER_SPI_COVERAGE_INVALID"],
  ["invented ABI guarantee", r => r.publicAbiGuarantee = "GUARANTEED", "PROVIDER_COVERAGE_INCOMPLETE"],
  ["missing capture clock", r => delete r.spiCoverage.snapshotCompletedUtcFileTime, "PROVIDER_SPI_COVERAGE_INVALID"],
  ["missing precise clock provenance", r => delete r.spiCoverage.clockSource, "PROVIDER_SPI_COVERAGE_INVALID"],
  ["coarse clock provenance", r => r.spiCoverage.clockSource = "DATETIME_UTCNOW", "PROVIDER_SPI_COVERAGE_INVALID"],
  ["nonpositive capture clock", r => r.spiCoverage.snapshotCompletedUtcFileTime = "00000000000000000", "PROVIDER_SPI_COVERAGE_INVALID"],
  ["malformed capture clock", r => r.spiCoverage.snapshotCompletedUtcFileTime = "1e18", "PROVIDER_SPI_COVERAGE_INVALID"],
  ["birth after capture clock", r => r.spiCoverage.snapshotCompletedUtcFileTime = stamp(wrapperIdentity.createdAt), "PROVIDER_SNAPSHOT_BIRTH_AFTER_CAPTURE"],
] as [string, (runtime: FixtureRuntime) => unknown, string][]) test(`SPI rejects ${name} without accepting a zero fallback`, async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const runtime = f.runtime(); mutate(runtime); f.result({ runtime }); await rejectCode(query, code);
  assert.equal(f.client.snapshot().receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
});

function nameQueryBytes(f: ReturnType<typeof fixture>, name: string) {
  const runtime = f.runtime(); runtime.processes.push(verified(300, 100, name, providerCreatedAt));
  return f.frameBytes({ event: "QUERY_RESULT", sequence: 1, providerElapsedMs: 2, error: null, runtime });
}
function corruptNameBytes(f: ReturnType<typeof fixture>, invalid: number[]) {
  const raw = nameQueryBytes(f, "BAD_MARKER.exe"), marker = Buffer.from("BAD_MARKER.exe"), offset = raw.indexOf(marker);
  assert.ok(offset >= 0);
  return Buffer.concat([raw.subarray(0, offset), Buffer.from(invalid), Buffer.from(".exe"), raw.subarray(offset + marker.length)]);
}
for (const [name, invalid] of [
  ["bad continuation", [0xc3, 0x28]], ["overlong sequence", [0xc0, 0xaf]], ["isolated continuation", [0x80]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]], ["out of Unicode range", [0xf4, 0x90, 0x80, 0x80]],
] as [string, number[]][]) test(`fatal stdout UTF8 rejects ${name} without replacement or successful census receipt`, async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  assert.doesNotThrow(() => f.child.stdout.emit("data", corruptNameBytes(f, invalid)));
  await rejectCode(query, "PROVIDER_STDOUT_UTF8_INVALID");
  assert.equal(f.client.snapshot().receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
  assert.equal(f.client.snapshot().status, "FAILED");
});
test("fatal stdout UTF8 rejects an invalid sequence split across chunks", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const raw = corruptNameBytes(f, [0xc3, 0x28]), offset = raw.indexOf(Buffer.from([0xc3, 0x28]));
  f.child.stdout.emit("data", raw.subarray(0, offset + 1));
  assert.equal(f.client.snapshot().firstFailure, null);
  assert.doesNotThrow(() => f.child.stdout.emit("data", raw.subarray(offset + 1)));
  await rejectCode(query, "PROVIDER_STDOUT_UTF8_INVALID");
  assert.equal(f.client.snapshot().receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
});
test("fatal decoder flush catches truncated EOF inside the stdout end listener", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.child.stdout.emit("data", Buffer.from([0xf0, 0x9f]));
  assert.doesNotThrow(() => f.child.stdout.emit("end"));
  await rejectCode(query, "PROVIDER_STDOUT_UTF8_INVALID");
  assert.equal(f.client.snapshot().stdoutEnded, true);
  assert.equal(f.client.snapshot().receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
});
test("valid astral UTF8 split between bytes retains original name and joins normally", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const name = "valid-😀.exe", bytes = nameQueryBytes(f, name), offset = bytes.indexOf(Buffer.from("😀"));
  assert.ok(offset >= 0);
  f.child.stdout.emit("data", bytes.subarray(0, offset + 1));
  f.child.stdout.emit("data", bytes.subarray(offset + 1, offset + 3));
  f.child.stdout.emit("data", bytes.subarray(offset + 3));
  const received = await query; assert.equal(received.processes[3].name, name);
  assert.equal((await joined(f)).status, "PASSED");
});
test("genuine UTF8 replacement code point is legal; invalid byte replacement is not", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const name = "valid-\uFFFD.exe"; f.child.stdout.emit("data", nameQueryBytes(f, name));
  assert.equal((await query).processes[3].name, name); assert.equal((await joined(f)).status, "PASSED");
});
test("UTF8 BOM stays visible and cannot silently broaden JSON framing", async () => {
  const f = fixture();
  f.child.stdout.emit("data", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), f.frameBytes({ event: "READY", providerCreatedAt })]));
  await rejectCode(f.client.ready, "PROVIDER_JSON_FRAME_INVALID");
});
test("invalid UTF8 and truncated end cannot replace an earlier sticky provider failure", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.result({ runtime: null, error: "NATIVE_CENSUS_FAILED_NO_FALLBACK" }); await rejectCode(query, "NATIVE_CENSUS_FAILED_NO_FALLBACK");
  assert.doesNotThrow(() => f.child.stdout.emit("data", Buffer.from([0xc3, 0x28])));
  f.child.stdout.emit("data", Buffer.from([0xf0, 0x9f])); assert.doesNotThrow(() => f.child.stdout.emit("end"));
  assert.equal(f.client.snapshot().firstFailure, "NATIVE_CENSUS_FAILED_NO_FALLBACK");
  assert.equal(f.client.snapshot().receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
});

test("precise capture bound accepts exact equality at full FILETIME precision", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const runtime = f.runtime(); runtime.spiCoverage.snapshotCompletedUtcFileTime = stamp(providerCreatedAt);
  f.result({ runtime }); assert.equal((await query).spiCoverage.snapshotCompletedUtcFileTime, stamp(providerCreatedAt));
  assert.equal((await joined(f)).status, "PASSED");
});

test("precise capture bound rejects a snapshot birth one tick after the bound", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const runtime = f.runtime(), child = verified(300, 100, "chrome.exe", providerCreatedAt);
  child.nativeBirthStamp = String(BigInt(stamp(providerCreatedAt)) + 1n);
  runtime.processes.push(child); runtime.spiCoverage.snapshotCompletedUtcFileTime = stamp(providerCreatedAt);
  f.result({ runtime }); await rejectCode(query, "PROVIDER_SNAPSHOT_BIRTH_AFTER_CAPTURE");
  assert.equal(f.client.snapshot().receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
});

test("synthetic coarse-before-birth accepts only the declared measured precise bound", async () => {
  // This fake fixture validates wire semantics, not a native clock/API execution.
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  const runtime = f.runtime(), born = BigInt(stamp(providerCreatedAt)), coarse = born - 992n, precise = born + 11773n;
  assert.ok(coarse < born && born <= precise);
  runtime.spiCoverage.snapshotCompletedUtcFileTime = String(precise);
  f.result({ runtime }); assert.equal((await query).spiCoverage.snapshotCompletedUtcFileTime, String(precise));
  assert.equal((await joined(f)).status, "PASSED");
});

const birthGuardFailure = (creationSigned = "0", branch = "NON_POSITIVE_BIRTH") => ({
  branch, pid: 300, parentPid: 100, creationSigned, utcBirthUpperBound: stamp(providerCreatedAt),
  clockSource: "GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME",
});
for (const evidence of [birthGuardFailure(), birthGuardFailure("-9223372036854775808"),
  birthGuardFailure(String(BigInt(stamp(providerCreatedAt)) + 1n), "AFTER_PRECISE_UTC_BOUND")]) {
  test(`birth guard retains exact safe ${evidence.branch}/${evidence.creationSigned} provenance without adoption`, async () => {
    const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
    f.result({ runtime: null, error: "NATIVE_CENSUS_FAILED_NO_FALLBACK", nativeErrorCategory: "SPI_BIRTH_OUTSIDE_CAPTURE_UTC_BOUND",
      birthGuardFailure: evidence });
    await rejectCode(query, "NATIVE_CENSUS_FAILED_NO_FALLBACK");
    const snapshot = f.client.snapshot();
    assert.deepEqual(snapshot.receipts.find(row => row.event === "NATIVE_FAILURE_CATEGORY")?.birthGuardFailure, evidence);
    assert.equal(snapshot.receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
    assert.equal(snapshot.firstFailure, "NATIVE_CENSUS_FAILED_NO_FALLBACK");
  });
}
for (const [name, mutate] of [
  ["missing", () => undefined], ["extra raw field", row => ({ ...row, path: "DO_NOT_RETAIN_PATH" })],
  ["unknown branch", row => ({ ...row, branch: "UNKNOWN" })],
  ["invalid PID", row => ({ ...row, pid: 2147483648 })], ["fractional parent", row => ({ ...row, parentPid: 1.5 })],
  ["numeric creation", row => ({ ...row, creationSigned: 0 })], ["signed overflow", row => ({ ...row, creationSigned: "-9223372036854775809" })],
  ["positive in nonpositive branch", row => ({ ...row, creationSigned: "1" })],
  ["equal in future branch", row => ({ ...row, branch: "AFTER_PRECISE_UTC_BOUND", creationSigned: row.utcBirthUpperBound })],
  ["zero upper", row => ({ ...row, utcBirthUpperBound: "0" })],
  ["unrepresentable upper", row => ({ ...row, utcBirthUpperBound: "2650467744000000000" })],
  ["malformed upper", row => ({ ...row, utcBirthUpperBound: "1e18" })],
  ["wrong clock", row => ({ ...row, clockSource: "DATETIME_UTCNOW" })],
] as [string, (row: ReturnType<typeof birthGuardFailure>) => unknown][]) {
  test(`birth guard rejects ${name} provenance without retaining raw values`, async () => {
    const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
    f.result({ runtime: null, error: "NATIVE_CENSUS_FAILED_NO_FALLBACK", nativeErrorCategory: "SPI_BIRTH_OUTSIDE_CAPTURE_UTC_BOUND",
      birthGuardFailure: mutate(birthGuardFailure()) });
    await rejectCode(query, "PROVIDER_BIRTH_GUARD_FAILURE_INVALID");
    assert.equal(f.client.snapshot().receipts.some(row => row.event === "NATIVE_FAILURE_CATEGORY"), false);
    assert.equal(JSON.stringify(f.client.snapshot()).includes("DO_NOT_RETAIN_PATH"), false);
  });
}
test("birth guard cannot appear with another category or successful result", async () => {
  for (const success of [false, true]) {
    const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
    f.result({ ...(success ? {} : { runtime: null, error: "NATIVE_CENSUS_FAILED_NO_FALLBACK", nativeErrorCategory: "NATIVE_TCP_TABLE_FAILED" }),
      birthGuardFailure: birthGuardFailure() });
    await rejectCode(query, "PROVIDER_BIRTH_GUARD_CATEGORY_INVALID");
    assert.equal(f.client.snapshot().receipts.some(row => row.event === "QUERY_RESULT_VALIDATED"), false);
  }
});
test("invalid birth guard cannot replace an earlier sticky failure", async () => {
  const f = fixture(); await enter(f); const query = f.client.query({ deadlineMs: 1000 });
  f.result({ runtime: null, error: "NATIVE_CENSUS_FAILED_NO_FALLBACK", nativeErrorCategory: "NATIVE_TCP_TABLE_FAILED" });
  await rejectCode(query, "NATIVE_CENSUS_FAILED_NO_FALLBACK");
  f.frame({ event: "FAILED", nativeErrorCategory: "SPI_BIRTH_OUTSIDE_CAPTURE_UTC_BOUND", birthGuardFailure: { path: "DO_NOT_RETAIN_PATH" } });
  assert.equal(f.client.snapshot().firstFailure, "NATIVE_CENSUS_FAILED_NO_FALLBACK");
  assert.equal(JSON.stringify(f.client.snapshot()).includes("DO_NOT_RETAIN_PATH"), false);
});
test("native precise clock source/order is a static contract only, not parser execution", () => {
  const source = readFileSync(new URL("../../scripts/testing/runtime-observation-native.cs", import.meta.url), "utf8");
  const query = source.indexOf("int status=querySystem(5,buffer,SpiCapacity,out returned)");
  const successGuard = source.indexOf('if(status!=0) throw new InvalidOperationException("SPI_QUERY_NTSTATUS_FAILED")', query);
  const bound = source.indexOf("ulong utcBirthUpperBound=PreciseUtcBound()", query);
  const parse = source.indexOf("ParseSpi(buffer,returned,utcBirthUpperBound,watch,budgetMs)", bound);
  const emitted = source.indexOf('"snapshotCompletedUtcFileTime",utcBirthUpperBound.ToString', parse);
  assert.ok(query >= 0 && successGuard > query && bound > successGuard && parse > bound && emitted > parse);
  assert.equal((source.match(/utcBirthUpperBound=PreciseUtcBound\(\)/gu) || []).length, 1);
  assert.equal(source.includes("DateTime.UtcNow"), false);
  assert.ok(source.includes('"clockSource","GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME"'));
  assert.ok(source.includes("entry.creation<=0 || (ulong)entry.creation>utcBirthUpperBound"));
  assert.equal(/utcBirthUpperBound\s*(?:\+=|=\s*Math\.Max)/u.test(source), false);
});
