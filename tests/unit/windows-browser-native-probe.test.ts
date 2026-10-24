import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { isNativeWindowsProfileProbeSupported, prepareNativeWindowsProfileProbe } from "@/lib/automation/windows-browser-native-probe";
import {
  NATIVE_PROFILE_PROBE_BINARY_BASE64, NATIVE_PROFILE_PROBE_BINARY_BYTES, NATIVE_PROFILE_PROBE_BINARY_SHA256,
  NATIVE_PROFILE_PROBE_HOST_SOURCE_SHA256, NATIVE_PROFILE_PROBE_ARGV_SOURCE_SHA256, NATIVE_PROFILE_PROBE_CENSUS_SOURCE_SHA256,
} from "@/lib/automation/windows-browser-native-probe-asset";
import { WINDOWS_BROWSER_ARGV_SOURCE_SHA256 } from "@/lib/automation/windows-browser-argv-asset";
import { WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE_SHA256 } from "@/lib/automation/windows-browser-profile-census-asset";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
it("native console code pins the exact audited census, OS argv parser and guarded host source", () => {
  const bytes = Buffer.from(NATIVE_PROFILE_PROBE_BINARY_BASE64, "base64");
  expect(bytes.length).toBe(NATIVE_PROFILE_PROBE_BINARY_BYTES); expect(bytes.length).toBeLessThan(100_000);
  expect(bytes.subarray(0, 2).toString("ascii")).toBe("MZ"); expect(hash(bytes)).toBe(NATIVE_PROFILE_PROBE_BINARY_SHA256);
  expect(NATIVE_PROFILE_PROBE_ARGV_SOURCE_SHA256).toBe(WINDOWS_BROWSER_ARGV_SOURCE_SHA256);
  expect(NATIVE_PROFILE_PROBE_CENSUS_SOURCE_SHA256).toBe(WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE_SHA256);
  const source = readFileSync(path.resolve("scripts/runtime/windows-browser-profile-probe.cs"), "utf8").replace(/\r\n/gu, "\n");
  expect(hash(source)).toBe(NATIVE_PROFILE_PROBE_HOST_SOURCE_SHA256);
  expect(source).toContain("VeridiaBrowserProfileCensus.ReadProfileRows(executable,Clock)");
  expect(source).toContain("VeridiaBrowserArgv.MatchProfile(command,profile)");
  expect(source.indexOf("if(matches!=1)throw")).toBeLessThan(source.indexOf("process.Kill()"));
  expect(source).toContain("const uint QueryAndWait=0x101000, TerminateRight=0x1;");
  expect(source).toContain("OpenProcess(access,false,(uint)pid)");
  expect(source).toContain("access=QueryAndWait|(terminating?TerminateRight:0)");
  expect(source).toContain("string birth=process.Birth()");
  expect(source).not.toContain("Process.GetProcessById(pid)");
  expect(source).toContain("if(!written||!disposed||result!=0)return 1;");
  expect(source.indexOf("finally{disposed=true;")).toBeLessThan(source.lastIndexOf("return 0;"));
  expect(source).not.toMatch(/\b(?:Environment\.Exit|ExitProcess)\s*\(/u);
  expect(source).not.toMatch(/\b(?:Thread\.Sleep|Task\.Delay|SetInformationJobObject|AdjustTokenPrivileges)\s*\(/u);
});

it.each([
  ["win32", "x64", "10.0.26100", true], ["win32", "x64", "10.0.26200", true],
  ["win32", "x64", "10.0.19045", false], ["win32", "arm64", "10.0.26100", false],
  ["linux", "x64", "10.0.26100", false], ["win32", "x64", "10.0.26100.1", false],
  ["win32", "x64", "UNKNOWN", false],
])("native console eligibility is exact and never inferred: %s %s %s", (platform, architecture, release, supported) => {
  expect(isNativeWindowsProfileProbeSupported(platform as string, architecture as string, release as string)).toBe(supported);
});

it("actual cold native console completes a fresh empty census with real exit and unchanged2000ms budget", () => {
  if (!isNativeWindowsProfileProbeSupported()) { expect(() => prepareNativeWindowsProfileProbe()).toThrow(); return; }
  const file = prepareNativeWindowsProfileProbe(), started = process.hrtime.bigint();
  const env: NodeJS.ProcessEnv = { ...process.env, VERIDIA_E2E: "true" }; delete env.DATABASE_URL; delete env.E2E_DATABASE_URL;
  const native = spawnSync(file, [], { windowsHide: true, encoding: "utf8", timeout: 2000, env,
    input: JSON.stringify({ executablePath: path.join(path.dirname(file), "nonexistent-profile-fixture.exe"), profilePath: path.join(path.dirname(file), "isolated-profile") }) });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const directory = path.resolve(".playwright/native-console-unit"); mkdirSync(directory, { recursive: true });
  const receipt = path.join(directory, `${randomUUID()}.json`); writeFileSync(receipt, JSON.stringify({ pid: native.pid, creatorPid: process.pid, elapsedMs,
    exit: native.status, signal: native.signal, errorCode: native.error && (native.error as NodeJS.ErrnoException).code,
    assetSha256: NATIVE_PROFILE_PROBE_BINARY_SHA256, stdoutBytes: Buffer.byteLength(native.stdout || ""), budgetMs: 2000,
    scope: "ACTUAL_NATIVE_EMPTY_CENSUS_NO_DB_NO_TERMINATION", stdout: native.stdout, stderr: native.stderr }, null, 2), { flag: "wx" });
  console.info("NATIVE_CONSOLE_COLD_CENSUS=" + JSON.stringify({ receipt, pid: native.pid, elapsedMs, exit: native.status }));
  expect(native.error).toBeUndefined(); expect(native.status, native.stderr).toBe(0); expect(elapsedMs).toBeLessThan(2000);
  expect(JSON.parse(native.stdout)).toEqual([]);
  expect(native.stderr).toContain(`VERIDIA_PROFILE_PROBE_SELF=${native.pid}:`);
  expect(native.stderr).toMatch(/VERIDIA_PROFILE_PROBE_EXIT_READY=[0-9]+/u);
  expect(prepareNativeWindowsProfileProbe()).toBe(file); // immutable code cache, not a result cache
});

it("native console rejects extra request fields before emitting any owner JSON", () => {
  if (!isNativeWindowsProfileProbeSupported()) { expect(() => prepareNativeWindowsProfileProbe()).toThrow(); return; }
  const file = prepareNativeWindowsProfileProbe();
  const native = spawnSync(file, [], { windowsHide: true, encoding: "utf8", timeout: 2000,
    input: JSON.stringify({ executablePath: path.join(path.dirname(file), "nonexistent.exe"), profilePath: path.join(path.dirname(file), "isolated-profile"), unknownAuthority: true }) });
  expect(native.error).toBeUndefined(); expect(native.status).toBe(1); expect(native.stdout).toBe("");
  expect(native.stderr).toContain("NATIVE_ARGV_ASSET_INVALID");
});

it("termination error5 requires a signalled held-handle exit within remaining budget; live/unknown/deadline stay rejected", () => {
  const host = path.resolve("scripts/runtime/windows-browser-profile-probe.cs");
  const source = readFileSync(host, "utf8");
  expect(source).toContain("ConfirmTerminationExit(native,()=>BudgetMs-(int)Clock.ElapsedMilliseconds,process.WaitForExit)");
  expect(source).toContain("return WaitForSingleObject(Handle,milliseconds)");
  if (process.platform !== "win32") return;
  const directory = path.resolve(".playwright/native-console-unit", `termination-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const harness = path.join(directory, "contract.cs"), executable = path.join(directory, "contract.exe");
  writeFileSync(harness, `using System;using System.Diagnostics;
class VeridiaBrowserProfileCensus {
 public static string LastStage;public static bool IsApprovedAbi(){throw new Exception("NOT_IN_TEST_SCOPE");}
 public static object[] ReadProfileRows(string path,Stopwatch clock){throw new Exception("NOT_IN_TEST_SCOPE");}
 public static bool ProcessStillExists(int pid,Stopwatch clock){throw new Exception("NOT_IN_TEST_SCOPE");}
}
class VeridiaBrowserArgv {public static bool[] MatchProfile(string command,string path){throw new Exception("NOT_IN_TEST_SCOPE");}}
class TerminationContract {
 public static int Main(){int calls=0;Func<uint,uint> exited=remaining=>{if(remaining!=1980)throw new Exception("BUDGET_CHANGED");calls++;return 0;};
  if(!VeridiaProfileProbeHost.ConfirmTerminationExit(5,()=>1980,exited)||calls!=1)return 1;
  if(VeridiaProfileProbeHost.ConfirmTerminationExit(5,()=>1980,remaining=>258))return 2;
  if(VeridiaProfileProbeHost.ConfirmTerminationExit(5,()=>1980,remaining=>UInt32.MaxValue))return 3;
  if(VeridiaProfileProbeHost.ConfirmTerminationExit(6,()=>{throw new Exception("OTHER_ERROR_WAITED");},exited))return 4;
  if(VeridiaProfileProbeHost.ConfirmTerminationExit(5,()=>0,exited)||calls!=1)return 5;
  if(VeridiaProfileProbeHost.ConfirmTerminationExit(5,()=>-1,exited)||calls!=1)return 6;
  try{VeridiaProfileProbeHost.ConfirmTerminationExit(5,()=>1980,remaining=>{throw new Exception("WAIT_FAILED");});return 7;}catch(Exception e){if(e.Message!="WAIT_FAILED")throw;}
  Console.WriteLine("EXIT_CONFIRMED_LIVE_UNKNOWN_OTHER_ERROR_DEADLINE_REJECTED_NO_RETRY");return 0;
 }
}`, { flag: "wx" });
  const compile = spawnSync("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", [
    "/nologo", "/target:exe", "/platform:x64", "/main:TerminationContract", "/reference:System.Web.Extensions.dll",
    `/out:${executable}`, host, harness,
  ], { encoding: "utf8", windowsHide: true, timeout: 2000 });
  expect(compile.error).toBeUndefined();expect(compile.status, compile.stdout + compile.stderr).toBe(0);
  const contract = spawnSync(executable, [], { encoding: "utf8", windowsHide: true, timeout: 1000 });
  expect(contract.error).toBeUndefined();expect(contract.status, contract.stderr).toBe(0);
  expect(contract.stdout).toContain("EXIT_CONFIRMED_LIVE_UNKNOWN_OTHER_ERROR_DEADLINE_REJECTED_NO_RETRY");
});

it("materialized native code tampering fails closed without automatic replacement", () => {
  if (!isNativeWindowsProfileProbeSupported()) { expect(() => prepareNativeWindowsProfileProbe()).toThrow(); return; }
  const file = prepareNativeWindowsProfileProbe(), original = readFileSync(file);
  try { writeFileSync(file, "CORRUPTED_OWNED_UNIT_FIXTURE"); expect(() => prepareNativeWindowsProfileProbe()).toThrow("NATIVE_PROFILE_PROBE_ASSET_INVALID");
    expect(readFileSync(file, "utf8")).toBe("CORRUPTED_OWNED_UNIT_FIXTURE");
  } finally { writeFileSync(file, original); }
  expect(hash(readFileSync(prepareNativeWindowsProfileProbe()))).toBe(NATIVE_PROFILE_PROBE_BINARY_SHA256);
});

it("a hard-linked native code object cannot acquire execution eligibility", () => {
  if (!isNativeWindowsProfileProbeSupported()) { expect(() => prepareNativeWindowsProfileProbe()).toThrow(); return; }
  const file = prepareNativeWindowsProfileProbe(), link = path.join(path.dirname(file), "owned-unit-link.exe");
  try { linkSync(file, link); expect(lstatSync(file).nlink).toBe(2); expect(() => prepareNativeWindowsProfileProbe()).toThrow("NATIVE_PROFILE_PROBE_ASSET_INVALID"); }
  finally { unlinkSync(link); }
  expect(prepareNativeWindowsProfileProbe()).toBe(file);
});

it("unrecognized adjacent code configuration cannot participate in native code loading", () => {
  if (!isNativeWindowsProfileProbeSupported()) { expect(() => prepareNativeWindowsProfileProbe()).toThrow(); return; }
  const file = prepareNativeWindowsProfileProbe(), config = `${file}.config`;
  try { writeFileSync(config, "<configuration />", { flag: "wx" });
    expect(() => prepareNativeWindowsProfileProbe()).toThrow("NATIVE_PROFILE_PROBE_ASSET_INVALID");
    expect(readFileSync(config, "utf8")).toBe("<configuration />");
  } finally { unlinkSync(config); }
  expect(prepareNativeWindowsProfileProbe()).toBe(file);
});
