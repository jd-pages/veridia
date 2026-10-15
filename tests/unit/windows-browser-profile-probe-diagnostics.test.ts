import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ spawn: vi.fn(), clock: null as number | null }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { spawn: fixture.spawn, spawnSync: actual.spawnSync };
});
vi.mock("node:perf_hooks", () => ({ performance: { now: () => fixture.clock ?? Date.now() } }));
import { captureWindowsBrowserProfileOwners, parseWindowsProfileProbeDiagnostic } from "@/lib/automation/windows-browser-process-owner";
import { getRecoveryDiagnostics } from "@/lib/automation/recovery-diagnostics";
import {
  WINDOWS_BROWSER_ARGV_ASSEMBLY_BASE64, WINDOWS_BROWSER_ARGV_ASSEMBLY_SHA256,
  WINDOWS_BROWSER_ARGV_SOURCE, WINDOWS_BROWSER_ARGV_SOURCE_SHA256,
} from "@/lib/automation/windows-browser-argv-asset";
import {
  WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_BASE64, WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_SHA256,
  WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE, WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE_SHA256,
} from "@/lib/automation/windows-browser-profile-census-asset";

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

it("loads pinned bytes for the unchanged OS argv parser without any runtime compilation or prewarming", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const script = Buffer.from(fixture.spawn.mock.calls[0][1].at(-1), "base64").toString("utf16le");
  const load = script.indexOf("Import-Module ([IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop");
  const assembly = script.indexOf("[Reflection.Assembly]::Load($parserBytes)", load);
  const digest = script.indexOf("$parserHash.ComputeHash($parserBytes)", load);
  expect(load).toBeGreaterThan(0);
  expect(digest).toBeGreaterThan(load);
  expect(assembly).toBeGreaterThan(digest);
  expect(script).toContain(`$parserDigest -cne '${WINDOWS_BROWSER_ARGV_ASSEMBLY_SHA256}'`);
  expect(script).toContain("throw 'NATIVE_ARGV_ASSET_INVALID'");
  expect(script).not.toContain("Add-Type");
  const submit = script.indexOf("$collection = $searcher.Get()");
  const enumerate = script.indexOf("$enumerator = $collection.GetEnumerator()");
  expect(submit).toBeGreaterThan(load);
  expect(assembly).toBeGreaterThan(submit);
  expect(enumerate).toBeGreaterThan(assembly);
  expect(script).toContain("if (!$script:parserReady)");
  expect(script).toContain("$script:parserReady = $true");
  expect(script).toContain("$options.ReturnImmediately = $true; $options.Rewindable = $false");
  expect(script).toContain("Set-ProbeStage 'UTILITY_MODULE_IMPORTED'");
  expect(script).toContain("Set-ProbeStage 'PROFILE_ARGUMENT_PARSED'");
  expect(script).not.toContain("Start-Sleep");
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 0);
  await expect(pending).resolves.toEqual([]);
});

it("immutable bundled argv bytes and source retain the exact native CommandLineToArgvW and LocalFree wrapper", () => {
  const bytes = Buffer.from(WINDOWS_BROWSER_ARGV_ASSEMBLY_BASE64, "base64");
  expect(bytes.length).toBe(3584);
  expect(bytes.subarray(0, 2).toString("ascii")).toBe("MZ");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(WINDOWS_BROWSER_ARGV_ASSEMBLY_SHA256);
  expect(createHash("sha256").update(WINDOWS_BROWSER_ARGV_SOURCE).digest("hex")).toBe(WINDOWS_BROWSER_ARGV_SOURCE_SHA256);
  expect(WINDOWS_BROWSER_ARGV_SOURCE_SHA256).toBe("e82a52ce6274e6ccd3fe9f4f0080c842a63c0d2b79224c43a29af236547bbce5");
  expect(WINDOWS_BROWSER_ARGV_SOURCE).toContain('[DllImport("shell32.dll", SetLastError=true)]');
  expect(WINDOWS_BROWSER_ARGV_SOURCE).toContain("IntPtr argv = CommandLineToArgvW(command, out count)");
  expect(WINDOWS_BROWSER_ARGV_SOURCE).toContain("finally { LocalFree(argv); }");
});

it("invalid native argv asset fails closed even with empty owner JSON and retained load-stage diagnostics", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    reason: "NATIVE_PROBE_EXIT", nativeStage: "PARSER_ASSEMBLY_LOAD", nativeFailureCode: "NATIVE_ARGV_ASSET_INVALID",
  } });
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_STAGE=PARSER_ASSEMBLY_LOAD:100\nVERIDIA_PROFILE_PROBE_FAILURE=PARSER_ASSEMBLY_LOAD:NATIVE_ARGV_ASSET_INVALID\n"));
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 1);
  await assertion;
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
    executablePath: executable, profilePath: profile, terminate: owners, argvAssembly: WINDOWS_BROWSER_ARGV_ASSEMBLY_BASE64,
    censusAssembly: WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_BASE64,
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

it("pinned read-only profile census reuses complete bounded SPI parsing and never grants kill authority", () => {
  const bytes = Buffer.from(WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_BASE64, "base64");
  expect(bytes.subarray(0, 2).toString("ascii")).toBe("MZ");
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_SHA256);
  expect(createHash("sha256").update(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).digest("hex")).toBe(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE_SHA256);
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("querySystem(5,buffer,SpiCapacity,out returned)");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("status!=0");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("SPI_RETURN_LENGTH_INVALID");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("SPI_THREAD_OR_NEXT_BOUNDS_INVALID");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("SPI_UNICODE_BOUNDS_INVALID");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("NATIVE_PROCESS_HANDLE_CLOSE_FAILED");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("GetProcessId(handle)!=(uint)(int)row[\"pid\"]");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("basic.parentPid.ToUInt64()!=(uint)(int)row[\"parentPid\"]");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("WaitForSingleObject(handle,0)!=258");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain('if(openError==87)absent=!ProcessStillExists((int)row["pid"],watch)');
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain('if(absent){Stage("SPI_VERIFIED_ABSENCE_SKIP",watch);continue;}');
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).not.toMatch(/TerminateProcess|\.Kill\(|ReadProcessMemory/u);
});

it("bounded managed exception unwrapping preserves only the existing fixed failure vocabulary", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const script = Buffer.from(fixture.spawn.mock.calls[0][1].at(-1), "base64").toString("utf16le");
  expect(script).toContain("$depth -lt 4 -and $probeFailure.InnerException");
  expect(script).toContain("if ($probeFailure.Message -eq $allowed) { $code=$allowed }");
  expect(script).not.toContain("[Console]::Error.WriteLine($probeFailure.Message)");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    reason: "NATIVE_PROBE_EXIT", nativeFailureCode: "LIVE_PROCESS_BIRTH_MISMATCH", closureProof: "CLOSED",
  } });
  child.stderr.emit("data", Buffer.from("VERIDIA_PROFILE_PROBE_FAILURE=SPI_HELD_PROCESS_DISPOSE:LIVE_PROCESS_BIRTH_MISMATCH\n"));
  child.emit("close", 1);
  await assertion;
});

it("uses full independent native snapshot birth on approved ABI and never falls back after native query rejection", async () => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const script = Buffer.from(fixture.spawn.mock.calls[0][1].at(-1), "base64").toString("utf16le");
  expect(script).toContain(`$censusDigest -cne '${WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_SHA256}'`);
  expect(script).toContain("$censusAssembly.GetExportedTypes().Length -ne 1");
  expect(script).toContain("$nativeCensus = [VeridiaBrowserProfileCensus]::IsApprovedAbi()");
  const nativePath = script.slice(script.indexOf("if ($nativeCensus)"), script.indexOf("Set-ProbeStage 'PROCESS_CENSUS_QUERY_RETURN'"));
  expect(nativePath).toContain("ReadProfileRows($expectedExecutable, $probeClock)");
  expect(nativePath).toContain("catch { if ([VeridiaBrowserProfileCensus]::LastStage)");
  expect(nativePath).toContain("; throw }");
  expect(nativePath).not.toMatch(/catch[^\n]*Get-OwnerProcessRows/u);
  expect(script).toContain("$birthStamp -ceq [string]$candidate.NativeSnapshotBirthStamp");
  expect(script).toContain("ProcessStillExists([int]$candidate.ProcessId, $probeClock)");
  expect(script).not.toMatch(/@['"]|['"]@/u);
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 0);
  await expect(pending).resolves.toEqual([]);
});

it("the actual pinned native SPI parser rejects malformed bounds and preserves observation-only rows", () => {
  if (process.platform !== "win32") return;
  vi.useRealTimers();
  const script = String.raw`
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd());
$assembly=[Reflection.Assembly]::Load($bytes);$type=$assembly.GetType('VeridiaBrowserProfileCensus');
if($assembly.GetExportedTypes().Length -ne 1){throw 'EXPORT_SHAPE'};
$method=$type.GetMethod('ParseSpi',[Reflection.BindingFlags]'NonPublic,Static');
$pointer=[Runtime.InteropServices.Marshal]::AllocHGlobal(2048);$rows=@();
try {
 foreach($kind in @('valid','length','next','threads','unicode','odd','pid','birth','working','duplicate')) {
  [Runtime.InteropServices.Marshal]::Copy([byte[]]::new(2048),0,$pointer,2048);
  $birth=[DateTime]::UtcNow.AddSeconds(-1).ToFileTimeUtc();$bound=[DateTime]::UtcNow.ToFileTimeUtc();
  [Runtime.InteropServices.Marshal]::WriteInt64($pointer,32,$birth);
  [Runtime.InteropServices.Marshal]::WriteInt16($pointer,56,2);[Runtime.InteropServices.Marshal]::WriteInt16($pointer,58,2);
  [Runtime.InteropServices.Marshal]::WriteIntPtr($pointer,64,[IntPtr]::Add($pointer,256));
  [Runtime.InteropServices.Marshal]::WriteIntPtr($pointer,80,[IntPtr]100);[Runtime.InteropServices.Marshal]::WriteInt16($pointer,256,120);
  [uint32]$returned=512;
  if($kind -eq 'length'){$returned=0};if($kind -eq 'next'){[Runtime.InteropServices.Marshal]::WriteInt32($pointer,0,4)};
  if($kind -eq 'threads'){[Runtime.InteropServices.Marshal]::WriteInt32($pointer,4,65536)};
  if($kind -eq 'unicode'){[Runtime.InteropServices.Marshal]::WriteIntPtr($pointer,64,[IntPtr]::Subtract($pointer,2))};
  if($kind -eq 'odd'){[Runtime.InteropServices.Marshal]::WriteInt16($pointer,56,1)};
  if($kind -eq 'pid'){[Runtime.InteropServices.Marshal]::WriteIntPtr($pointer,80,[IntPtr](-1))};
  if($kind -eq 'birth'){[Runtime.InteropServices.Marshal]::WriteInt64($pointer,32,0)};
  if($kind -eq 'working'){[Runtime.InteropServices.Marshal]::WriteInt64($pointer,144,[long]::MaxValue)};
  if($kind -eq 'duplicate'){
   [Runtime.InteropServices.Marshal]::WriteInt32($pointer,0,512);$returned=1024;$second=[IntPtr]::Add($pointer,512);
   [Runtime.InteropServices.Marshal]::WriteInt64($second,32,$birth);[Runtime.InteropServices.Marshal]::WriteInt16($second,56,2);
   [Runtime.InteropServices.Marshal]::WriteInt16($second,58,2);[Runtime.InteropServices.Marshal]::WriteIntPtr($second,64,[IntPtr]::Add($second,256));
   [Runtime.InteropServices.Marshal]::WriteIntPtr($second,80,[IntPtr]100);[Runtime.InteropServices.Marshal]::WriteInt16($second,256,120);
  };
  try {
   $parsed=$method.Invoke($null,[object[]]@($pointer,$returned,[uint64]$bound,[Diagnostics.Stopwatch]::StartNew(),[int]2000));
   $rows+=@{kind=$kind;status='ACCEPTED';count=$parsed.Count;ownershipAuthority=$parsed[0]['ownershipAuthority'];birth=$parsed[0]['nativeBirthStamp']};
  } catch {$rows+=@{kind=$kind;status='REJECTED';code=$_.Exception.GetBaseException().Message}};
 }
 $rows | ConvertTo-Json -Depth 4 -Compress;
} finally {[Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)}
`;
  const started = process.hrtime.bigint();
  const child = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", windowsHide: true, timeout: 2000, input: WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_BASE64 });
  console.info("NATIVE_CENSUS_CONTRACT_TIMING=" + JSON.stringify({ elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, exit: child.status }));
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  const rows = JSON.parse(child.stdout.trim()) as Array<{ kind: string; status: string; code?: string; ownershipAuthority?: boolean; count?: number }>;
  console.info("NATIVE_CENSUS_SYNTHETIC_BOUNDARIES=" + JSON.stringify(rows));
  expect(rows[0]).toMatchObject({ kind: "valid", status: "ACCEPTED", count: 1, ownershipAuthority: false });
  const expected = { length: "SPI_RETURN_LENGTH_INVALID", next: "SPI_THREAD_OR_NEXT_BOUNDS_INVALID", threads: "SPI_THREAD_OR_NEXT_BOUNDS_INVALID",
    unicode: "SPI_UNICODE_BOUNDS_INVALID", odd: "SPI_UNICODE_BOUNDS_INVALID", pid: "SPI_PID_INVALID_OR_DUPLICATE",
    birth: "SPI_BIRTH_OUTSIDE_CAPTURE_UTC_BOUND", working: "SPI_WORKING_SET_UNREPRESENTABLE", duplicate: "SPI_PID_INVALID_OR_DUPLICATE" };
  expect(rows.slice(1).map(row => [row.kind, row.status, row.code]), JSON.stringify(rows)).toEqual(Object.entries(expected).map(([kind, code]) => [kind, "REJECTED", code]));
});

it("only a signaled held handle with exact PID and full birth can exclude an exited census entry", () => {
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("bool closed=SameHeldIdentityExited(handle,pid,birth);Remaining(watch,budgetMs);return closed;");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain('failure.Message!="PROFILE_OWNERSHIP_UNAVAILABLE" && failure.Message!="LIVE_PROCESS_BIRTH_MISMATCH"');
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("Remaining(watch,2000);");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain('WaitForSameHeldExitWithinBudget(handle,(int)row["pid"],(string)row["nativeBirthStamp"],watch,2000)');
  if (process.platform !== "win32") return;
  vi.useRealTimers();
  const script = String.raw`
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json;$assembly=[Reflection.Assembly]::Load([Convert]::FromBase64String($request.assembly));
$method=$assembly.GetType('VeridiaBrowserProfileCensus').GetMethod('SameHeldIdentityExited',[Reflection.BindingFlags]'NonPublic,Static');
$bounded=$assembly.GetType('VeridiaBrowserProfileCensus').GetMethod('WaitForSameHeldExitWithinBudget',[Reflection.BindingFlags]'NonPublic,Static');
$gate=$assembly.GetType('VeridiaBrowserProfileCensus').GetMethod('MayAwaitReportedExit',[Reflection.BindingFlags]'NonPublic,Static');
$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$request.node;$info.Arguments='-e "process.stdin.resume()"';
$info.UseShellExecute=$false;$info.RedirectStandardInput=$true;$info.CreateNoWindow=$true;
$worker=[Diagnostics.Process]::Start($info);$handle=$worker.Handle;$workerPid=$worker.Id;
try {
 $birth=$worker.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
 $live=$method.Invoke($null,[object[]]@($handle,[int]$workerPid,[string]$birth));
 $boundedLive=$bounded.Invoke($null,[object[]]@($handle,[int]$workerPid,[string]$birth,[Diagnostics.Stopwatch]::StartNew(),[int]2000));
 $worker.StandardInput.Close();if(!$worker.WaitForExit(1000)){throw 'FIXTURE_EXIT_UNPROVEN'};
 $closed=$method.Invoke($null,[object[]]@($handle,[int]$workerPid,[string]$birth));
 $boundedClosed=$bounded.Invoke($null,[object[]]@($handle,[int]$workerPid,[string]$birth,[Diagnostics.Stopwatch]::StartNew(),[int]2000));
 $boundedWrongBirth=$bounded.Invoke($null,[object[]]@($handle,[int]$workerPid,[string]([decimal]$birth+1),[Diagnostics.Stopwatch]::StartNew(),[int]2000));
 $expired='NOT_REJECTED';try{$null=$bounded.Invoke($null,[object[]]@($handle,[int]$workerPid,[string]$birth,[Diagnostics.Stopwatch]::StartNew(),[int]0))}catch{$expired=$_.Exception.GetBaseException().Message};
 $gates=@($gate.Invoke($null,[object[]]@($true,[uint64]1,[int]0)),$gate.Invoke($null,[object[]]@($true,[uint64]0,[int]0)),$gate.Invoke($null,[object[]]@($true,[uint64]1,[int]259)),$gate.Invoke($null,[object[]]@($false,[uint64]1,[int]0)));
 $wrongPid=$method.Invoke($null,[object[]]@($handle,[int]($workerPid+1),[string]$birth));
 $wrongBirth=$method.Invoke($null,[object[]]@($handle,[int]$workerPid,[string]([decimal]$birth+1)));
 $invalid=$method.Invoke($null,[object[]]@([IntPtr]::Zero,[int]$workerPid,[string]$birth));
 @{live=$live;closed=$closed;wrongPid=$wrongPid;wrongBirth=$wrongBirth;invalid=$invalid;creatorCloseProven=$worker.HasExited;boundedLive=$boundedLive;boundedClosed=$boundedClosed;boundedWrongBirth=$boundedWrongBirth;expired=$expired;gates=$gates}|ConvertTo-Json -Compress;
} finally {if(!$worker.HasExited){$worker.Kill();if(!$worker.WaitForExit(1000)){throw 'FIXTURE_CLEANUP_UNPROVEN'}};$worker.Dispose()}
`;
  const started = process.hrtime.bigint();
  const native = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    encoding: "utf8", windowsHide: true, timeout: 2000,
    input: JSON.stringify({ assembly: WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_BASE64, node: process.execPath }),
  });
  console.info("NATIVE_HELD_EXIT_CONTRACT_TIMING=" + JSON.stringify({ elapsedMs: Number(process.hrtime.bigint() - started) / 1e6, exit: native.status }));
  expect(native.error).toBeUndefined(); expect(native.status, native.stderr).toBe(0);
  expect(JSON.parse(native.stdout.trim())).toEqual({ live: false, closed: true, wrongPid: false, wrongBirth: false, invalid: false, creatorCloseProven: true,
    boundedLive: false, boundedClosed: true, boundedWrongBirth: false, expired: "NATIVE_QUERY_DEADLINE", gates: [true, false, false, false] });
});

it("census open diagnostics retain only numeric snapshot identity and never grant ownership", () => {
  expect(parseWindowsProfileProbeDiagnostic("VERIDIA_PROFILE_PROBE_CENSUS_OPEN=321:134000000000000001:87:TRUE\n")).toEqual({
    censusOpenFailure: { pid: 321, snapshotBirthStamp: "134000000000000001", nativeErrorCode: 87, absentInCompleteSnapshot: true },
  });
  expect(parseWindowsProfileProbeDiagnostic("VERIDIA_PROFILE_PROBE_CENSUS_OPEN=321:134000000000000001:5:FALSE\n")).toEqual({
    censusOpenFailure: { pid: 321, snapshotBirthStamp: "134000000000000001", nativeErrorCode: 5, absentInCompleteSnapshot: false },
  });
  for (const invalid of ["0:1:87:TRUE", "321:secret:87:TRUE", "321:134000000000000001:-1:TRUE", "321:134000000000000001:87:UNKNOWN", "321:134000000000000001:87:TRUE private token"]) {
    expect(parseWindowsProfileProbeDiagnostic(`VERIDIA_PROFILE_PROBE_CENSUS_OPEN=${invalid}\n`)).toEqual({});
  }
});

it("image query refusal retains only numeric held identity evidence and cannot claim exit or owner admission", async () => {
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("int imageError=imageRead?0:Marshal.GetLastWin32Error()");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).not.toContain("Console.Error.WriteLine(path)");
  const frame = "VERIDIA_PROFILE_PROBE_CENSUS_IMAGE=321:134000000000000001:31:FALSE:32768:TRUE:258\n";
  expect(parseWindowsProfileProbeDiagnostic(frame)).toEqual({ censusImageFailure: {
    pid: 321, snapshotBirthStamp: "134000000000000001", nativeErrorCode: 31, imageRead: false,
    returnedLength: 32768, sameHeldIdentity: true, waitResult: 258,
  } });
  for (const invalid of [frame.replace(":TRUE:258", ":UNKNOWN:258"), frame.replace("321:", "0:"), frame.replace(":31:", ":-1:"), frame.trimEnd() + " private path\n"]) {
    expect(parseWindowsProfileProbeDiagnostic(invalid)).toEqual({});
  }
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_EXIT", nativeFailureCode: "PROFILE_OWNERSHIP_UNAVAILABLE",
    censusImageFailure: { nativeErrorCode: 31, sameHeldIdentity: true, waitResult: 258 } } });
  child.stderr.emit("data", Buffer.from(frame + "VERIDIA_PROFILE_PROBE_FAILURE=SPI_IMAGE_READ:PROFILE_OWNERSHIP_UNAVAILABLE\n"));
  child.stdout.emit("data", Buffer.from("[]"));child.emit("close", 1);await assertion;
});

it("image exit-state receipts are bounded numeric observations and never replace the exit fence", async () => {
  const frame = "VERIDIA_PROFILE_PROBE_CENSUS_IMAGE_STATE=321:134000000000000001:259:0:TRUE\n";
  expect(parseWindowsProfileProbeDiagnostic(frame)).toEqual({ censusImageExitEvidence: {
    pid: 321, snapshotBirthStamp: "134000000000000001", basicExitStatus: 259, exitFileTime: "0", sameHeldIdentity: true,
  } });
  expect(parseWindowsProfileProbeDiagnostic(frame.replace(":259:0:", ":3221225786:134000000000000002:"))).toEqual({ censusImageExitEvidence: {
    pid: 321, snapshotBirthStamp: "134000000000000001", basicExitStatus: 3221225786, exitFileTime: "134000000000000002", sameHeldIdentity: true,
  } });
  for (const invalid of [frame.replace("321:", "0:"), frame.replace(":259:", ":4294967296:"), frame.replace(":0:TRUE", ":18446744073709551616:TRUE"),
    frame.replace(":TRUE", ":UNKNOWN"), frame.trimEnd() + " private command line\n"]) {
    expect(parseWindowsProfileProbeDiagnostic(invalid)).toEqual({});
  }
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("unchecked((uint)basic.exitStatus),diagnosticExit.Value");
  expect(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE).toContain("bool closed=SameHeldIdentityExited(handle,pid,birth);Remaining(watch,budgetMs);return closed;");
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: {
    nativeFailureCode: "PROFILE_OWNERSHIP_UNAVAILABLE", censusImageExitEvidence: { basicExitStatus: 259, exitFileTime: "0" },
  } });
  child.stderr.emit("data", Buffer.from(frame + "VERIDIA_PROFILE_PROBE_FAILURE=SPI_IMAGE_READ:PROFILE_OWNERSHIP_UNAVAILABLE\n"));
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 1);
  await assertion;
  expect(fixture.spawn).toHaveBeenCalledTimes(1);
});

it("bounded exit-join receipts cannot admit unknown/live processes or replace owner JSON validation", async () => {
  const start = "VERIDIA_PROFILE_PROBE_EXIT_JOIN=321:134000000000000001:1700:START:200\n";
  const end = "VERIDIA_PROFILE_PROBE_EXIT_JOIN=321:134000000000000001:1700:0:220\n";
  expect(parseWindowsProfileProbeDiagnostic(start)).toEqual({ nativeStage: "HELD_EXIT_JOIN_START", nativeStageElapsedMs: 200,
    censusExitJoin: { pid: 321, snapshotBirthStamp: "134000000000000001", waitMs: 1700 } });
  expect(parseWindowsProfileProbeDiagnostic(end)).toEqual({ nativeStage: "HELD_EXIT_JOIN_RETURN", nativeStageElapsedMs: 220,
    censusExitJoin: { pid: 321, snapshotBirthStamp: "134000000000000001", waitMs: 1700, waitResult: 0 } });
  for (const invalid of [end.replace("321:", "0:"), end.replace(":1700:", ":2001:"), end.replace(":0:220", ":4294967296:220"), end.trimEnd() + " private path\n"]) {
    expect(parseWindowsProfileProbeDiagnostic(invalid)).toEqual({});
  }
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\chrome.exe", "E:\\fixture\\isolated-profile");
  const assertion = expect(pending).rejects.toMatchObject({ diagnostic: { reason: "NATIVE_PROBE_RESPONSE_INVALID", censusExitJoin: { waitResult: 0 } } });
  child.stderr.emit("data", Buffer.from(start + end)); child.stdout.emit("data", Buffer.from("{invalid-owner-json")); child.emit("close", 0);
  await assertion;
});

it.each(["success", "operation-failure", "cleanup-failure"])("real native probe finalization tail exits only after successful operation and cleanup: %s", async (scenario) => {
  const child = childFixture();
  const pending = captureWindowsBrowserProfileOwners("E:\\fixture\\no-such-veridia-profile-probe.exe", "E:\\fixture\\isolated-profile");
  let script = Buffer.from(fixture.spawn.mock.calls[0][1].at(-1), "base64").toString("utf16le");
  child.stdout.emit("data", Buffer.from("[]")); child.emit("close", 0); await expect(pending).resolves.toEqual([]);
  expect(script.lastIndexOf("exit 0")).toBeGreaterThan(script.indexOf("$disposed=$true"));
  expect(script).not.toContain("[Environment]::Exit");
  expect(script).toContain("if (!$written -or !$disposed) { exit 1 }");
  expect(parseWindowsProfileProbeDiagnostic("VERIDIA_PROFILE_PROBE_EXIT_READY=215\n")).toEqual({ nativeStage: "SUCCESS_EXIT_READY", nativeStageElapsedMs: 215 });
  for (const invalid of ["-1", "60001", "215 private text"]) expect(parseWindowsProfileProbeDiagnostic(`VERIDIA_PROFILE_PROBE_EXIT_READY=${invalid}\n`)).toEqual({});
  if (process.platform !== "win32") return;
  // The mocked parent promise is already closed. Native child timing must not
  // inherit Vitest's fake Date/performance/hrtime clocks.
  vi.useRealTimers();
  // Test this actual finalization tail, not a second complete process census.
  // Full ownership/census behavior remains covered by the existing native tests and E2E.
  const tryStart = script.indexOf("try {", script.indexOf("$phase='UTILITY_MODULE_IMPORT'")) + "try {".length;
  const tailStart = script.indexOf("Set-ProbeStage 'RESULT_EMIT';");
  expect(tryStart).toBeGreaterThan(0); expect(tailStart).toBeGreaterThan(tryStart);
  script = script.slice(0, tryStart) + (scenario === "operation-failure" ? "throw 'SYNTHETIC_OPERATION_FAILURE';" : "") + script.slice(tailStart);
  if (scenario === "cleanup-failure") script = script.replace("} finally { foreach ($process in $handles)", "} finally { throw 'SYNTHETIC_CLEANUP_FAILURE'; foreach ($process in $handles)");
  const startedAt = new Date(vi.getRealSystemTime()).toISOString();
  const started = process.hrtime.bigint();
  const native = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
    input: "", encoding: "utf8", windowsHide: true, timeout: 2000,
  });
  const observation = { scenario, startedAt, capturedAt: new Date(vi.getRealSystemTime()).toISOString(), creatorPid: process.pid, pid: native.pid,
    nativeBirth: "NOT_CAPTURED", ownershipAuthority: false, elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
    exit: native.status, signal: native.signal, errorCode: native.error && (native.error as NodeJS.ErrnoException).code,
    stdoutBytes: Buffer.byteLength(native.stdout || ""),
    stages: (native.stderr || "").split(/\r?\n/u).map(line => parseWindowsProfileProbeDiagnostic(line + "\n")).filter(value => value.nativeStage),
  };
  const receiptDirectory = path.resolve(".playwright/native-finalization-unit"); mkdirSync(receiptDirectory, { recursive: true });
  const receipt = path.join(receiptDirectory, `${randomUUID()}.json`); writeFileSync(receipt, JSON.stringify(observation, null, 2), { flag: "wx" });
  console.info("NATIVE_EXPLICIT_EXIT_CONTRACT_TIMING=" + JSON.stringify({ receipt, ...observation }));
  expect(native.error).toBeUndefined();
  expect(native.status, native.stderr).toBe(scenario === "success" ? 0 : 1);
  if (scenario === "success") {
    expect(JSON.parse(native.stdout.trim())).toEqual([]);
    expect(native.stderr).toMatch(/VERIDIA_PROFILE_PROBE_EXIT_READY=[0-9]+/u);
  } else expect(native.stderr).not.toContain("VERIDIA_PROFILE_PROBE_EXIT_READY=");
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
