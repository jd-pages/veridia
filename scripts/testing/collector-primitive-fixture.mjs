import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { captureWindowsScopedResiduals } from "./e2e-server-infrastructure.mjs";

// Test fixture only. Real native measurement can run in a standalone Node
// process; Unit contract tests inject transport/clock, not fake native proof.
// The existing 5000ms case budget is shared by both calls and all validation.
/** @param {{ execute?: typeof spawnSync, now?: () => number, onTiming?: (row: Record<string, unknown>) => void, budgetMs?: number }} [options] */
export function captureCollectorPrimitive({ execute = spawnSync, now = () => performance.now(), onTiming = () => {}, budgetMs = 5000 } = {}) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 5000) throw new Error("COLLECTOR_FIXTURE_BUDGET_INVALID");
  const started = now(), deadline = started + budgetMs, timings = [];
  const check = () => { if (now() >= deadline) throw new Error("COLLECTOR_FIXTURE_DEADLINE"); };
  const measured = stage => (command, args, options) => {
    check(); const entered = now();
    const timeout = Math.floor(deadline - entered);
    if (timeout < 1) throw new Error("COLLECTOR_FIXTURE_DEADLINE");
    let result;
    try { result = execute(command, args, { ...options, timeout }); }
    finally {
      const row = { stage, elapsedMs: now() - entered, timeoutMs: timeout, callerPid: process.pid,
        spawnedPid: result?.pid ?? null, exitCode: result?.status ?? null, failed: !result || Boolean(result.error) };
      timings.push(row); onTiming({ ...row });
    }
    check(); return result;
  };
  // Preserve the exact caller query + native-held birth proof from the
  // existing correction. No full process/TCP census just to find this caller.
  const script = "$ErrorActionPreference='Stop';\n" +
    "Import-Module ([IO.Path]::Combine($PSHOME,'Modules\\CimCmdlets\\CimCmdlets.psd1')) -ErrorAction Stop;\n" +
    "Import-Module ([IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop;\n" +
    "$caller=[Diagnostics.Process]::GetProcessById(" + process.pid + ");try {\n" +
    " $null=$caller.Handle;$nativeBirth=$caller.StartTime.ToUniversalTime().ToFileTimeUtc();\n" +
    " $rows=@(CimCmdlets\\Get-CimInstance Win32_Process -Filter 'ProcessId=" + process.pid + "' -ErrorAction Stop);\n" +
    " if($rows.Count -ne 1 -or $caller.HasExited -or [int]$rows[0].ProcessId -ne " + process.pid + " -or !$rows[0].CreationDate){throw 'CALLER_IDENTITY_UNAVAILABLE'};\n" +
    " $birth=$rows[0].CreationDate.ToUniversalTime();\n" +
    " if([decimal]::Floor([decimal]$nativeBirth/10) -ne [decimal]::Floor([decimal]$birth.ToFileTimeUtc()/10)){throw 'CALLER_BIRTH_MISMATCH'};\n" +
    " @{pid=[int]$rows[0].ProcessId;parentPid=[int]$rows[0].ParentProcessId;name=[string]$rows[0].Name;createdAt=$birth.ToString('o')}|ConvertTo-Json -Compress\n" +
    "}finally{$caller.Dispose()}";
  const result = measured("CALLER_IDENTITY")("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) throw new Error("COLLECTOR_FIXTURE_CALLER_FAILED");
  const wrapper = JSON.parse(result.stdout.trim());
  if (wrapper?.pid !== process.pid || wrapper?.parentPid !== process.ppid || wrapper?.name !== "node.exe") throw new Error("COLLECTOR_FIXTURE_CALLER_IDENTITY_INVALID");
  check();
  const observed = captureWindowsScopedResiduals({ projectRoot: path.resolve("."), profilePaths: [], identities: [], wrapperIdentity: wrapper }, measured("SCOPED_RESIDUALS"));
  check(); return { wrapper, observed, timings, elapsedMs: now() - started };
}
