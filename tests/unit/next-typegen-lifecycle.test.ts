import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formalNextEnvironment, runOwnedNodeTypegenCommand, skippedNextTypegenReceipt, type TypegenReceipt } from "../../scripts/testing/next-typegen-lifecycle.mjs";
import { formalNextPrepareExitCode, prepareFormalNext } from "../../scripts/testing/prepare-formal-next.mjs";

const owned: string[] = [];
const fixture = path.resolve("tests/fixtures/next-typegen-lifecycle.cjs");
function ownDirectory() {
  const directory = path.resolve(".playwright/stability141/diagnostics", `typegen-fixture-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true });
  owned.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of owned.splice(0)) {
    if (path.dirname(directory) !== path.resolve(".playwright/stability141/diagnostics") ||
      !path.basename(directory).startsWith("typegen-fixture-")) throw new Error("FIXTURE_CLEANUP_BOUNDARY");
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("formal Next typegen receipt and preparation", () => {
  it("clears only the existing test-dist overrides without mutating parent environment", () => {
    const original = { VERIDIA_NEXT_DIST_DIR: "test-dist", VERIDIA_NEXT_TSCONFIG_PATH: "test-config",
      E2E_NEXT_DIST_DIR: "test-other", DATABASE_URL: "file:owned-fixture.db", NODE_OPTIONS: "--trace-warnings", NODE_ENV: "test" as const };
    expect(formalNextEnvironment(original)).toEqual({ DATABASE_URL: "file:owned-fixture.db", NODE_OPTIONS: "--trace-warnings", NODE_ENV: "test" });
    expect(original.VERIDIA_NEXT_DIST_DIR).toBe("test-dist");
  });

  it("an explicit skip does not fabricate native capture or process zero", () => {
    expect(skippedNextTypegenReceipt()).toMatchObject({ execution: "SKIPPED_NOT_NEEDED", executed: false,
      status: "PASSED", nativeRoot: null, exitCode: null,
      processQuiescence: { measurement: "NOT_RUN", capturedIdentityCount: null, remainingCapturedIdentityCount: null } });
    expect(formalNextPrepareExitCode({ exitCode: 7 })).toBe(7);
    for (const error of [null, undefined, { exitCode: null }, { exitCode: 0 }, { exitCode: "7" }]) {
      expect(formalNextPrepareExitCode(error)).toBe(1);
    }
  });

  it("runs the exact-hash patch before cleanup/Next even when typegen is unnecessary, and persists unique + latest", async () => {
    const root = ownDirectory(), order: string[] = [];
    const patcher = vi.fn(async () => { order.push("patch"); return { state: "ALREADY_PATCHED", outputSha256: "fixture-patch" }; });
    const runTypegen = vi.fn();
    const receipt = await prepareFormalNext({ root, patcher,
      cleanup: () => { order.push("cleanup"); return []; },
      needsGeneration: () => { order.push("needed"); return false; }, runTypegen,
      fingerprint: () => "fixture-fingerprint", head: () => "a".repeat(40), log: () => {} });
    expect(order).toEqual(["patch", "cleanup", "needed"]);
    expect(runTypegen).not.toHaveBeenCalled();
    expect(receipt).toMatchObject({ status: "PASSED", execution: "SKIPPED_NOT_NEEDED",
      head: "a".repeat(40), sourceFingerprint: "fixture-fingerprint", sourceFingerprintAfter: "fixture-fingerprint",
      nextTracePatch: { outputSha256: "fixture-patch" } });
    expect(JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8"))).toEqual(receipt);
    expect(JSON.parse(fs.readFileSync(path.join(root, ".playwright/typegen-lifecycle/latest-receipt.json"), "utf8"))).toEqual(receipt);
  });

  it("patch failure blocks cleanup and Next and replaces latest with a failed invocation, not an old PASS", async () => {
    const root = ownDirectory(), cleanup = vi.fn(), runTypegen = vi.fn();
    await expect(prepareFormalNext({ root, patcher: async () => { throw new Error("FIXTURE_HASH_MISMATCH"); },
      cleanup, needsGeneration: () => true, runTypegen, fingerprint: () => "fixture", head: () => "a".repeat(40), log: () => {} }))
      .rejects.toThrow("FIXTURE_HASH_MISMATCH");
    expect(cleanup).not.toHaveBeenCalled();
    expect(runTypegen).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(root, ".playwright/typegen-lifecycle/latest-receipt.json"), "utf8")))
      .toMatchObject({ status: "FAILED", execution: "NOT_RUN", failure: "FIXTURE_HASH_MISMATCH" });
  });

  it("never replaces the initial progress snapshot when publishing a skipped terminal receipt", async () => {
    const root = ownDirectory();
    const result = skippedNextTypegenReceipt();
    const inspectProgress = () => {
      const parent = path.join(root, ".playwright/typegen-lifecycle");
      const id = fs.readdirSync(parent).find(name => fs.lstatSync(path.join(parent, name)).isDirectory())!;
      const directory = path.join(parent, id);
      expect(fs.existsSync(path.join(directory, "receipt.json"))).toBe(false);
      return directory;
    };
    let firstCheckpoint = "", firstBytes = "";
    const receipt = await prepareFormalNext({ root,
      patcher: async () => {
        const directory = inspectProgress();
        firstCheckpoint = path.join(directory, fs.readdirSync(directory).find(name => name.startsWith("checkpoint-"))!);
        firstBytes = fs.readFileSync(firstCheckpoint, "utf8");
        return { state: "ALREADY_PATCHED" };
      }, cleanup: () => [], needsGeneration: () => false,
      runTypegen: async () => result, fingerprint: () => "fixture", head: () => "a".repeat(40), log: () => {} });
    expect(fs.readFileSync(firstCheckpoint, "utf8")).toBe(firstBytes);
    expect(JSON.parse(firstBytes).status).toBe("RUNNING");
    expect(JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8"))).toEqual(receipt);
    expect(fs.readdirSync(path.dirname(receipt.receiptPath)).filter(name => name.endsWith(".tmp"))).toEqual([]);
  });

  it("a preexisting terminal receipt is never overwritten even for the same invocation", async () => {
    const root = ownDirectory();
    let preexisting = "";
    const error = await prepareFormalNext({ root, patcher: async () => {
      const parent = path.join(root, ".playwright/typegen-lifecycle");
      const id = fs.readdirSync(parent).find(name => fs.lstatSync(path.join(parent, name)).isDirectory())!;
      preexisting = path.join(parent, id, "receipt.json");
      fs.writeFileSync(preexisting, "owned-preexisting-evidence", { flag: "wx" });
      return { state: "ALREADY_PATCHED" };
    }, cleanup: () => [], needsGeneration: () => false, fingerprint: () => "fixture", head: () => "a".repeat(40), log: () => {} }).catch(value => value);
    expect(error.message).toBe("FORMAL_NEXT_UNIQUE_RECEIPT_ALREADY_EXISTS");
    expect(error.prepareReceipt.status).toBe("FAILED");
    expect(fs.readFileSync(preexisting, "utf8")).toBe("owned-preexisting-evidence");
    expect(fs.existsSync(path.join(root, ".playwright/typegen-lifecycle/latest-receipt.json"))).toBe(false);
  });

  it("requires a real executed native-before-release quiescence receipt and still rechecks generated routes", async () => {
    const root = ownDirectory();
    const result: TypegenReceipt = { execution: "EXECUTED", executed: true, status: "PASSED", exitCode: 0,
      nativeRoot: { pid: 123, parentPid: process.pid, nativeStartFileTime: "134352894793735696",
        createdAt: "2026-10-01T00:00:00.000Z", capturedAt: "2026-10-01T00:00:00.100Z" }, nativeCapturedBeforeCliRelease: true,
      processQuiescence: { measurement: "AVAILABLE", status: "PASSED", scope: "SYNTHETIC_UNIT_TEST",
        capturedIdentityCount: 1, remainingCapturedIdentityCount: 0 } };
    const needs = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const run = vi.fn(async (options: Parameters<typeof runOwnedNodeTypegenCommand>[0]) => {
      options.onPhase?.({ kind: "BOOTSTRAP_READY" });
      options.onPhase?.({ kind: "NATIVE_ROOT_CAPTURED" });
      const parent = path.join(root, ".playwright/typegen-lifecycle");
      const id = fs.readdirSync(parent).find(name => fs.lstatSync(path.join(parent, name)).isDirectory() &&
        !fs.existsSync(path.join(parent, name, "receipt.json")))!;
      const directory = path.join(parent, id);
      expect(fs.existsSync(path.join(directory, "receipt.json"))).toBe(false);
      expect(fs.readdirSync(directory).filter(name => name.startsWith("checkpoint-")).length).toBe(3);
      return result;
    });
    const receipt = await prepareFormalNext({ root, patcher: async () => ({ state: "ALREADY_PATCHED" }), cleanup: () => [],
      needsGeneration: needs, runTypegen: run, fingerprint: () => "fixture", head: () => "a".repeat(40), log: () => {} });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ entry: path.join(root, "node_modules/next/dist/bin/next"), args: ["typegen"] }));
    expect(needs).toHaveBeenCalledTimes(2);
    expect(receipt.execution).toBe("EXECUTED");
    result.nativeCapturedBeforeCliRelease = false;
    await expect(prepareFormalNext({ root, patcher: async () => ({ state: "ALREADY_PATCHED" }), cleanup: () => [],
      needsGeneration: () => true, runTypegen: run, fingerprint: () => "fixture", head: () => "a".repeat(40), log: () => {} }))
      .rejects.toThrow("FORMAL_NEXT_TYPEGEN_RECEIPT_NOT_PASSED");
  });

  it("does not let a remaining type defect or source fingerprint mutation claim preparation PASS", async () => {
    const root = ownDirectory(), fingerprints = vi.fn().mockReturnValueOnce("old").mockReturnValueOnce("new");
    await expect(prepareFormalNext({ root, patcher: async () => ({ state: "ALREADY_PATCHED" }), cleanup: () => [],
      needsGeneration: () => false, fingerprint: fingerprints, head: () => "a".repeat(40), log: () => {} }))
      .rejects.toThrow("FORMAL_NEXT_PREPARE_SOURCE_CHANGED");
  });

  it("receipt persistence failure is attached without replacing the original patch failure", async () => {
    const root = ownDirectory();
    const original = Object.assign(new Error("FIXTURE_ORIGINAL_HASH_FAILURE"), { code: "EACCES", exitCode: 7 });
    const error = await prepareFormalNext({ root, patcher: async () => {
      const receiptRoot = path.join(root, ".playwright/typegen-lifecycle");
      const id = fs.readdirSync(receiptRoot).find(name => fs.statSync(path.join(receiptRoot, name)).isDirectory())!;
      fs.writeFileSync(path.join(receiptRoot, id, "receipt.json"), "invalid-owned-fixture-json");
      throw original;
    }, cleanup: () => [], needsGeneration: () => false, fingerprint: () => "fixture", head: () => "a".repeat(40), log: () => {} })
      .catch(value => value);
    expect(error).toBe(original);
    expect(error).toMatchObject({ code: "EACCES", exitCode: 7, receiptPersistenceFailure: expect.any(Error) });
  });

  it("rejects a non-directory receipt root before invoking any patch or CLI", async () => {
    const root = ownDirectory(), file = path.join(root, "not-a-root");
    fs.writeFileSync(file, "owned-fixture");
    const patcher = vi.fn();
    await expect(prepareFormalNext({ root: file, patcher })).rejects.toThrow("FORMAL_NEXT_RECEIPT_ROOT_UNSAFE");
    expect(patcher).not.toHaveBeenCalled();
  });
});

describe("actual self-owned Windows native launcher (never real Next)", () => {
  async function assertNonWindowsFailClosed() {
    const error = await runOwnedNodeTypegenCommand({ entry: fixture, args: ["stall"], stdio: "ignore", deadlineMs: 10000 })
      .catch(value => value as Error & { receipt: TypegenReceipt });
    expect(error).toMatchObject({ message: "TYPEGEN_NATIVE_OWNERSHIP_PLATFORM_UNSUPPORTED",
      receipt: { status: "FAILED", execution: "NOT_RUN", executed: false, nativeRoot: null,
        processQuiescence: { measurement: "NOT_RUN", capturedIdentityCount: null, remainingCapturedIdentityCount: null } } });
  }
  it("captures the paused root before an instantaneous CLI runs and awaits native exit", async () => {
    if (process.platform !== "win32") { await assertNonWindowsFailClosed(); return; }
    const output = path.join(ownDirectory(), "instant.json");
    const phases: Array<Record<string, unknown>> = [];
    const receipt = await runOwnedNodeTypegenCommand({ entry: fixture, args: ["instant", output], stdio: "ignore",
      environment: { ...process.env, VERIDIA_NEXT_DIST_DIR: "must-not-reach-fixture", E2E_NEXT_DIST_DIR: "test" },
      deadlineMs: 10000, onPhase: phase => { phases.push(phase); } });
    const actual = JSON.parse(fs.readFileSync(output, "utf8"));
    expect(phases.map(phase => phase.kind)).toEqual(["BOOTSTRAP_READY", "NATIVE_ROOT_CAPTURED"]);
    expect(receipt).toMatchObject({ status: "PASSED", executed: true, exitCode: 0, nativeCapturedBeforeCliRelease: true,
      nativeArmedBeforeCliRelease: true,
      processQuiescence: { measurement: "AVAILABLE", status: "PASSED", remainingCapturedIdentityCount: 0, exhaustiveProcessTreeClaim: false } });
    expect(receipt.nativeRoot?.pid).toBe(actual.pid);
    expect(Date.parse(receipt.nativeRoot!.capturedAt)).toBeLessThanOrEqual(Date.parse(actual.ranAt));
    expect(actual.overridesPresent).toEqual([]);
  }, 15000);

  it("a native-quiescent failed CLI retains exit 7 and still fails", async () => {
    if (process.platform !== "win32") { await assertNonWindowsFailClosed(); return; }
    const output = path.join(ownDirectory(), "failure.json");
    const diagnostic = vi.spyOn(console, "error");
    try {
      const error = await runOwnedNodeTypegenCommand({ entry: fixture, args: ["failure", output], stdio: "ignore", deadlineMs: 10000 })
        .catch(value => value as Error & { receipt: TypegenReceipt });
      expect(error).toMatchObject({ message: "TYPEGEN_COMMAND_FAILED", receipt: { status: "FAILED", exitCode: 7,
        processQuiescence: { status: "PASSED", remainingCapturedIdentityCount: 0 } } });
      const line = diagnostic.mock.calls.map(call => call[0]).find(value =>
        typeof value === "string" && value.startsWith("VERIDIA_TYPEGEN_FAILURE_STAGE="));
      expect(line).toBeDefined();
      const published = JSON.parse(String(line).slice(String(line).indexOf("=" ) + 1));
      expect(published).toMatchObject({ failureCode: "TYPEGEN_COMMAND_FAILED", cliReleased: true,
        nativeCapturedBeforeCliRelease: true, nativeArmedBeforeCliRelease: true,
        startupStages: ["SCRIPT_ENTERED", "ARGS_VALIDATED", "ROOT_PROCESS_OPEN_START", "ROOT_QUERY_START", "ROOT_QUERY_READY",
          "ROOT_NATIVE_HANDLE_START", "ROOT_NATIVE_HANDLE_READY", "ROOT_PROCESS_OPEN_READY",
          "ROOT_IDENTITY_BOUND", "READY_EMIT_START", "READY_EMITTED"] });
      expect(Object.keys(published).sort()).toEqual(["cliReleased", "elapsedMs", "failureCode", "monitorExitCode",
        "monitorSignal", "nativeArmedBeforeCliRelease", "nativeCapturedBeforeCliRelease", "startupStages"]);
      expect(String(line)).not.toContain(output);
    } finally { diagnostic.mockRestore(); }
  }, 15000);

  it("retains a live child's native birth under its live parent and waits for both exits", async () => {
    if (process.platform !== "win32") { await assertNonWindowsFailClosed(); return; }
    const directory = ownDirectory(), output = path.join(directory, "tree.json"), release = path.join(directory, "child-release");
    const receipt = await runOwnedNodeTypegenCommand({ entry: fixture, args: ["parent-with-child", output, release], stdio: "ignore",
      deadlineMs: 10000, onPhase: phase => {
        if (phase.kind !== "NATIVE_DESCENDANT_CAPTURED") return;
        const actual = JSON.parse(fs.readFileSync(output, "utf8"));
        if ((phase.identity as { pid: number }).pid === actual.childPid) fs.writeFileSync(release, "release", { flag: "wx" });
      } });
    expect(receipt.processQuiescence).toMatchObject({ status: "PASSED", remainingCapturedIdentityCount: 0 });
    expect(receipt.processQuiescence.capturedIdentityCount).toBeGreaterThanOrEqual(2);
  }, 15000);

  it("a captured live orphan blocks success and is cleaned only through retained native handles", async () => {
    if (process.platform !== "win32") { await assertNonWindowsFailClosed(); return; }
    const directory = ownDirectory(), output = path.join(directory, "orphan.json"), childRelease = path.join(directory, "never-release"),
      rootRelease = path.join(directory, "root-release");
    const error = await runOwnedNodeTypegenCommand({ entry: fixture,
      args: ["orphan-root", output, childRelease, rootRelease], stdio: "ignore", deadlineMs: 10000, exitDeadlineMs: 500,
      onPhase: phase => {
        if (phase.kind !== "NATIVE_DESCENDANT_CAPTURED") return;
        const actual = JSON.parse(fs.readFileSync(output, "utf8"));
        if ((phase.identity as { pid: number }).pid === actual.childPid) fs.writeFileSync(rootRelease, "release", { flag: "wx" });
      } }).catch(value => value as Error & { receipt: TypegenReceipt });
    expect(error, JSON.stringify((error as Error & { receipt: TypegenReceipt }).receipt.nativeMonitor)).toMatchObject({ message: "TYPEGEN_CAPTURED_TREE_NOT_QUIESCENT",
      receipt: { status: "FAILED", exitCode: 0, nativeMonitor: { remainingAfterCleanup: [] } } });
    const actual = JSON.parse(fs.readFileSync(output, "utf8"));
    expect((error as Error & { receipt: TypegenReceipt }).receipt.nativeMonitor).toMatchObject({
      remainingBeforeCleanup: expect.arrayContaining([expect.objectContaining({ pid: actual.childPid })]) });
  }, 15000);

  it("bounds a self-owned stalled CLI, kills only the creator handle and never reports acceptance", async () => {
    if (process.platform !== "win32") { await assertNonWindowsFailClosed(); return; }
    const error = await runOwnedNodeTypegenCommand({ entry: fixture, args: ["stall"], stdio: "ignore",
      deadlineMs: 2500, exitDeadlineMs: 1000 }).catch(value => value as Error & { receipt: TypegenReceipt });
    expect(error).toMatchObject({ receipt: { status: "FAILED" } });
    expect((error as Error & { receipt: TypegenReceipt }).receipt.nativeMonitor).toMatchObject({ remainingAfterCleanup: [] });
    expect((error as Error & { receipt: TypegenReceipt }).receipt.rootCleanupUnconfirmed).not.toBe(true);
  }, 10000);

  it("native lineage code rejects an older child before granting held-handle authority", () => {
    const monitor = fs.readFileSync(path.resolve("scripts/testing/next-typegen-owner-monitor.ps1"), "utf8");
    expect(monitor).toContain("$stamp -lt $parent.StartTime.ToUniversalTime().ToFileTimeUtc()");
    expect(monitor).toContain("PARENT_EXITED_BEFORE_NATIVE_LINEAGE_CAPTURE");
    expect(monitor).not.toMatch(/Stop-Process|taskkill|Start-Sleep/u);
  });

  it("reads actual Win32_Process identity without cmdlet/module auto loading and disposes each census", () => {
    const monitor = fs.readFileSync(path.resolve("scripts/testing/next-typegen-owner-monitor.ps1"), "utf8");
    const query = monitor.match(/function Get-TypegenProcessRows \{[\s\S]*?\n\}/u)?.[0];
    expect(query).toBeDefined();
    expect(monitor).not.toContain("Get-CimInstance");
    expect(query).toContain("$options.Timeout = [TimeSpan]::FromSeconds(2)");
    expect(query).toContain("$processRow.Dispose()");
    expect(query).toContain("$collection.Dispose()");
    expect(query).toContain("$searcher.Dispose()");
    if (process.platform !== "win32") return;
    const script = `$ErrorActionPreference='Stop'; $PSModuleAutoLoadingPreference='None';
$null=[Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a')
${query}
$rows=@(Get-TypegenProcessRows $PID)
if($rows.Count -ne 1 -or $rows[0].ProcessId -ne $PID -or $rows[0].ParentProcessId -le 0 -or $rows[0].CreationDate -isnot [DateTime] -or !$rows[0].ExecutablePath) { throw 'IDENTITY_QUERY_INVALID' }
$held=[Diagnostics.Process]::GetProcessById($PID)
try {
  $null=$held.Handle
  if([decimal]::Floor([decimal]$held.StartTime.ToUniversalTime().ToFileTimeUtc()/10) -ne [decimal]::Floor([decimal]$rows[0].CreationDate.ToUniversalTime().ToFileTimeUtc()/10)) { throw 'BIRTH_QUERY_MISMATCH' }
  if(![string]::Equals($rows[0].ExecutablePath,$held.MainModule.FileName,[StringComparison]::OrdinalIgnoreCase)) { throw 'EXECUTABLE_QUERY_MISMATCH' }
} finally { $held.Dispose() }
if(@(Get-TypegenProcessRows).Count -lt 1) { throw 'CENSUS_QUERY_INVALID' }
[Console]::Out.WriteLine('WIN32_PROCESS_QUERY_WITHOUT_MODULE_AUTOLOAD_PASS')`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("WIN32_PROCESS_QUERY_WITHOUT_MODULE_AUTOLOAD_PASS");
  });

  it("actual monitor pure birth function distinguishes PID replacement from CIM precision", async () => {
    if (process.platform !== "win32") { await assertNonWindowsFailClosed(); return; }
    const monitor = fs.readFileSync(path.resolve("scripts/testing/next-typegen-owner-monitor.ps1"), "utf8");
    const actual = monitor.match(/function Test-SameCapturedBirth \{[\s\S]*?\n\}/u)?.[0];
    expect(actual).toBeDefined();
    const script = `${actual}\n@((Test-SameCapturedBirth 134352894793735696 134352894793735696), (Test-SameCapturedBirth 134352894793735696 134352894793735690), (Test-SameCapturedBirth 134352894793735696 134352894793735710)) | ConvertTo-Json -Compress`;
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { encoding: "utf8", windowsHide: true, timeout: 3000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([true, true, false]);
    expect(monitor).toContain("CAPTURED_PID_REUSED_UNKNOWN_CURRENT_BIRTH");
    expect(monitor.indexOf("CAPTURED_PID_REUSED_UNKNOWN_CURRENT_BIRTH")).toBeLessThan(monitor.indexOf("$grew = $true"));
  });

  it("missing sampled birth never grants ownership and the wait uses one retained snapshot", () => {
    const monitor = fs.readFileSync(path.resolve("scripts/testing/next-typegen-owner-monitor.ps1"), "utf8");
    const guard = monitor.match(/function Test-CimBirthAvailable \{[\s\S]*?\n\}/u)?.[0];
    expect(guard).toBeDefined();
    const script = `${guard}\n@((Test-CimBirthAvailable $null), (Test-CimBirthAvailable ([pscustomobject]@{CreationDate=$null})), (Test-CimBirthAvailable ([pscustomobject]@{CreationDate='not-a-date'})), (Test-CimBirthAvailable ([pscustomobject]@{CreationDate=[DateTime]::UtcNow}))) | ConvertTo-Json -Compress`;
    if (process.platform === "win32") {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
        { encoding: "utf8", windowsHide: true, timeout: 3000 });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([false, false, false, true]);
    }
    for (const reason of ["TYPEGEN_ROOT_CIM_BIRTH_UNAVAILABLE", "CAPTURED_PID_CIM_BIRTH_UNAVAILABLE",
      "CAPTURED_PARENT_CIM_BIRTH_UNAVAILABLE", "CANDIDATE_CIM_BIRTH_UNAVAILABLE", "LATE_CHILD_CIM_BIRTH_UNAVAILABLE"]) expect(monitor).toContain(reason);
    expect(monitor).toContain("$liveForWait = @(LiveIdentities)");
    expect(monitor).toContain("$handles[$liveForWait[0].pid].WaitForExit(50)");
    expect(monitor).not.toContain("$handles[@(LiveIdentities)[0].pid]");
    expect(monitor).not.toMatch(/\$uncertain\.(?:Clear|Remove)\(/u);
  });
});
