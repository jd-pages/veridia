import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import { recordNativeProfileProbe } from "./recovery-diagnostics";
import {
  WINDOWS_BROWSER_ARGV_ASSEMBLY_BASE64,
  WINDOWS_BROWSER_ARGV_ASSEMBLY_SHA256,
} from "./windows-browser-argv-asset";
import {
  WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_BASE64,
  WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_SHA256,
} from "./windows-browser-profile-census-asset";

export type WindowsBrowserProcessIdentity = {
  pid: number;
  birthStamp: string;
  executablePath: string;
  profilePath: string;
  parentPid?: number;
  browserProcess?: boolean;
};

const OWNER_PROBE_TIMEOUT_MS = 2_000;

export class WindowsBrowserProfileOwnershipError extends Error {
  constructor(message: string, readonly diagnostic?: {
    phase: string; reason: string; exitCode?: number | null; elapsedMs?: number;
    nativeStage?: string; nativeFailureCode?: string; nativeStageElapsedMs?: number; nativeStageObservedElapsedMs?: number;
    nativeSpawnCode?: string;
    probeId?: string; probeStartedAt?: string; probeProcessId?: number; probeBirthStamp?: string;
    nativeScriptObservedAt?: string; stdoutBytes?: number; stdoutEnded?: boolean; nativeExitObserved?: boolean;
    stderrBytes?: number; nativeStartupFailure?: "OUT_OF_MEMORY" | "CLR_INITIALIZATION_FAILURE" | "POWERSHELL_PARSE_ERROR";
    terminationFailure?: { pid: number; birthStamp: string; nativeErrorCode: number; hresult: number; exitedAfterError: "TRUE" | "FALSE" | "UNKNOWN" };
    censusOpenFailure?: { pid: number; snapshotBirthStamp: string; nativeErrorCode: number; absentInCompleteSnapshot: boolean };
    censusImageFailure?: { pid: number; snapshotBirthStamp: string; nativeErrorCode: number; imageRead: boolean;
      returnedLength: number; sameHeldIdentity: boolean; waitResult: number };
    censusImageExitEvidence?: { pid: number; snapshotBirthStamp: string; basicExitStatus: number;
      exitFileTime: string; sameHeldIdentity: boolean };
    stageTimeline?: Array<{ stage: string; scriptElapsedMs: number; observedElapsedMs: number }>;
    operationFailureElapsedMs?: number;
    terminationRequest?: { elapsedMs: number; returned?: boolean; errorCode?: "KILL_THROWN" };
    nativeCloseObserved?: boolean; nativeCloseCode?: number | null;
    closureProof?: "CLOSED" | "NOT_PROVEN"; ioReleased?: boolean;
  }) { super(message); this.name = "WindowsBrowserProfileOwnershipError"; }
}

// Only a fixed stage vocabulary and a bounded clock value may leave the
// native probe. Diagnostics never grant ownership or change its deadline.
export function parseWindowsProfileProbeDiagnostic(text: string) {
  const result: { nativeStage?: string; nativeFailureCode?: string; nativeStageElapsedMs?: number;
    censusOpenFailure?: NonNullable<WindowsBrowserProfileOwnershipError["diagnostic"]>["censusOpenFailure"];
    censusImageFailure?: NonNullable<WindowsBrowserProfileOwnershipError["diagnostic"]>["censusImageFailure"];
    censusImageExitEvidence?: NonNullable<WindowsBrowserProfileOwnershipError["diagnostic"]>["censusImageExitEvidence"] } = {};
  const stage = /VERIDIA_PROFILE_PROBE_STAGE=(SCRIPT_ENTERED|UTILITY_MODULE_IMPORT|UTILITY_MODULE_IMPORTED|PARSER_COMPILE|PARSER_COMPILED|PARSER_ASSEMBLY_LOAD|PARSER_ASSEMBLY_LOADED|REQUEST_PARSE|PROCESS_CENSUS|PROCESS_CENSUS_QUERY_ENTER|PROCESS_CENSUS_QUERY_RETURN|PROCESS_CENSUS_ENUMERATE|WMI_GET_ENTER|WMI_GET_RETURN|WMI_ENUM_ENTER|WMI_ENUM_RETURN|WMI_MOVE_ENTER|WMI_MOVE_RETURN|WMI_ROW_READ|WMI_ROW_RETURN|WMI_BIRTH_PARSE|WMI_BIRTH_RETURN|WMI_ROW_DISPOSE|WMI_ROW_DISPOSED|WMI_DISPOSE|WMI_DISPOSED|PROFILE_ARGUMENT_READ|PROFILE_ARGUMENT_PARSED|NATIVE_HANDLE_BIND|NATIVE_PROCESS_OPEN|NATIVE_HANDLE_OPEN|NATIVE_BIRTH_READ|NATIVE_BIRTH_VALIDATE|NATIVE_IDENTITY_APPEND|NATIVE_HANDLE_DISPOSE|VALIDATED_TERMINATION|RESULT_EMIT|RESULT_SERIALIZED|RESULT_WRITTEN|CENSUS_ASSEMBLY_LOAD|CENSUS_ASSEMBLY_LOADED|SPI_CAPTURE_ENTER|SPI_CAPTURE_RETURN|SPI_HELD_PROCESS_OPEN|SPI_IMAGE_READ|SPI_IMAGE_RETURN|SPI_COMMAND_LINE_READ|SPI_COMMAND_LINE_RETURN|SPI_HELD_PROCESS_DISPOSE|SPI_VERIFIED_EXIT_SKIP|SPI_VERIFIED_ABSENCE_SKIP):([0-9]+(?:\.[0-9]+)?)\r?\n/gu;
  for (const match of text.matchAll(stage)) {
    const elapsed = Number(match[2]);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 60_000) {
      result.nativeStage = match[1];
      result.nativeStageElapsedMs = elapsed;
    }
  }
  const failure = text.match(/VERIDIA_PROFILE_PROBE_FAILURE=(UTILITY_MODULE_IMPORT|UTILITY_MODULE_IMPORTED|PARSER_COMPILE|PARSER_COMPILED|PARSER_ASSEMBLY_LOAD|PARSER_ASSEMBLY_LOADED|REQUEST_PARSE|PROCESS_CENSUS|PROCESS_CENSUS_QUERY_ENTER|PROCESS_CENSUS_QUERY_RETURN|PROCESS_CENSUS_ENUMERATE|WMI_GET_ENTER|WMI_GET_RETURN|WMI_ENUM_ENTER|WMI_ENUM_RETURN|WMI_MOVE_ENTER|WMI_MOVE_RETURN|WMI_ROW_READ|WMI_ROW_RETURN|WMI_BIRTH_PARSE|WMI_BIRTH_RETURN|WMI_ROW_DISPOSE|WMI_ROW_DISPOSED|WMI_DISPOSE|WMI_DISPOSED|PROFILE_ARGUMENT_READ|PROFILE_ARGUMENT_PARSED|NATIVE_HANDLE_BIND|NATIVE_PROCESS_OPEN|NATIVE_HANDLE_OPEN|NATIVE_BIRTH_READ|NATIVE_BIRTH_VALIDATE|NATIVE_IDENTITY_APPEND|NATIVE_HANDLE_DISPOSE|VALIDATED_TERMINATION|RESULT_EMIT|RESULT_SERIALIZED|RESULT_WRITTEN|CENSUS_ASSEMBLY_LOAD|CENSUS_ASSEMBLY_LOADED|SPI_CAPTURE_ENTER|SPI_CAPTURE_RETURN|SPI_HELD_PROCESS_OPEN|SPI_IMAGE_READ|SPI_IMAGE_RETURN|SPI_COMMAND_LINE_READ|SPI_COMMAND_LINE_RETURN|SPI_HELD_PROCESS_DISPOSE|SPI_VERIFIED_EXIT_SKIP|SPI_VERIFIED_ABSENCE_SKIP):(NATIVE_PROBE_SCRIPT_EXCEPTION|PROFILE_OWNERSHIP_UNAVAILABLE|LIVE_PROCESS_HANDLE_UNAVAILABLE|LIVE_PROCESS_BIRTH_MISMATCH|UNVERIFIED_PROFILE_OWNER|NATIVE_ARGV_ASSET_INVALID)\r?\n/u);
  if (failure) { result.nativeStage = failure[1]; result.nativeFailureCode = failure[2]; }
  const open = text.match(/^VERIDIA_PROFILE_PROBE_CENSUS_OPEN=([0-9]+):([0-9]+):([0-9]+):(TRUE|FALSE)\r?\n$/u);
  if (open && Number.isSafeInteger(Number(open[1])) && Number(open[1]) > 0 &&
      Number.isSafeInteger(Number(open[3])) && open[2].length <= 20) {
    result.censusOpenFailure = { pid: Number(open[1]), snapshotBirthStamp: open[2], nativeErrorCode: Number(open[3]), absentInCompleteSnapshot: open[4] === "TRUE" };
  }
  const image = text.match(/^VERIDIA_PROFILE_PROBE_CENSUS_IMAGE=([0-9]+):([0-9]+):([0-9]+):(TRUE|FALSE):([0-9]+):(TRUE|FALSE):([0-9]+)\r?\n$/u);
  if (image && Number.isSafeInteger(Number(image[1])) && Number(image[1]) > 0 && image[2].length <= 20 &&
      [image[3], image[5], image[7]].every(value => Number.isSafeInteger(Number(value)) && Number(value) <= 0xffff_ffff)) {
    result.censusImageFailure = { pid: Number(image[1]), snapshotBirthStamp: image[2], nativeErrorCode: Number(image[3]),
      imageRead: image[4] === "TRUE", returnedLength: Number(image[5]), sameHeldIdentity: image[6] === "TRUE", waitResult: Number(image[7]) };
  }
  const imageState = text.match(/^VERIDIA_PROFILE_PROBE_CENSUS_IMAGE_STATE=([0-9]+):([0-9]+):([0-9]+):([0-9]+):(TRUE|FALSE)\r?\n$/u);
  if (imageState && Number.isSafeInteger(Number(imageState[1])) && Number(imageState[1]) > 0 && imageState[2].length <= 20 &&
      Number.isSafeInteger(Number(imageState[3])) && Number(imageState[3]) <= 0xffff_ffff &&
      imageState[4].length <= 20 && BigInt(imageState[4]) <= 0xffff_ffff_ffff_ffffn) {
    result.censusImageExitEvidence = { pid: Number(imageState[1]), snapshotBirthStamp: imageState[2], basicExitStatus: Number(imageState[3]),
      exitFileTime: imageState[4], sameHeldIdentity: imageState[5] === "TRUE" };
  }
  return result;
}

// CommandLineToArgvW rules, including backslashes immediately before quotes.
// The OS probe below uses CommandLineToArgvW itself; this parser makes the
// exact-profile policy independently testable without a real Windows process.
export function parseWindowsCommandLine(commandLine: string) {
  const args: string[] = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/\s/u.test(commandLine[index] || "")) index += 1;
    if (index >= commandLine.length) break;
    let argument = "";
    let quoted = false;
    while (index < commandLine.length) {
      const character = commandLine[index];
      if (!quoted && /\s/u.test(character)) break;
      if (character === "\\") {
        let slashes = 0;
        while (commandLine[index] === "\\") { slashes += 1; index += 1; }
        if (commandLine[index] !== '"') { argument += "\\".repeat(slashes); continue; }
        argument += "\\".repeat(Math.floor(slashes / 2));
        if (slashes % 2) { argument += '"'; index += 1; continue; }
      }
      if (commandLine[index] === '"') {
        if (quoted && commandLine[index + 1] === '"') { argument += '"'; index += 2; }
        else { quoted = !quoted; index += 1; }
      } else { argument += commandLine[index]; index += 1; }
    }
    args.push(argument);
  }
  return args;
}

function canonicalWindowsPath(value: string) {
  return path.win32.resolve(value).replace(/[\\/]+$/u, "").toLowerCase();
}

export function exactBrowserProfileArgument(commandLine: string, profilePath: string) {
  const args = parseWindowsCommandLine(commandLine);
  const profiles = args.filter(arg => arg.toLowerCase().startsWith("--user-data-dir="))
    .map(arg => arg.slice("--user-data-dir=".length));
  return profiles.length === 1 && profiles[0].length > 0 &&
    canonicalWindowsPath(profiles[0]) === canonicalWindowsPath(profilePath);
}

export function sameWindowsBrowserProcess(
  actual: WindowsBrowserProcessIdentity,
  expected: WindowsBrowserProcessIdentity,
) {
  return actual.pid === expected.pid && actual.birthStamp === expected.birthStamp &&
    canonicalWindowsPath(actual.executablePath) === canonicalWindowsPath(expected.executablePath) &&
    canonicalWindowsPath(actual.profilePath) === canonicalWindowsPath(expected.profilePath);
}

export function authorizeWindowsBrowserDescendants(
  current: WindowsBrowserProcessIdentity[],
  captured: WindowsBrowserProcessIdentity[],
) {
  const authorized = current.filter(actual => captured.some(expected => sameWindowsBrowserProcess(actual, expected)));
  const liveRoots = authorized.filter(actual => actual.browserProcess === true);
  const pending = current.filter(actual => !authorized.includes(actual));
  if (pending.some(actual => actual.browserProcess !== false) || (pending.length && !liveRoots.length)) {
    throw new WindowsBrowserProfileOwnershipError("Chromium Profile 仍有未验证的物理所有者，禁止强制终止或复用");
  }
  let added = true;
  while (pending.length && added) {
    added = false;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const child = pending[index];
      const parent = authorized.find(candidate => candidate.pid === child.parentPid &&
        BigInt(child.birthStamp) >= BigInt(candidate.birthStamp) &&
        canonicalWindowsPath(child.executablePath) === canonicalWindowsPath(candidate.executablePath) &&
        canonicalWindowsPath(child.profilePath) === canonicalWindowsPath(candidate.profilePath));
      if (!parent) continue;
      // Every edge must end at a currently live, captured root. Previously
      // captured orphans may be terminated, but cannot bless new descendants.
      let ancestor = parent;
      const visited = new Set<number>();
      while (!liveRoots.includes(ancestor) && ancestor.parentPid && !visited.has(ancestor.pid)) {
        visited.add(ancestor.pid);
        const next = authorized.find(candidate => candidate.pid === ancestor.parentPid);
        if (!next) break;
        ancestor = next;
      }
      if (!liveRoots.includes(ancestor)) continue;
      authorized.push(child);
      pending.splice(index, 1);
      added = true;
    }
  }
  if (pending.length) throw new WindowsBrowserProfileOwnershipError("Chromium Profile 后代进程无法验证，禁止强制终止或复用");
  return [...captured, ...authorized.filter(actual => !captured.some(expected => sameWindowsBrowserProcess(actual, expected)))];
}

export function authorizeInitialWindowsBrowserOwners(
  current: WindowsBrowserProcessIdentity[], expectedRootPid?: number,
) {
  const roots = current.filter(identity => identity.browserProcess === true);
  if (roots.length !== 1 || (expectedRootPid !== undefined && roots[0].pid !== expectedRootPid)) {
    throw new WindowsBrowserProfileOwnershipError("Chromium 物理 Profile 必须属于唯一且已验证的启动进程");
  }
  return authorizeWindowsBrowserDescendants(current, roots);
}

function guardScript() {
  // Only exact executable/profile matches leave this process. Raw command
  // lines, environment, browser URLs and credentials are never emitted.
  return `[Console]::Error.WriteLine('VERIDIA_PROFILE_PROBE_STAGE=SCRIPT_ENTERED:0'); [Console]::Error.Flush();
$ErrorActionPreference='Stop'; $probeClock=[Diagnostics.Stopwatch]::StartNew();
${process.env.VERIDIA_E2E === "true" ? "[Console]::Error.WriteLine('VERIDIA_PROFILE_PROBE_SELF='+$PID+':'+[Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc().ToString()+':'+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()); [Console]::Error.Flush();" : ""}
function Set-ProbeStage([string]$value) {
  $script:phase=$value;
  [Console]::Error.WriteLine('VERIDIA_PROFILE_PROBE_STAGE='+$value+':'+$probeClock.ElapsedMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture));
  # Console.Error WriteLine delivers this newline before a blocked native call.
  # Do not add a second synchronous Flush for every per-row stage marker.
}
$phase='UTILITY_MODULE_IMPORT'; $owned=@(); $handles=@(); $boundBirths=@{}; try {
# Resolve only the required Windows built-in module. The immutable OS argv
# wrapper is loaded, not compiled, inside the same complete 2000ms budget.
Set-ProbeStage 'UTILITY_MODULE_IMPORT';
Import-Module ([IO.Path]::Combine($PSHOME,'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop;
Set-ProbeStage 'UTILITY_MODULE_IMPORTED';
Set-ProbeStage 'REQUEST_PARSE';
# Request identities are data, not command text. Their count must not grow the
# CreateProcess command line or bypass the unchanged native admission checks.
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false);
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false);
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json;
$expectedExecutable = [IO.Path]::GetFullPath($request.executablePath);
$expectedProfile = [IO.Path]::GetFullPath($request.profilePath).TrimEnd('\\');
$owned = @(); $handles = @(); $script:parserReady = $false;
  # Keep the same Win32_Process fields and native handle/birth admission, but
  # do not activate CimCmdlets/module discovery for every short-lived probe.
  function Get-OwnerProcessRows([string]$filter) {
    $null = [Reflection.Assembly]::Load('System.Management, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a');
    $options = [System.Management.EnumerationOptions]::new();
    $options.Timeout = [TimeSpan]::FromMilliseconds(${OWNER_PROBE_TIMEOUT_MS});
    $options.ReturnImmediately = $true; $options.Rewindable = $false;
    # Fetch a bounded block per native enumeration call, still walking to
    # exhaustion. This changes transport batching, never the census scope.
    $options.BlockSize = 32;
    $query = 'SELECT ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate FROM Win32_Process WHERE ' + $filter;
    $searcher = [System.Management.ManagementObjectSearcher]::new('root\\cimv2', $query, $options);
    $collection = $null; $enumerator = $null;
    try {
      Set-ProbeStage 'WMI_GET_ENTER';
      $collection = $searcher.Get();
      Set-ProbeStage 'WMI_GET_RETURN';
      # Same OS parser and query; no runtime compiler, cache or prewarm.
      # Load the exact bundled bytes, not a mutable path, and fail closed on
      # any digest/type mismatch. No probe can supply another native helper.
      if (!$script:parserReady) {
        Set-ProbeStage 'PARSER_ASSEMBLY_LOAD';
        $parserBytes = [Convert]::FromBase64String($request.argvAssembly);
        $parserHash = [Security.Cryptography.SHA256]::Create();
        try { $parserDigest = [BitConverter]::ToString($parserHash.ComputeHash($parserBytes)).Replace('-','').ToLowerInvariant() }
        finally { $parserHash.Dispose() }
        if ($parserDigest -cne '${WINDOWS_BROWSER_ARGV_ASSEMBLY_SHA256}') { throw 'NATIVE_ARGV_ASSET_INVALID' }
        $parserAssembly = [Reflection.Assembly]::Load($parserBytes);
        $parserType = $parserAssembly.GetType('VeridiaBrowserArgv');
        if (!$parserType -or $parserType.Assembly -ne $parserAssembly -or $parserAssembly.GetExportedTypes().Length -ne 1) { throw 'NATIVE_ARGV_ASSET_INVALID' }
        $script:parserReady = $true;
        Set-ProbeStage 'PARSER_ASSEMBLY_LOADED';
      }
      Set-ProbeStage 'WMI_ENUM_ENTER';
      $enumerator = $collection.GetEnumerator();
      Set-ProbeStage 'WMI_ENUM_RETURN';
      while ($true) {
        Set-ProbeStage 'WMI_MOVE_ENTER';
        $more = $enumerator.MoveNext();
        Set-ProbeStage 'WMI_MOVE_RETURN';
        if (!$more) { break }
        Set-ProbeStage 'WMI_ROW_READ';
        $row = $enumerator.Current;
        try {
          $creationText = [string]$row['CreationDate'];
          $pidValue = [int]$row['ProcessId']; $parentValue = [int]$row['ParentProcessId'];
          $exeValue = [string]$row['ExecutablePath']; $commandValue = [string]$row['CommandLine'];
          Set-ProbeStage 'WMI_ROW_RETURN';
          $creation = $null;
          if ($creationText) {
            Set-ProbeStage 'WMI_BIRTH_PARSE';
            try { $creation = [System.Management.ManagementDateTimeConverter]::ToDateTime($creationText) }
            catch { $creation = $null } # Unavailable birth cannot grant ownership.
            Set-ProbeStage 'WMI_BIRTH_RETURN';
          }
          [pscustomobject]@{ ProcessId=$pidValue; ParentProcessId=$parentValue;
            ExecutablePath=$exeValue; CommandLine=$commandValue; CreationDate=$creation }
        } finally { Set-ProbeStage 'WMI_ROW_DISPOSE'; $row.Dispose(); Set-ProbeStage 'WMI_ROW_DISPOSED' }
      }
    } finally {
      Set-ProbeStage 'WMI_DISPOSE';
      if ($enumerator -is [IDisposable]) { $enumerator.Dispose() }
      if ($collection) { $collection.Dispose() }; $searcher.Dispose();
      Set-ProbeStage 'WMI_DISPOSED'
    }
  }
  Set-ProbeStage 'PROCESS_CENSUS';
  # Push the already mandatory exact executable predicate into WMI. Rows
  # rejected by the same executable check below cannot authorize a profile.
  # WQL escapes both backslashes and literal quote characters, never LIKE.
  $name = [IO.Path]::GetFileName($expectedExecutable).Replace('\\','\\\\').Replace("'","\\'");
  $queryExecutable = $expectedExecutable.Replace('\\','\\\\').Replace("'","\\'");
  Set-ProbeStage 'PROCESS_CENSUS_QUERY_ENTER';
  Set-ProbeStage 'CENSUS_ASSEMBLY_LOAD';
  $censusBytes = [Convert]::FromBase64String($request.censusAssembly);
  $censusHash = [Security.Cryptography.SHA256]::Create();
  try { $censusDigest = [BitConverter]::ToString($censusHash.ComputeHash($censusBytes)).Replace('-','').ToLowerInvariant() }
  finally { $censusHash.Dispose() }
  if ($censusDigest -cne '${WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_SHA256}') { throw 'NATIVE_ARGV_ASSET_INVALID' }
  $censusAssembly = [Reflection.Assembly]::Load($censusBytes);
  $censusType = $censusAssembly.GetType('VeridiaBrowserProfileCensus');
  if (!$censusType -or $censusType.Assembly -ne $censusAssembly -or $censusAssembly.GetExportedTypes().Length -ne 1) { throw 'NATIVE_ARGV_ASSET_INVALID' }
  Set-ProbeStage 'CENSUS_ASSEMBLY_LOADED';
  # Only the previously verified SPI layouts use the new read-only census.
  # Other OS profiles keep the original strict WMI path. A native query,
  # identity or permission failure never falls back or grants authority.
  $nativeCensus = [VeridiaBrowserProfileCensus]::IsApprovedAbi();
  if ($nativeCensus) {
    Set-ProbeStage 'PARSER_ASSEMBLY_LOAD';
    $parserBytes = [Convert]::FromBase64String($request.argvAssembly);
    $parserHash = [Security.Cryptography.SHA256]::Create();
    try { $parserDigest = [BitConverter]::ToString($parserHash.ComputeHash($parserBytes)).Replace('-','').ToLowerInvariant() }
    finally { $parserHash.Dispose() }
    if ($parserDigest -cne '${WINDOWS_BROWSER_ARGV_ASSEMBLY_SHA256}') { throw 'NATIVE_ARGV_ASSET_INVALID' }
    $parserAssembly = [Reflection.Assembly]::Load($parserBytes);
    $parserType = $parserAssembly.GetType('VeridiaBrowserArgv');
    if (!$parserType -or $parserType.Assembly -ne $parserAssembly -or $parserAssembly.GetExportedTypes().Length -ne 1) { throw 'NATIVE_ARGV_ASSET_INVALID' }
    $script:parserReady = $true;
    Set-ProbeStage 'PARSER_ASSEMBLY_LOADED';
    try { $candidates = @([VeridiaBrowserProfileCensus]::ReadProfileRows($expectedExecutable, $probeClock)) }
    catch { if ([VeridiaBrowserProfileCensus]::LastStage) { $phase = [VeridiaBrowserProfileCensus]::LastStage }; throw }
  } else {
    $candidates = @(Get-OwnerProcessRows "Name='$name' AND ExecutablePath='$queryExecutable'");
  }
  Set-ProbeStage 'PROCESS_CENSUS_QUERY_RETURN';
  foreach ($candidate in $candidates) {
    Set-ProbeStage 'PROCESS_CENSUS_ENUMERATE';
    if (![string]::Equals($candidate.ExecutablePath, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (!$candidate.CommandLine -or !$candidate.CreationDate) { throw 'PROFILE_OWNERSHIP_UNAVAILABLE' }
    Set-ProbeStage 'PROFILE_ARGUMENT_READ';
    $argv = [VeridiaBrowserArgv]::Parse($candidate.CommandLine);
    Set-ProbeStage 'PROFILE_ARGUMENT_PARSED';
    $profiles = @(); $isBrowser = $true;
    # Direct traversal preserves duplicate/empty argument rejection without
    # activating two pipeline command bindings for every census candidate.
    foreach ($argument in $argv) {
      if ($argument.StartsWith('--user-data-dir=', [StringComparison]::OrdinalIgnoreCase)) { $profiles += $argument.Substring(16) }
      if ($argument.StartsWith('--type=', [StringComparison]::OrdinalIgnoreCase)) { $isBrowser = $false }
    }
    if ($profiles.Count -ne 1 -or !$profiles[0]) { continue }
    if (![string]::Equals([IO.Path]::GetFullPath($profiles[0]).TrimEnd('\\'), $expectedProfile, [StringComparison]::OrdinalIgnoreCase)) { continue }
    Set-ProbeStage 'NATIVE_HANDLE_BIND';
    try {
      Set-ProbeStage 'NATIVE_PROCESS_OPEN';
      $process = [Diagnostics.Process]::GetProcessById([int]$candidate.ProcessId);
      Set-ProbeStage 'NATIVE_HANDLE_OPEN';
      $null = $process.Handle
    } catch {
      $stillExists = if ($nativeCensus) { [VeridiaBrowserProfileCensus]::ProcessStillExists([int]$candidate.ProcessId, $probeClock) } else { @(Get-OwnerProcessRows "ProcessId=$($candidate.ProcessId)").Count -gt 0 };
      if ($stillExists) { throw 'LIVE_PROCESS_HANDLE_UNAVAILABLE' }
      continue
    }
    Set-ProbeStage 'NATIVE_BIRTH_READ';
    $birthStamp = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
    Set-ProbeStage 'NATIVE_BIRTH_VALIDATE';
    $cimStamp = $candidate.CreationDate.ToUniversalTime().ToFileTimeUtc();
    $birthMatches = if ($nativeCensus) { $birthStamp -ceq [string]$candidate.NativeSnapshotBirthStamp } else {
      [decimal]::Floor([decimal]$birthStamp / 10) -eq [decimal]::Floor([decimal]$cimStamp / 10)
    };
    if (!$birthMatches) {
      $process.Dispose();
      $stillExists = if ($nativeCensus) { [VeridiaBrowserProfileCensus]::ProcessStillExists([int]$candidate.ProcessId, $probeClock) } else { @(Get-OwnerProcessRows "ProcessId=$($candidate.ProcessId)").Count -gt 0 };
      if ($stillExists) { throw 'LIVE_PROCESS_BIRTH_MISMATCH' }
      continue
    }
    $identity = @{pid=[int]$candidate.ProcessId; parentPid=[int]$candidate.ParentProcessId; browserProcess=$isBrowser; birthStamp=$birthStamp; executablePath=$expectedExecutable; profilePath=$expectedProfile};
    Set-ProbeStage 'NATIVE_IDENTITY_APPEND';
    $owned += $identity;
    if ($request.terminate) {
      $matchCount = 0;
      foreach ($expected in $request.terminate) {
        if ($expected.pid -eq $identity.pid -and $expected.birthStamp -eq $birthStamp -and [string]::Equals($expected.executablePath, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($expected.profilePath.TrimEnd('\\'), $expectedProfile, [StringComparison]::OrdinalIgnoreCase)) { $matchCount += 1 }
      }
      if ($matchCount -ne 1) { $process.Dispose(); throw 'UNVERIFIED_PROFILE_OWNER' }
      $boundBirths[$process.Id] = $birthStamp;
      $handles += $process;
    } else { Set-ProbeStage 'NATIVE_HANDLE_DISPOSE'; $process.Dispose() }
  }
  # All identities are validated before any termination. Process.Handle was
  # opened before StartTime; Kill therefore targets that OS handle, not a PID
  # which may have been reused between validation and termination.
  Set-ProbeStage 'VALIDATED_TERMINATION';
  foreach ($process in $handles) {
    if (!$process.HasExited) {
      try { $process.Kill() }
      catch {
        # Fixed numeric/boolean evidence only; still rethrow the same failure.
        $failure = $_.Exception;
        for ($depth=0; $depth -lt 4 -and $failure.InnerException; $depth+=1) { $failure=$failure.InnerException }
        $nativeCode=0; if($failure -is [ComponentModel.Win32Exception]) { $nativeCode=$failure.NativeErrorCode }
        $exited='UNKNOWN'; try { $exited=$(if($process.HasExited){'TRUE'}else{'FALSE'}) } catch {}
        [Console]::Error.WriteLine('VERIDIA_PROFILE_PROBE_TERMINATION_FAILURE='+$process.Id+':'+$boundBirths[$process.Id]+':'+$nativeCode+':'+$failure.HResult+':'+$exited);
        [Console]::Error.Flush();
        # ERROR_ACCESS_DENIED also reports a process that exited after the
        # pre-kill check. Only the same already-held handle's proved exit is
        # acceptable; no retry, no new PID and no ambiguous/live exception.
        if ($nativeCode -eq 5 -and $exited -eq 'TRUE') { continue }
        throw
      }
    }
  }
  Set-ProbeStage 'RESULT_EMIT';
  $resultJson = ConvertTo-Json -InputObject @($owned) -Depth 4 -Compress;
  Set-ProbeStage 'RESULT_SERIALIZED';
  [Console]::Out.WriteLine($resultJson); [Console]::Out.Flush();
  Set-ProbeStage 'RESULT_WRITTEN';
} catch {
  $code='NATIVE_PROBE_SCRIPT_EXCEPTION';
  # Reflection/static managed calls wrap the already fixed native code.
  # Unwrap only a bounded exception chain; never emit its raw message.
  $probeFailure=$_.Exception;
  for($depth=0; $depth -lt 4 -and $probeFailure.InnerException; $depth+=1) { $probeFailure=$probeFailure.InnerException }
  foreach ($allowed in @('PROFILE_OWNERSHIP_UNAVAILABLE','LIVE_PROCESS_HANDLE_UNAVAILABLE','LIVE_PROCESS_BIRTH_MISMATCH','UNVERIFIED_PROFILE_OWNER','NATIVE_ARGV_ASSET_INVALID')) {
    if ($probeFailure.Message -eq $allowed) { $code=$allowed }
  }
  # Only this fixed vocabulary crosses stderr, never raw native exceptions.
  [Console]::Error.WriteLine('VERIDIA_PROFILE_PROBE_FAILURE='+$phase+':'+$code);
  exit 1
} finally { foreach ($process in $handles) { $process.Dispose() } }`
    // No here-strings or request data occur in this fixed native program.
    // Remove lexical comments/indentation, not code, to retain the existing
    // command-size ceiling while both immutable assets travel through stdin.
    .replace(/^[\t ]*#.*(?:\r?\n|$)/gmu, "").replace(/^[\t ]+/gmu, "");
}

export async function captureWindowsBrowserProfileOwners(
  executablePath: string,
  profilePath: string,
  terminate?: WindowsBrowserProcessIdentity[],
) {
  // Admission and failure-join share this one budget. Wall-clock changes do
  // not extend it; a failed probe never grants Profile reuse authority.
  const startedMs = performance.now();
  const deadlineMs = startedMs + OWNER_PROBE_TIMEOUT_MS;
  const elapsed = () => performance.now() - startedMs;
  const remaining = () => deadlineMs - performance.now();
  const executable = path.win32.resolve(executablePath);
  const profile = path.win32.resolve(profilePath);
  const script = guardScript();
  const request = JSON.stringify({ executablePath: executable, profilePath: profile, terminate,
    argvAssembly: WINDOWS_BROWSER_ARGV_ASSEMBLY_BASE64, censusAssembly: WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_BASE64 });
  const e2e = process.env.VERIDIA_E2E === "true";
  const probeId = e2e ? randomUUID() : undefined;
  const probeStartedAt = e2e ? new Date().toISOString() : undefined;
  const wallStartedAt = Date.now();
  const stageTimeline: NonNullable<WindowsBrowserProfileOwnershipError["diagnostic"]>["stageTimeline"] = [];
  const callerFrames = e2e ? new Error().stack?.split(/\r?\n/u).filter(line => line.trimStart().startsWith("at ")).slice(0, 8) : undefined;
  const record = (details: Record<string, unknown>) => {
    if (!e2e) return;
    recordNativeProfileProbe({ probeId, probeStartedAt,
      callerProcessId: process.pid, callerFrames, profileIdentity: createHash("sha256").update(canonicalWindowsPath(profile)).digest("hex"), ...details });
  };
  return new Promise<WindowsBrowserProcessIdentity[]>((resolve, reject) => {
    const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
    let child: ChildProcessWithoutNullStreams;
    try { child = spawn("powershell.exe", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) {
      if (!e2e) { reject(error); return; }
      const nativeSpawnCode = (error as NodeJS.ErrnoException | null | undefined)?.code;
      record({ status: "FAILED", reason: "NATIVE_PROBE_SYNC_SPAWN_FAILED", nativeSpawnCode, elapsedMs: elapsed() });
      reject(new WindowsBrowserProfileOwnershipError("Chromium 物理 Profile 所有权检查失败，禁止复用未验证的 Profile", {
        phase: "PROFILE_OWNER_PROBE", reason: "NATIVE_PROBE_SYNC_SPAWN_FAILED", elapsedMs: elapsed(), nativeSpawnCode, probeId, probeStartedAt,
      }));
      return;
    }
    let stdout = "", settled = false, stderrCarry = "", stderrFlushed = false;
    const stderrDecoder = new StringDecoder("utf8");
    const timer = { handle: undefined as ReturnType<typeof setTimeout> | undefined };
    let diagnostic: ReturnType<typeof parseWindowsProfileProbeDiagnostic> & { nativeStageObservedElapsedMs?: number } = {};
    let probeBirthStamp: string | undefined, nativeScriptObservedAt: string | undefined;
    let stdoutBytes = 0, stderrBytes = 0, stdoutEnded = false, nativeExitObserved = false, nativeCloseObserved = false;
    let exitCode: number | null | undefined, closeCode: number | null | undefined;
    let nativeStartupFailure: NonNullable<WindowsBrowserProfileOwnershipError["diagnostic"]>["nativeStartupFailure"];
    let terminationFailure: NonNullable<WindowsBrowserProfileOwnershipError["diagnostic"]>["terminationFailure"];
    let operationFailure: { reason: string; elapsedMs: number } | undefined;
    let terminationRequest: NonNullable<WindowsBrowserProfileOwnershipError["diagnostic"]>["terminationRequest"];
    let requestingKill = false;
    const details = () => ({
      elapsedMs: elapsed(), exitCode, probeProcessId: child.pid, probeBirthStamp, nativeScriptObservedAt,
      stdoutBytes, stdoutEnded, nativeExitObserved, stderrBytes, nativeStartupFailure, terminationFailure,
      nativeCloseObserved, nativeCloseCode: closeCode,
      closureProof: nativeCloseObserved && nativeExitObserved ? "CLOSED" as const : "NOT_PROVEN" as const,
      operationFailureElapsedMs: operationFailure?.elapsedMs, terminationRequest,
      stageTimeline: [...stageTimeline], ...diagnostic,
    });
    const consumeStderr = (text: string, final = false) => {
      const lines = (stderrCarry + text).split(/\r?\n/u);
      stderrCarry = (lines.pop() || "").slice(-2_000);
      if (final && stderrCarry) { lines.push(stderrCarry); stderrCarry = ""; }
      for (const line of lines) {
        if (/System\.OutOfMemoryException|0x(?:8007000e|c0000017)\b/iu.test(line)) nativeStartupFailure = "OUT_OF_MEMORY";
        else if (!nativeStartupFailure && /0x(?:80131700|c0000142)\b/iu.test(line)) nativeStartupFailure = "CLR_INITIALIZATION_FAILURE";
        else if (!nativeStartupFailure && /\bParserError\b|\bParseException\b/u.test(line)) nativeStartupFailure = "POWERSHELL_PARSE_ERROR";
        const termination = line.match(/^VERIDIA_PROFILE_PROBE_TERMINATION_FAILURE=([0-9]+):([0-9]+):(-?[0-9]+):(-?[0-9]+):(TRUE|FALSE|UNKNOWN)$/u);
        if (termination && [termination[1], termination[3], termination[4]].every(value => Number.isSafeInteger(Number(value))) && Number(termination[1]) > 0) {
          terminationFailure = { pid: Number(termination[1]), birthStamp: termination[2], nativeErrorCode: Number(termination[3]),
            hresult: Number(termination[4]), exitedAfterError: termination[5] as "TRUE" | "FALSE" | "UNKNOWN" };
        }
        const nativeSelf = line.match(/^VERIDIA_PROFILE_PROBE_SELF=([0-9]+):([0-9]+)(?::([0-9]+))?$/u);
        if (nativeSelf && Number(nativeSelf[1]) === child.pid) {
          probeBirthStamp = nativeSelf[2];
          const nativeEpoch = Number(nativeSelf[3]);
          if (Number.isSafeInteger(nativeEpoch) && Math.abs(nativeEpoch - wallStartedAt) <= 60_000) nativeScriptObservedAt = new Date(nativeEpoch).toISOString();
        }
        const event = parseWindowsProfileProbeDiagnostic(line + "\n");
        if (event.nativeStage !== undefined &&
            (event.nativeStage !== diagnostic.nativeStage || event.nativeStageElapsedMs !== diagnostic.nativeStageElapsedMs)) {
          diagnostic.nativeStageObservedElapsedMs = elapsed();
        }
        diagnostic = { ...diagnostic, ...event };
        if (e2e && event.nativeStage !== undefined && event.nativeStageElapsedMs !== undefined) {
          stageTimeline.push({ stage: event.nativeStage, scriptElapsedMs: event.nativeStageElapsedMs, observedElapsedMs: elapsed() });
          if (stageTimeline.length > 64) stageTimeline.shift();
        }
      }
    };
    const flushStderr = () => {
      if (stderrFlushed) return;
      stderrFlushed = true;
      consumeStderr(stderrDecoder.end(), true);
    };
    const releaseIo = () => {
      if (timer.handle !== undefined) clearTimeout(timer.handle);
      child.stderr.removeListener("data", onStderr);
      child.stderr.removeListener("end", flushStderr);
      child.stderr.removeListener("error", onPipeError);
      child.stdout.removeListener("data", onStdout);
      child.stdout.removeListener("end", onStdoutEnd);
      child.stdout.removeListener("error", onPipeError);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      child.stdin.removeListener("error", onInputError);
      // No second kill and no PID lookup. An unproved child stays failed;
      // release creator I/O so it cannot keep this operation hanging forever.
      if (!nativeCloseObserved) {
        // A deferred spawn error may arrive after an exhausted synchronous
        // startup budget. Preserve failure; do not let this secondary event
        // become an unhandled EventEmitter error after disposing admission.
        child.once("error", () => record({ status: "DISPOSED_NATIVE_ERROR", reason: "NATIVE_EVENT_AFTER_BOUNDED_FAILURE", ...details() }));
        child.stdin.on("error", ignorePipeError); child.stdout.on("error", ignorePipeError); child.stderr.on("error", ignorePipeError);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
      }
    };
    const finishFailure = () => {
      if (settled || requestingKill || !operationFailure) return;
      // A cutoff is not a producer EOF: do not invent a complete protocol
      // line from an unfinished stderr fragment when close remains unproved.
      settled = true; releaseIo();
      record({ status: "FAILED", reason: operationFailure.reason, ...details(), ioReleased: true });
      reject(new WindowsBrowserProfileOwnershipError(operationFailure.reason === "NATIVE_PROBE_RESPONSE_INVALID"
        ? "Chromium 物理 Profile 所有权响应无效"
        : "Chromium 物理 Profile 所有权检查失败，禁止复用未验证的 Profile", {
        phase: "PROFILE_OWNER_PROBE", reason: operationFailure.reason, ...details(), ioReleased: true,
        ...(e2e ? { probeId, probeStartedAt } : {}),
      }));
    };
    const requestTermination = () => {
      if (terminationRequest || nativeExitObserved || nativeCloseObserved) return;
      terminationRequest = { elapsedMs: elapsed() };
      requestingKill = true;
      try { terminationRequest.returned = child.kill(); }
      catch { terminationRequest.errorCode = "KILL_THROWN"; }
      finally { requestingKill = false; }
      record({ status: "TERMINATION_REQUEST", ...details() });
    };
    const fail = (reason: string) => {
      if (settled) return;
      if (!operationFailure) {
        operationFailure = { reason, elapsedMs: elapsed() };
        record({ status: "OPERATION_FAILED", reason, ...details() });
      }
      requestTermination();
      if (nativeCloseObserved || remaining() <= 0) finishFailure();
      // Otherwise await real close, at most until the original deadline.
    };
    function ignorePipeError() { /* disposed creator pipe; no authority */ }
    function onStderr(chunk: Buffer) { stderrBytes += chunk.length; consumeStderr(stderrDecoder.write(chunk)); }
    function onStdout(chunk: Buffer) {
      stdoutBytes += chunk.length; stdout += chunk.toString("utf8");
      if (stdout.length > 100_000) fail("NATIVE_PROBE_OUTPUT_LIMIT");
    }
    function onStdoutEnd() { stdoutEnded = true; }
    function onExit(code: number | null) {
      nativeExitObserved = true; exitCode = code;
      record({ status: "NATIVE_EXIT_OBSERVED", ...details() });
    }
    function onError() {
      fail("NATIVE_PROBE_SPAWN_FAILED");
      if (!child.pid) finishFailure(); // no successfully spawned native child to join
    }
    function onInputError() { fail("NATIVE_PROBE_INPUT_FAILED"); }
    function onPipeError() { fail("NATIVE_PROBE_PIPE_FAILED"); }
    function onClose(code: number | null) {
      nativeCloseObserved = true; closeCode = code;
      if (exitCode === undefined) exitCode = code;
      flushStderr(); record({ status: "NATIVE_CLOSE_OBSERVED", ...details() });
      if (operationFailure) { finishFailure(); return; }
      if (code !== 0) { fail("NATIVE_PROBE_EXIT"); return; }
      if (remaining() <= 0) { fail("NATIVE_PROBE_DEADLINE"); return; }
      // Native exit success is not owner admission; validation still has to
      // finish inside the same absolute deadline.
      record({ status: "NATIVE_EXIT_SUCCESS", reason: "NATIVE_PROBE_EXIT", ...details() });
      let identities: WindowsBrowserProcessIdentity[];
      try {
        identities = JSON.parse(stdout.trim()) as WindowsBrowserProcessIdentity[];
        if (!Array.isArray(identities) || identities.some(identity =>
          !identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 ||
          typeof identity.birthStamp !== "string" || !/^\d+$/u.test(identity.birthStamp) ||
          typeof identity.executablePath !== "string" || typeof identity.profilePath !== "string" ||
          canonicalWindowsPath(identity.executablePath) !== canonicalWindowsPath(executable) ||
          canonicalWindowsPath(identity.profilePath) !== canonicalWindowsPath(profile))) {
          throw new Error("INVALID_IDENTITY");
        }
      } catch {
        fail(remaining() <= 0 ? "NATIVE_PROBE_DEADLINE" : "NATIVE_PROBE_RESPONSE_INVALID"); return;
      }
      if (remaining() <= 0) { fail("NATIVE_PROBE_DEADLINE"); return; }
      settled = true; releaseIo();
      record({ status: "OWNERS_VALIDATED", ...details(), ioReleased: true,
        owners: identities.map(({ pid, parentPid, birthStamp, browserProcess }) => ({ pid, parentPid, birthStamp, browserProcess })) });
      resolve(identities);
    }
    child.stderr.on("data", onStderr); child.stderr.once("end", flushStderr);
    child.stderr.once("error", onPipeError);
    child.stdout.on("data", onStdout); child.stdout.once("end", onStdoutEnd);
    child.stdout.once("error", onPipeError);
    child.once("exit", onExit); child.once("error", onError); child.once("close", onClose);
    child.stdin.once("error", onInputError);
    if (remaining() <= 0) { fail("NATIVE_PROBE_DEADLINE"); return; }
    timer.handle = setTimeout(() => {
      fail(operationFailure?.reason ?? "NATIVE_PROBE_DEADLINE"); finishFailure();
    }, Math.min(OWNER_PROBE_TIMEOUT_MS, Math.ceil(remaining())));
    try { child.stdin.end(request, "utf8"); }
    catch { fail("NATIVE_PROBE_INPUT_FAILED"); }
  });
}

export async function releaseWindowsBrowserProfileOwners(
  executablePath: string,
  profilePath: string,
  captured: WindowsBrowserProcessIdentity[],
  probe: (executablePath: string, profilePath: string, terminate?: WindowsBrowserProcessIdentity[]) =>
    WindowsBrowserProcessIdentity[] | Promise<WindowsBrowserProcessIdentity[]> = captureWindowsBrowserProfileOwners,
) {
  const current = await probe(executablePath, profilePath);
  const authorized = authorizeWindowsBrowserDescendants(current, captured);
  if (current.length) await probe(executablePath, profilePath, authorized);
  const deadline = Date.now() + 3_000;
  do {
    if ((await probe(executablePath, profilePath)).length === 0) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  throw new WindowsBrowserProfileOwnershipError("Chromium 已验证进程终止后 Profile 仍未在限定时间内释放");
}
