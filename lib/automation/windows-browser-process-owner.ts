import { spawn } from "node:child_process";
import path from "node:path";

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
  constructor(message: string) { super(message); this.name = "WindowsBrowserProfileOwnershipError"; }
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

const nativeArgumentParser = `
using System;
using System.Runtime.InteropServices;
public static class VeridiaBrowserArgv {
  [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string command, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
  public static string[] Parse(string command) {
    int count; IntPtr argv = CommandLineToArgvW(command, out count);
    if (argv == IntPtr.Zero) throw new InvalidOperationException("ARGV_FAILED");
    try { var values = new string[count]; for (int i=0; i<count; i++) values[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size)); return values; }
    finally { LocalFree(argv); }
  }
}`;

function guardScript(input: {
  executablePath: string;
  profilePath: string;
  terminate?: WindowsBrowserProcessIdentity[];
}) {
  const encoded = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  // Only exact executable/profile matches leave this process. Raw command
  // lines, environment, browser URLs and credentials are never emitted.
  return `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'
${nativeArgumentParser}
'@;
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json;
$expectedExecutable = [IO.Path]::GetFullPath($request.executablePath);
$expectedProfile = [IO.Path]::GetFullPath($request.profilePath).TrimEnd('\\');
$owned = @(); $handles = @();
try {
  $name = [IO.Path]::GetFileName($expectedExecutable).Replace("'", "''");
  foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name='$name'")) {
    if (![string]::Equals($candidate.ExecutablePath, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase)) { continue }
    if (!$candidate.CommandLine -or !$candidate.CreationDate) { throw 'PROFILE_OWNERSHIP_UNAVAILABLE' }
    $argv = [VeridiaBrowserArgv]::Parse($candidate.CommandLine);
    $profiles = @($argv | Where-Object { $_.StartsWith('--user-data-dir=', [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.Substring(16) });
    if ($profiles.Count -ne 1 -or !$profiles[0]) { continue }
    if (![string]::Equals([IO.Path]::GetFullPath($profiles[0]).TrimEnd('\\'), $expectedProfile, [StringComparison]::OrdinalIgnoreCase)) { continue }
    try { $process = [Diagnostics.Process]::GetProcessById([int]$candidate.ProcessId); $null = $process.Handle } catch {
      if (Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)") { throw 'LIVE_PROCESS_HANDLE_UNAVAILABLE' }
      continue
    }
    $birthStamp = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString();
    $cimStamp = $candidate.CreationDate.ToUniversalTime().ToFileTimeUtc();
    if ([decimal]::Floor([decimal]$birthStamp / 10) -ne [decimal]::Floor([decimal]$cimStamp / 10)) {
      $process.Dispose();
      if (Get-CimInstance Win32_Process -Filter "ProcessId=$($candidate.ProcessId)") { throw 'LIVE_PROCESS_BIRTH_MISMATCH' }
      continue
    }
    $isBrowser = @($argv | Where-Object { $_.StartsWith('--type=', [StringComparison]::OrdinalIgnoreCase) }).Count -eq 0;
    $identity = @{pid=[int]$candidate.ProcessId; parentPid=[int]$candidate.ParentProcessId; browserProcess=$isBrowser; birthStamp=$birthStamp; executablePath=$expectedExecutable; profilePath=$expectedProfile};
    $owned += $identity;
    if ($request.terminate) {
      $match = @($request.terminate | Where-Object { $_.pid -eq $identity.pid -and $_.birthStamp -eq $birthStamp -and [string]::Equals($_.executablePath, $expectedExecutable, [StringComparison]::OrdinalIgnoreCase) -and [string]::Equals($_.profilePath.TrimEnd('\\'), $expectedProfile, [StringComparison]::OrdinalIgnoreCase) });
      if ($match.Count -ne 1) { $process.Dispose(); throw 'UNVERIFIED_PROFILE_OWNER' }
      $handles += $process;
    } else { $process.Dispose() }
  }
  # All identities are validated before any termination. Process.Handle was
  # opened before StartTime; Kill therefore targets that OS handle, not a PID
  # which may have been reused between validation and termination.
  foreach ($process in $handles) { if (!$process.HasExited) { $process.Kill() } }
  ConvertTo-Json -InputObject @($owned) -Depth 4 -Compress
} finally { foreach ($process in $handles) { $process.Dispose() } }`;
}

export async function captureWindowsBrowserProfileOwners(
  executablePath: string,
  profilePath: string,
  terminate?: WindowsBrowserProcessIdentity[],
) {
  const executable = path.win32.resolve(executablePath);
  const profile = path.win32.resolve(profilePath);
  const script = guardScript({ executablePath: executable, profilePath: profile, terminate });
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    let settled = false;
    const finish = (value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value !== undefined) resolve(value);
      else reject(new WindowsBrowserProfileOwnershipError("Chromium 物理 Profile 所有权检查失败，禁止复用未验证的 Profile"));
    };
    const timer = setTimeout(() => { child.kill(); finish(); }, OWNER_PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); if (stdout.length > 100_000) { child.kill(); finish(); } });
    child.once("error", () => finish());
    child.once("close", code => finish(code === 0 ? stdout : undefined));
  });
  let identities: WindowsBrowserProcessIdentity[];
  try { identities = JSON.parse(output.trim()) as WindowsBrowserProcessIdentity[]; }
  catch { throw new WindowsBrowserProfileOwnershipError("Chromium 物理 Profile 所有权响应无效"); }
  if (!Array.isArray(identities) || identities.some(identity =>
    !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !/^\d+$/u.test(identity.birthStamp) ||
    canonicalWindowsPath(identity.executablePath) !== canonicalWindowsPath(executable) ||
    canonicalWindowsPath(identity.profilePath) !== canonicalWindowsPath(profile))) {
    throw new WindowsBrowserProfileOwnershipError("Chromium 物理 Profile 所有权响应无效");
  }
  return identities;
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
