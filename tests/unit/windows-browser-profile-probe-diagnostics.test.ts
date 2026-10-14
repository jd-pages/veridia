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
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
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

it("consumes complete stages before bounding a large delayed stderr chunk", async () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    reason: "NATIVE_PROBE_DEADLINE", elapsedMs: 2000, nativeStage: "NATIVE_HANDLE_BIND",
    stageTimeline: [
      { stage: "PROCESS_CENSUS_QUERY_ENTER", scriptElapsedMs: 300, observedElapsedMs: 1000 },
      { stage: "PROCESS_CENSUS_QUERY_RETURN", scriptElapsedMs: 420, observedElapsedMs: 1000 },
      { stage: "NATIVE_HANDLE_BIND", scriptElapsedMs: 430, observedElapsedMs: 1000 },
    ],
  } });
  await vi.advanceTimersByTimeAsync(1000);
  child.stderr.emit("data", Buffer.from(`VERIDIA_PROFILE_PROBE_STAGE=PROCESS_CENSUS_QUERY_ENTER:300\nVERIDIA_PROFILE_PROBE_STAGE=PROCESS_CENSUS_QUERY_RETURN:420\n${"private token discarded\n".repeat(200)}VERIDIA_PROFILE_PROBE_STAGE=NATIVE_HANDLE_BIND:430\n`));
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
  expect(JSON.stringify(getRecoveryDiagnostics()!.nativeProbes.at(-1))).not.toContain("private token");
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  child.emit("close", 1);
});

it("direct WMI census retains exact fields, disposable query resources and all-before-kill admission", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const script = Buffer.from(fixture.spawn.mock.calls[0][1].at(-1), "base64").toString("utf16le");
  expect(script).not.toContain("Get-CimInstance");
  expect(script).toContain("SELECT ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE");
  expect(script).toContain("$options.Timeout = [TimeSpan]::FromMilliseconds(2000)");
  expect(script).toContain("ManagementDateTimeConverter]::ToDateTime");
  expect(script).toContain("finally { $row.Dispose() }");
  expect(script).toContain("$collection.Dispose()");
  expect(script).toContain("$searcher.Dispose()");
  expect(script.indexOf("LIVE_PROCESS_BIRTH_MISMATCH")).toBeLessThan(script.indexOf("$process.Kill()"));
  expect(script.indexOf("UNVERIFIED_PROFILE_OWNER")).toBeLessThan(script.indexOf("$process.Kill()"));
  child.stdout.emit("data", Buffer.from("[]"));
  child.emit("close", 0);
  await expect(pending).resolves.toEqual([]);
});

it("loads the exact built-in Utility manifest before native parser compilation without prewarming", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const script = Buffer.from(fixture.spawn.mock.calls[0][1].at(-1), "base64").toString("utf16le");
  const load = script.indexOf("Import-Module ([IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop");
  const compile = script.indexOf("Microsoft.PowerShell.Utility\\Add-Type -TypeDefinition", load);
  expect(load).toBeGreaterThan(0);
  expect(compile).toBeGreaterThan(load);
  expect(script).toContain("Set-ProbeStage 'UTILITY_MODULE_IMPORTED'");
  expect(script).toContain("Set-ProbeStage 'PROFILE_ARGUMENT_PARSED'");
  expect(script).not.toContain("Start-Sleep");
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 0);
  await expect(pending).resolves.toEqual([]);
});

it("module/parser boundary notices cannot extend the deadline or authorize profile ownership", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_DEADLINE", elapsedMs: 2000,
    nativeStage: "PROFILE_ARGUMENT_PARSED", nativeStageElapsedMs: 1105, nativeStageObservedElapsedMs: 1995 } });
  await vi.advanceTimersByTimeAsync(1995);
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_STAGE=UTILITY_MODULE_IMPORT:10\nVERIDIA_PROFILE_PROBE_STAGE=UTILITY_MODULE_IMPORTED:35\nVERIDIA_PROFILE_PROBE_STAGE=PROFILE_ARGUMENT_PARSED:1105\n"));
  await vi.advanceTimersByTimeAsync(5); await assertion;
  expect(child.kill).toHaveBeenCalledTimes(1); expect(fixture.spawn).toHaveBeenCalledTimes(1); child.emit("close", 1);
});

it("keeps command text fixed and transfers the full large Unicode identity set through UTF-8 stdin", async () => {
  const executable = "E:\\测试工具\\chrome.exe";
  const profile = "E:\\隔离 profile\\小红书";
  const owners = Array.from({ length: 100 }, (_, index) => ({
    pid: index + 100, birthStamp: String(134000000000000000n + BigInt(index)),
    executablePath: executable, profilePath: profile, parentPid: 10, browserProcess: false,
  }));
  const small = childFixture();
  const first = captureWindowsBrowserProfileOwners(executable, profile);
  const smallArgs = fixture.spawn.mock.calls.at(-1)![1];
  small.stdout.emit("data", Buffer.from("[]")); small.emit("close", 0);
  await expect(first).resolves.toEqual([]);
  const large = childFixture();
  const second = captureWindowsBrowserProfileOwners(executable, profile, owners);
  const [, args, options] = fixture.spawn.mock.calls.at(-1)!;
  expect(args).toEqual(smallArgs);
  expect(args.join(" ").length).toBeLessThan(30_000);
  expect(options.stdio).toEqual(["pipe", "pipe", "pipe"]);
  expect(large.stdin.end).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
    executablePath: executable, profilePath: profile, terminate: owners,
  }), "utf8");
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  expect(script).toContain("[Console]::In.ReadToEnd() | ConvertFrom-Json");
  expect(script).toContain("[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)");
  expect(script).not.toContain(executable);
  expect(script).not.toContain(profile);
  expect(script.indexOf("UNVERIFIED_PROFILE_OWNER")).toBeLessThan(script.indexOf("$process.Kill()"));
  large.stdout.emit("data", Buffer.from("[]")); large.emit("close", 0);
  await expect(second).resolves.toEqual([]);
});

it("stdin errors fail closed once without retrying or admitting any owner", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_INPUT_FAILED" } });
  child.stdin.emit("error", Error("private pipe failure"));
  await assertion;
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 0);
});
