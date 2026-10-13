import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));
import { captureWindowsBrowserProfileOwners } from "@/lib/automation/windows-browser-process-owner";
import { getRecoveryDiagnostics } from "@/lib/automation/recovery-diagnostics";

beforeEach(() => { vi.useFakeTimers(); fixture.spawn.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stderr: new EventEmitter(), stdout: new EventEmitter(), kill: vi.fn(() => true),
  });
  fixture.spawn.mockReturnValue(child);
  return child;
}

it("the unchanged 2000ms deadline retains the last observed fixed native phase without retry", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    phase: "PROFILE_OWNER_PROBE", reason: "NATIVE_PROBE_DEADLINE", elapsedMs: 2000,
    nativeStage: "PROCESS_CENSUS", nativeStageElapsedMs: 300,
  } });
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_STAGE=SCRIPT_ENTERED:0\nprivate token\nVERIDIA_PROFILE_PROBE_STAGE=PROCESS_"));
  child.stderr.emit("data", Buffer.from("CENSUS:300\r\n"));
  await vi.advanceTimersByTimeAsync(1999);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await assertion;
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  child.emit("close", 1);
});

it("a native birth rejection remains failed and exports only fixed diagnostic fields", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    reason: "NATIVE_PROBE_EXIT", exitCode: 1, nativeStage: "NATIVE_HANDLE_BIND",
    nativeStageElapsedMs: 400, nativeFailureCode: "LIVE_PROCESS_BIRTH_MISMATCH",
  } });
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_STAGE=NATIVE_HANDLE_BIND:400\nVERIDIA_PROFILE_PROBE_FAILURE=NATIVE_HANDLE_BIND:LIVE_PROCESS_BIRTH_MISMATCH\n"));
  child.emit("close", 1);
  await assertion;
  expect(child.kill).not.toHaveBeenCalled();
});

it("retains the precise native sub-operation and both clocks without extending the total budget", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    reason: "NATIVE_PROBE_DEADLINE", elapsedMs: 2000, nativeStage: "NATIVE_HANDLE_OPEN",
    nativeStageElapsedMs: 1365, nativeStageObservedElapsedMs: 1900,
  } });
  await vi.advanceTimersByTimeAsync(1900);
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_STAGE=NATIVE_HANDLE_OPEN:1365\n"));
  // Incomplete or unrecognized stderr cannot overwrite the last measured stage.
  await vi.advanceTimersByTimeAsync(50);
  child.stderr.emit("data", Buffer.from("private token\nVERIDIA_PROFILE_PROBE_STAGE=PRIVATE_SECRET:1400\n"));
  await vi.advanceTimersByTimeAsync(50);
  await assertion;
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  child.emit("close", 1);
});

it("stage evidence cannot replace valid owner JSON or bless successful exit with invalid output", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toThrow("所有权响应无效");
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_STAGE=RESULT_EMIT:500\n"));
  child.stdout.emit("data", Buffer.from("OWNERSHIP_PASSED"));
  child.emit("close", 0);
  await assertion;
  expect(child.kill).not.toHaveBeenCalled();
});

it("retains all complete sub-operation markers in one chunk and correlates native birth with the spawned probe only", async () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = Object.assign(childFixture(), { pid: 321 });
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    reason: "NATIVE_PROBE_DEADLINE", elapsedMs: 2000, nativeStage: "PROCESS_CENSUS_QUERY_ENTER",
    probeProcessId: 321, probeBirthStamp: "134000000000000001",
    stageTimeline: [
      { stage: "PARSER_COMPILED", scriptElapsedMs: 800, observedElapsedMs: 1500 },
      { stage: "PROCESS_CENSUS", scriptElapsedMs: 850, observedElapsedMs: 1500 },
      { stage: "PROCESS_CENSUS_QUERY_ENTER", scriptElapsedMs: 851, observedElapsedMs: 1500 },
    ],
  } });
  await vi.advanceTimersByTimeAsync(1500);
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_SELF=999:999\nVERIDIA_PROFILE_PROBE_SELF=321:134000000000000001\nVERIDIA_PROFILE_PROBE_STAGE=PARSER_COMPILED:800\nVERIDIA_PROFILE_PROBE_STAGE=PROCESS_CENSUS:850\nVERIDIA_PROFILE_PROBE_STAGE=PROCESS_CENSUS_QUERY_ENTER:851\n"));
  await vi.advanceTimersByTimeAsync(500);
  await assertion;
  const receipt = getRecoveryDiagnostics()!.nativeProbes.at(-1)!;
  expect(receipt).toMatchObject({ status: "FAILED", probeProcessId: 321, probeBirthStamp: "134000000000000001" });
  expect(receipt.probeId).toEqual(expect.any(String));
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  child.emit("close", 1);
  vi.unstubAllEnvs();
});
