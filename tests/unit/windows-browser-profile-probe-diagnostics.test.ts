import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), clock: null as number | null }));
vi.mock("node:child_process", () => ({ spawn: fixture.spawn }));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => fixture.clock ?? Date.now() } }));
import { captureWindowsBrowserProfileOwners } from "@/lib/automation/windows-browser-process-owner";
import { getRecoveryDiagnostics } from "@/lib/automation/recovery-diagnostics";

beforeEach(() => { vi.useFakeTimers(); fixture.spawn.mockReset(); fixture.clock = null; });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

function childFixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
    stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }), kill: vi.fn(() => true), unref: vi.fn(),
  });
  const emit = child.emit.bind(child);
  let exited = false;
  child.emit = (event, ...args) => {
    if (event === "exit") exited = true;
    if (event === "close" && !exited) { child.stdout.emit("end"); emit("exit", args[0], null); exited = true; }
    return emit(event, ...args);
  };
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

it("native stage markers keep immediate newline delivery without a redundant per-row flush", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const script = Buffer.from(fixture.spawn.mock.calls[0][1].at(-1), "base64").toString("utf16le").replace(/\r\n/gu, "\n");
  const stage = script.match(/function Set-ProbeStage\(\[string\]\$value\) \{([\s\S]*?)\n\}/u)?.[1];
  expect(stage).toBeDefined();
  expect(stage).toContain("$script:phase=$value");
  expect(stage).toContain("[Console]::Error.WriteLine('VERIDIA_PROFILE_PROBE_STAGE='");
  expect(stage).toContain("$probeClock.ElapsedMilliseconds");
  expect(stage).not.toContain("[Console]::Error.Flush()");
  for (const phase of ["WMI_GET_ENTER", "WMI_MOVE_ENTER", "NATIVE_BIRTH_VALIDATE", "VALIDATED_TERMINATION", "RESULT_WRITTEN"]) {
    expect(script).toContain(`Set-ProbeStage '${phase}'`);
  }
  expect(script).toContain("$options.Timeout = [TimeSpan]::FromMilliseconds(2000)");
  child.stdout.emit("data", Buffer.from("[]"));
  child.emit("close", 0);
  await expect(pending).resolves.toEqual([]);
});

it("direct WMI census retains exact fields, disposable query resources and all-before-kill admission", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const script = Buffer.from(fixture.spawn.mock.calls[0][1].at(-1), "base64").toString("utf16le");
  expect(script).not.toContain("Get-CimInstance");
  expect(script).toContain("SELECT ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE");
  expect(script).toContain("$options.Timeout = [TimeSpan]::FromMilliseconds(2000)");
  expect(script).toContain("$options.BlockSize = 32");
  expect(script).toContain("Name='$name' AND ExecutablePath='$queryExecutable'");
  expect(script).toContain("$queryExecutable = $expectedExecutable.Replace('\\','\\\\').Replace(\"'\",\"\\'\")");
  expect(script).toContain("if (![string]::Equals($candidate.ExecutablePath, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase)) { continue }");
  expect(script).toContain("ManagementDateTimeConverter]::ToDateTime");
  expect(script).toContain("finally { Set-ProbeStage 'WMI_ROW_DISPOSE'; $row.Dispose(); Set-ProbeStage 'WMI_ROW_DISPOSED' }");
  expect(script).toContain("$enumerator = $collection.GetEnumerator()");
  expect(script).toContain("$more = $enumerator.MoveNext()");
  expect(script).toContain("if ($enumerator -is [IDisposable]) { $enumerator.Dispose() }");
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
  const submit = script.indexOf("$collection = $searcher.Get()");
  const enumerate = script.indexOf("$enumerator = $collection.GetEnumerator()");
  expect(submit).toBeGreaterThan(load);
  expect(compile).toBeGreaterThan(submit);
  expect(enumerate).toBeGreaterThan(compile);
  expect(script).toContain("if (!$script:parserReady)");
  expect(script).toContain("$script:parserReady = $true");
  expect(script).toContain("$options.ReturnImmediately = $true; $options.Rewindable = $false");
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
  expect(script).toContain("[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)");
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
  // Failure cannot claim physical exit merely from kill() returning true.
  child.emit("close", 0);
  await assertion;
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 0);
});

it("direct native traversal keeps duplicate-profile and exactly-one termination admission before every kill", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const script = Buffer.from(fixture.spawn.mock.calls[0][1].at(-1), "base64").toString("utf16le");
  expect(script).not.toContain("Where-Object");
  expect(script).not.toContain("ForEach-Object");
  expect(script).toContain("foreach ($argument in $argv)");
  expect(script).toContain("$profiles.Count -ne 1 -or !$profiles[0]");
  expect(script).toContain("$argument.StartsWith('--type=', [StringComparison]::OrdinalIgnoreCase)");
  expect(script).toContain("foreach ($expected in $request.terminate)");
  expect(script).toContain("$matchCount -ne 1");
  expect(script.indexOf("$matchCount -ne 1")).toBeLessThan(script.indexOf("$process.Kill()"));
  expect(script).toContain("if ($nativeCode -eq 5 -and $exited -eq 'TRUE') { continue }");
  expect(script).toContain("$exited='UNKNOWN'; try { $exited=$(if($process.HasExited){'TRUE'}else{'FALSE'}) } catch {}");
  expect(script).toContain("Set-ProbeStage 'RESULT_SERIALIZED'");
  expect(script).toContain("Set-ProbeStage 'RESULT_WRITTEN'");
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 0);
  await expect(pending).resolves.toEqual([]);
});

it("written owner JSON and exit notices still cannot bypass the unchanged close/2000ms fence", async () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = Object.assign(childFixture(), { pid: 321 });
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    reason: "NATIVE_PROBE_DEADLINE", elapsedMs: 2000, nativeStage: "RESULT_WRITTEN",
    stdoutBytes: 2, stdoutEnded: true, nativeExitObserved: true,
  } });
  await vi.advanceTimersByTimeAsync(1500);
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_STAGE=RESULT_SERIALIZED:800\nVERIDIA_PROFILE_PROBE_STAGE=RESULT_WRITTEN:801\n"));
  child.stdout.emit("data", Buffer.from("[]")); child.stdout.emit("end"); child.emit("exit", 0);
  await vi.advanceTimersByTimeAsync(500); await assertion;
  // Exit has already been observed. Killing again is neither required nor
  // evidence of drained pipes/close; the missing close still fails admission.
  expect(fixture.spawn).toHaveBeenCalledTimes(1); expect(child.kill).not.toHaveBeenCalled();
  child.emit("close", 0);
});

it("native script UTC evidence is PID-bound, bounded and diagnostic-only", async () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = Object.assign(childFixture(), { pid: 321 });
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const nativeEpoch = Date.now() + 123;
  child.stderr.emit("data", Buffer.from(`VERIDIA_PROFILE_PROBE_SELF=999:999:${nativeEpoch}\nVERIDIA_PROFILE_PROBE_SELF=321:134000000000000001:${nativeEpoch}\nVERIDIA_PROFILE_PROBE_SELF=321:134000000000000001:99999999999999999\n`));
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 0);
  await expect(pending).resolves.toEqual([]);
  expect(getRecoveryDiagnostics()!.nativeProbes.findLast(row => row.status === "NATIVE_EXIT_SUCCESS"))
    .toMatchObject({ probeProcessId: 321, probeBirthStamp: "134000000000000001", nativeScriptObservedAt: new Date(nativeEpoch).toISOString() });
});

it("numeric termination evidence never admits an owner or suppresses the native failure", async () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_EXIT", exitCode: 1,
    terminationFailure: { pid: 321, birthStamp: "134000000000000001", nativeErrorCode: 5, hresult: -2147467259, exitedAfterError: "TRUE" } } });
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_TERMINATION_FAILURE=321:134000000000000001:5:-2147467259:TRUE\n"));
  child.emit("close", 1); await assertion;
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
  expect(child.kill).not.toHaveBeenCalled();
});

it("retains the last 64 fixed census subcalls and fails closed at the same deadline", async () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    reason: "NATIVE_PROBE_DEADLINE", elapsedMs: 2000, nativeStage: "WMI_MOVE_ENTER", nativeStageElapsedMs: 1099,
  } });
  child.stderr.emit("data", Buffer.from(Array.from({ length: 100 }, (_, index) =>
    `VERIDIA_PROFILE_PROBE_STAGE=WMI_MOVE_ENTER:${index + 1000}\n`).join("")));
  await vi.advanceTimersByTimeAsync(2000); await assertion;
  const stages = getRecoveryDiagnostics()!.nativeProbes.at(-1)!.stageTimeline as Array<{ stage: string; scriptElapsedMs: number }>;
  expect(stages).toHaveLength(64);
  expect(stages[0].scriptElapsedMs).toBe(1036);
  expect(stages.at(-1)).toMatchObject({ stage: "WMI_MOVE_ENTER", scriptElapsedMs: 1099 });
  expect(child.kill).toHaveBeenCalledTimes(1); expect(fixture.spawn).toHaveBeenCalledTimes(1);
  child.emit("close", 1);
});

it("terminal stderr without LF retains the final phase and PID-bound birth, never raw text", async () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = Object.assign(childFixture(), { pid: 321 });
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_EXIT", exitCode: 1,
    probeProcessId: 321, probeBirthStamp: "134000000000000001", nativeStage: "WMI_GET_ENTER", closureProof: "CLOSED" } });
  child.stderr.emit("data", Buffer.from("PRIVATE\nVERIDIA_PROFILE_PROBE_SELF=321:134000000000000001\nVERIDIA_PROFILE_PROBE_STAGE=WMI_GET_ENTER:3"));
  child.emit("close", 1); await assertion;
  expect(JSON.stringify(getRecoveryDiagnostics()!.nativeProbes.at(-1))).not.toContain("PRIVATE");
  expect(child.listenerCount("close")).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it("spawn setup consumes the same absolute budget and wall time cannot extend it", async () => {
  const child = childFixture(); fixture.clock = 0;
  fixture.spawn.mockImplementation(() => { fixture.clock = 700; return child; });
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_DEADLINE", elapsedMs: 2000,
    closureProof: "NOT_PROVEN", nativeCloseObserved: false, terminationRequest: { returned: true }, ioReleased: true } });
  vi.setSystemTime(Date.now() - 60000); fixture.clock = 2000;
  await vi.advanceTimersByTimeAsync(1300); await assertion;
  expect(child.kill).toHaveBeenCalledTimes(1); expect(child.stdin.destroy).toHaveBeenCalledTimes(1);
  expect(child.unref).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  expect(child.listenerCount("close")).toBe(0);
});

it("late close code0 cannot bypass a delayed timer", async () => {
  const child = childFixture(); fixture.clock = 0;
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_DEADLINE", closureProof: "CLOSED" } });
  child.stdout.emit("data", Buffer.from("[]")); fixture.clock = 2001; child.emit("close", 0);
  await assertion; expect(child.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("JSON and identity validation cannot overrun the admission deadline", async () => {
  const child = childFixture(); fixture.clock = 0;
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_DEADLINE", elapsedMs: 2000 } });
  child.stdout.emit("data", Buffer.from("[]"));
  const parse = JSON.parse; const spy = vi.spyOn(JSON, "parse").mockImplementation(text => { fixture.clock = 2000; return parse(text); });
  child.emit("close", 0); spy.mockRestore(); await assertion;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["null", '[null]', '[{"pid":321,"birthStamp":"1","executablePath":"E:\\\\other.exe","profilePath":"E:\\\\fixture\\\\isolated-profile"}]'])("invalid response %s retains original process/probe identity", async output => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = Object.assign(childFixture(), { pid: 321 });
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_RESPONSE_INVALID",
    probeProcessId: 321, probeId: expect.any(String), closureProof: "CLOSED", ioReleased: true } });
  child.stdout.emit("data", Buffer.from(output)); child.emit("close", 0); await assertion;
  expect(child.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("identity validation itself crossing2000ms cannot admit a valid owner", async () => {
  const child = childFixture(); fixture.clock = 0;
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_DEADLINE" } });
  child.stdout.emit("data", Buffer.from("[]"));
  const spy = vi.spyOn(JSON, "parse").mockImplementation(() => [{ pid: 321, birthStamp: "1",
    get executablePath() { fixture.clock = 2000; return "E:\\fixture\\chrome.exe"; }, profilePath: "E:\\fixture\\isolated-profile" }]);
  child.emit("close", 0); spy.mockRestore(); await assertion;
  expect(child.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});

it("spawn exhausting2000ms never delivers a request or waits beyond its failed admission", async () => {
  const child = childFixture(); fixture.clock = 0;
  fixture.spawn.mockImplementation(() => { fixture.clock = 2000; return child; });
  await expect(captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile"))
    .rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_DEADLINE", closureProof: "NOT_PROVEN", ioReleased: true } });
  expect(child.stdin.end).not.toHaveBeenCalled(); expect(child.kill).toHaveBeenCalledTimes(1);
  expect(child.unref).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it("output failure preserves first cause through delayed close0 and cannot admit owners", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_OUTPUT_LIMIT", closureProof: "CLOSED" } });
  child.stdout.emit("data", Buffer.from(" ".repeat(100001))); await vi.advanceTimersByTimeAsync(100);
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 0); await assertion;
  expect(child.kill).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it("an incomplete stderr fragment at an unproved cutoff cannot invent a final stage", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_DEADLINE", closureProof: "NOT_PROVEN" } });
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_STAGE=WMI_GET_ENTER:1"));
  await vi.advanceTimersByTimeAsync(2000);
  const result = await pending.catch(error => error); await assertion;
  expect(result.diagnostic.nativeStage).toBeUndefined(); expect(vi.getTimerCount()).toBe(0);
});

it("deferred spawn error after bounded disposal cannot crash caller or change failed admission", async () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = childFixture(); fixture.clock = 0;
  fixture.spawn.mockImplementation(() => { fixture.clock = 2000; return child; });
  const error = await captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile").catch(value => value);
  expect(() => child.emit("error", Error("PRIVATE SPAWN FAILURE"))).not.toThrow();
  expect(error.diagnostic).toMatchObject({ reason: "NATIVE_PROBE_DEADLINE", closureProof: "NOT_PROVEN" });
  expect(getRecoveryDiagnostics()!.nativeProbes.at(-1)).toMatchObject({ status: "DISPOSED_NATIVE_ERROR", closureProof: "NOT_PROVEN" });
  expect(JSON.stringify(getRecoveryDiagnostics()!.nativeProbes.at(-1))).not.toContain("PRIVATE");
  expect(child.listenerCount("error")).toBe(0); expect(vi.getTimerCount()).toBe(0);
});

it("active pipe failure waits for close and cannot turn pipe error into owner success", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_PIPE_FAILED", closureProof: "CLOSED" } });
  child.stderr.emit("error", Error("PRIVATE PIPE FAILURE"));
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 0); await assertion;
  expect(child.kill).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  expect(child.stdout.listenerCount("error")).toBe(0); expect(child.stderr.listenerCount("error")).toBe(0);
});

it("input failure waits for actual delayed close within the original budget", async () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = Object.assign(childFixture(), { pid: 321 });
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  let settled = false; const observed = pending.catch(error => { settled = true; return error; });
  child.stdin.emit("error", Error("PRIVATE")); await Promise.resolve(); expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1500); expect(settled).toBe(false);
  child.emit("close", 1);
  expect(await observed).toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_INPUT_FAILED", operationFailureElapsedMs: 0,
    elapsedMs: 1500, terminationRequest: { returned: true }, nativeExitObserved: true, nativeCloseObserved: true, closureProof: "CLOSED" } });
  const events = getRecoveryDiagnostics()!.nativeProbes.filter(row => row.probeProcessId === 321).slice(-5).map(row => row.status);
  expect(events).toEqual(["OPERATION_FAILED", "TERMINATION_REQUEST", "NATIVE_EXIT_OBSERVED", "NATIVE_CLOSE_OBSERVED", "FAILED"]);
  expect(vi.getTimerCount()).toBe(0); expect(child.listenerCount("exit")).toBe(0);
});

it.each(["false", "throw"])("kill %s cannot invent closure or leave an unbounded promise", async kind => {
  const child = childFixture();
  child.kill.mockImplementation(() => { if (kind === "throw") throw Error("PRIVATE"); return false; });
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_INPUT_FAILED",
    closureProof: "NOT_PROVEN", nativeCloseObserved: false, ioReleased: true,
    terminationRequest: kind === "throw" ? { errorCode: "KILL_THROWN" } : { returned: false } } });
  child.stdin.emit("error", Error("PRIVATE")); await vi.advanceTimersByTimeAsync(2000); await assertion;
  expect(child.kill).toHaveBeenCalledTimes(1); expect(child.unref).toHaveBeenCalledTimes(1);
  expect(child.stdin.destroy).toHaveBeenCalledTimes(1); expect(child.stdout.destroy).toHaveBeenCalledTimes(1);
  expect(child.stderr.destroy).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  expect(child.listenerCount("close")).toBe(0);
});

it("native pre-script failures retain only fixed classification/byte counts and remain failed", async () => {
  vi.stubEnv("VERIDIA_E2E", "true");
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const line = "System.OutOfMemoryException 0x8007000e PRIVATE_NATIVE_MESSAGE\n";
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    reason: "NATIVE_PROBE_EXIT", exitCode: 1, nativeStartupFailure: "OUT_OF_MEMORY", stderrBytes: Buffer.byteLength(line),
  } });
  child.stderr.emit("data", Buffer.from(line)); child.emit("close", 1); await assertion;
  expect(JSON.stringify(getRecoveryDiagnostics()!.nativeProbes.at(-1))).not.toContain("PRIVATE_NATIVE_MESSAGE");
  expect(fixture.spawn).toHaveBeenCalledTimes(1); expect(child.kill).not.toHaveBeenCalled();
});
