param(
  [Parameter(Mandatory=$true)][int]$RootPid,
  [Parameter(Mandatory=$true)][int]$CreatorPid,
  [Parameter(Mandatory=$true)][string]$ExecutablePath,
  [Parameter(Mandatory=$true)][long]$EarliestCreationMs,
  [Parameter(Mandatory=$true)][long]$LatestCreationMs,
  [int]$DeadlineMs = 60000,
  [int]$ExitDeadlineMs = 3000
)
[Console]::Out.WriteLine('{"kind":"STARTUP","stage":"SCRIPT_ENTERED"}')
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$handles = @{}
$identities = @{}
$creator = $null
$released = $false
$status = 'FAILED'
$failure = $null
$rootExitAt = $null
$sampleCount = 0
$uncertain = @{}
$remainingBeforeCleanup = @()
$remainingAfterCleanup = @()
$inputStream = $null
$cleanupErrors = @()
$protocolJson = $null
function Startup([string]$Stage) {
  [Console]::Out.WriteLine('{"kind":"STARTUP","stage":"'+$Stage+'"}')
  [Console]::Out.Flush()
}
function Test-SameCapturedBirth {
  param([long]$ExpectedStamp,[long]$ObservedStamp)
  # CIM has microsecond precision; retained native handles keep full FILETIME.
  return [decimal]::Floor([decimal]$ExpectedStamp/10) -eq [decimal]::Floor([decimal]$ObservedStamp/10)
}
function Test-CimBirthAvailable {
  param($Row)
  return $null -ne $Row -and $Row.CreationDate -is [DateTime]
}
function Emit($value) {
  # Protocol publication must not activate PowerShell Utility/module analysis
  # before READY. Ownership still uses CIM + retained native handle/birth.
  [Console]::Out.WriteLine($protocolJson.Serialize($value))
  [Console]::Out.Flush()
}
function Remember($row, $native, $parentIdentity) {
  $stamp = $native.StartTime.ToUniversalTime().ToFileTimeUtc()
  $identity = @{pid=[int]$row.ProcessId;parentPid=[int]$row.ParentProcessId;nativeStartFileTime=$stamp.ToString();
    createdAt=$native.StartTime.ToUniversalTime().ToString('o');capturedAt=[DateTime]::UtcNow.ToString('o');
    capturedElapsedMs=$clock.Elapsed.TotalMilliseconds;parentNativeStartFileTime=$parentIdentity}
  $handles[[int]$row.ProcessId] = $native
  $identities[[int]$row.ProcessId] = $identity
}
function LiveIdentities {
  return @($handles.Keys | Where-Object {!$handles[$_].HasExited} | ForEach-Object {$identities[$_]})
}
try {
  Startup ARGS_VALIDATED
  $null = [Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
  $protocolJson = [System.Web.Script.Serialization.JavaScriptSerializer]::new()
  $creator = [Diagnostics.Process]::GetProcessById($CreatorPid)
  $null = $creator.Handle
  Startup ROOT_PROCESS_OPEN_START
  $row = Get-CimInstance Win32_Process -Filter "ProcessId=$RootPid" -OperationTimeoutSec 2
  if (!$row -or $row.ParentProcessId -ne $CreatorPid -or
      ![string]::Equals([string]$row.ExecutablePath,$ExecutablePath,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'TYPEGEN_ROOT_CREATOR_OR_EXECUTABLE_MISMATCH'
  }
  if (!(Test-CimBirthAvailable $row)) { throw 'TYPEGEN_ROOT_CIM_BIRTH_UNAVAILABLE' }
  $native = [Diagnostics.Process]::GetProcessById($RootPid)
  $null = $native.Handle
  Startup ROOT_PROCESS_OPEN_READY
  $created = $native.StartTime.ToUniversalTime()
  $millis = ([DateTimeOffset]$created).ToUnixTimeMilliseconds()
  if ($native.HasExited -or $millis -lt $EarliestCreationMs -or $millis -gt $LatestCreationMs -or
      [decimal]::Floor([decimal]$created.ToFileTimeUtc()/10) -ne
      [decimal]::Floor([decimal]$row.CreationDate.ToUniversalTime().ToFileTimeUtc()/10)) {
    $native.Dispose()
    throw 'TYPEGEN_ROOT_NATIVE_BIRTH_MISMATCH'
  }
  Remember $row $native $null
  Startup ROOT_IDENTITY_BOUND
  Startup READY_EMIT_START
  Emit @{kind='READY';root=$identities[$RootPid];scope='NATIVE_HANDLE_BIRTH_FENCED_SAMPLED_DESCENDANTS_NOT_EXHAUSTIVE'}
  Startup READY_EMITTED
  # Console.In.ReadLineAsync can synchronously block in Windows PowerShell's
  # synchronized TextReader. Read the redirected pipe asynchronously instead.
  $inputStream = [Console]::OpenStandardInput()
  $inputBuffer = [byte[]]::new(64)
  $control = $inputStream.ReadAsync($inputBuffer,0,$inputBuffer.Length)
  while ($true) {
    if ($creator.HasExited) { throw 'TYPEGEN_CREATOR_EXITED' }
    if ($control.IsCompleted) {
      $length = $control.GetAwaiter().GetResult()
      $command = [Text.Encoding]::UTF8.GetString($inputBuffer,0,$length).Trim()
      if ($command -ne 'RUN') { throw 'TYPEGEN_MONITOR_ABORTED' }
      $released = $true
      Emit @{kind='ARMED';pid=$RootPid;nativeStartFileTime=$identities[$RootPid].nativeStartFileTime}
      $inputBuffer = [byte[]]::new(64)
      $control = $inputStream.ReadAsync($inputBuffer,0,$inputBuffer.Length)
    }
    if ($clock.ElapsedMilliseconds -ge $DeadlineMs) { throw 'TYPEGEN_STAGE_DEADLINE' }
    # This is sampled discovery, not a Windows Job and not exhaustive child
    # admission. Parent must still be alive with its retained native handle.
    $rows = @(Get-CimInstance Win32_Process -OperationTimeoutSec 2 |
      Select-Object ProcessId,ParentProcessId,CreationDate)
    $sampleCount++
    foreach ($candidate in $rows) {
      $pidValue = [int]$candidate.ProcessId
      if ($handles.ContainsKey($pidValue) -and !(Test-CimBirthAvailable $candidate)) {
        $uncertain[$pidValue] = @{pid=$pidValue;parentPid=[int]$candidate.ParentProcessId;
          expectedNativeStartFileTime=$identities[$pidValue].nativeStartFileTime;
          observedCimStartFileTime=$null;reason='CAPTURED_PID_CIM_BIRTH_UNAVAILABLE'}
        continue
      }
      if ($handles.ContainsKey($pidValue) -and
          !(Test-SameCapturedBirth ([long]$identities[$pidValue].nativeStartFileTime) $candidate.CreationDate.ToUniversalTime().ToFileTimeUtc())) {
        # A captured PID is not an identity. Its replacement is unknown and is
        # never admitted to old ownership or terminated through a new PID.
        $uncertain[$pidValue] = @{pid=$pidValue;parentPid=[int]$candidate.ParentProcessId;
          expectedNativeStartFileTime=$identities[$pidValue].nativeStartFileTime;
          observedCimStartFileTime=$candidate.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString();
          reason='CAPTURED_PID_REUSED_UNKNOWN_CURRENT_BIRTH'}
      }
    }
    $grew = $true
    while ($grew) {
      $grew = $false
      foreach ($candidate in $rows) {
        $pidValue = [int]$candidate.ProcessId
        $parentValue = [int]$candidate.ParentProcessId
        if ($handles.ContainsKey($pidValue) -or !$handles.ContainsKey($parentValue)) { continue }
        $parent = $handles[$parentValue]
        if ($parent.HasExited) { continue }
        $parentRow = @($rows | Where-Object {$_.ProcessId -eq $parentValue})
        if ($parentRow.Count -eq 1 -and !(Test-CimBirthAvailable $parentRow[0])) {
          $uncertain[$parentValue] = @{pid=$parentValue;reason='CAPTURED_PARENT_CIM_BIRTH_UNAVAILABLE'}
          continue
        }
        if ($parentRow.Count -ne 1 -or
            [decimal]::Floor([decimal]$parentRow[0].CreationDate.ToUniversalTime().ToFileTimeUtc()/10) -ne
            [decimal]::Floor([decimal]$parent.StartTime.ToUniversalTime().ToFileTimeUtc()/10)) { continue }
        if (!(Test-CimBirthAvailable $candidate)) {
          $uncertain[$pidValue] = @{pid=$pidValue;parentPid=$parentValue;reason='CANDIDATE_CIM_BIRTH_UNAVAILABLE'}
          continue
        }
        $owned = $null
        try {
          $owned = [Diagnostics.Process]::GetProcessById($pidValue)
          $null = $owned.Handle
          $stamp = $owned.StartTime.ToUniversalTime().ToFileTimeUtc()
          if ($owned.HasExited -or $parent.HasExited -or $stamp -lt $parent.StartTime.ToUniversalTime().ToFileTimeUtc() -or
              [decimal]::Floor([decimal]$stamp/10) -ne
              [decimal]::Floor([decimal]$candidate.CreationDate.ToUniversalTime().ToFileTimeUtc()/10)) { continue }
          Remember $candidate $owned $identities[$parentValue].nativeStartFileTime
          Emit @{kind='CAPTURED';identity=$identities[$pidValue]}
          $owned = $null
          $grew = $true
        } finally { if ($owned) { $owned.Dispose() } }
      }
    }
    # A later live child of a now-exited known parent is a residual candidate,
    # never new kill authority. Reject it instead of silently declaring zero.
    foreach ($candidate in $rows) {
      $pidValue = [int]$candidate.ProcessId
      $parentValue = [int]$candidate.ParentProcessId
      if (!$handles.ContainsKey($pidValue) -and $handles.ContainsKey($parentValue) -and
          $handles[$parentValue].HasExited -and !(Test-CimBirthAvailable $candidate)) {
        $uncertain[$pidValue] = @{pid=$pidValue;parentPid=$parentValue;reason='LATE_CHILD_CIM_BIRTH_UNAVAILABLE'}
        continue
      }
      if (!$handles.ContainsKey($pidValue) -and $handles.ContainsKey($parentValue) -and $handles[$parentValue].HasExited -and
          $candidate.CreationDate.ToUniversalTime().ToFileTimeUtc() -ge [long]$identities[$parentValue].nativeStartFileTime) {
        $uncertain[$pidValue] = @{pid=$pidValue;parentPid=$parentValue;reason='PARENT_EXITED_BEFORE_NATIVE_LINEAGE_CAPTURE'}
      }
    }
    if ($handles[$RootPid].HasExited) {
      if ($null -eq $rootExitAt) { $rootExitAt = $clock.ElapsedMilliseconds }
      $live = @(LiveIdentities)
      if ($live.Count -eq 0 -and $uncertain.Count -eq 0) { $status='PASSED'; break }
      if ($clock.ElapsedMilliseconds - $rootExitAt -ge $ExitDeadlineMs) { throw 'TYPEGEN_CAPTURED_TREE_NOT_QUIESCENT' }
    }
    # Wait on the retained handle: this is a bounded process-exit condition,
    # not an unconditional sleep used to assume that cleanup finished.
    if (!$handles[$RootPid].HasExited) { $null = $handles[$RootPid].WaitForExit(50) }
    else {
      # A child can exit between enumerations. Select once; its retained native
      # handle remains valid even if the process exits before WaitForExit.
      $liveForWait = @(LiveIdentities)
      if ($liveForWait.Count) { $null = $handles[$liveForWait[0].pid].WaitForExit(50) }
    }
  }
} catch {
  $knownFailures = @('TYPEGEN_ROOT_CREATOR_OR_EXECUTABLE_MISMATCH','TYPEGEN_ROOT_CIM_BIRTH_UNAVAILABLE',
    'TYPEGEN_ROOT_NATIVE_BIRTH_MISMATCH','TYPEGEN_CREATOR_EXITED','TYPEGEN_MONITOR_ABORTED',
    'TYPEGEN_STAGE_DEADLINE','TYPEGEN_CAPTURED_TREE_NOT_QUIESCENT')
  $failure = if ($knownFailures -contains $_.Exception.Message) { $_.Exception.Message } else { 'TYPEGEN_NATIVE_MONITOR_EXCEPTION' }
  $failureLine = $_.InvocationInfo.ScriptLineNumber
  $failureType = $_.Exception.GetType().FullName
} finally {
  $remainingBeforeCleanup = @(LiveIdentities)
  if ($status -ne 'PASSED') {
    # Only already-retained native handles with proven birth/lineage may be
    # terminated. Unknown residuals remain evidence and never grant authority.
    foreach ($identity in @($remainingBeforeCleanup | Sort-Object capturedElapsedMs -Descending)) {
      try { if (!$handles[$identity.pid].HasExited) { $handles[$identity.pid].Kill() } }
      catch { $cleanupErrors += @{pid=$identity.pid;operation='Kill';error=$_.Exception.GetType().Name} }
    }
    $cleanupUntil = $clock.ElapsedMilliseconds + $ExitDeadlineMs
    foreach ($identity in $remainingBeforeCleanup) {
      $remainingBudget = [Math]::Max(0,$cleanupUntil - $clock.ElapsedMilliseconds)
      try { $null = $handles[$identity.pid].WaitForExit([int]$remainingBudget) }
      catch { $cleanupErrors += @{pid=$identity.pid;operation='WaitForExit';error=$_.Exception.GetType().Name} }
    }
  }
  $remainingAfterCleanup = @(LiveIdentities)
  if ($protocolJson) { Emit @{kind='FINAL';status=$status;failure=$failure;released=$released;root=$identities[$RootPid];
    failureLine=$failureLine;failureType=$failureType;
    identities=@($identities.Values);sampleCount=$sampleCount;elapsedMs=$clock.Elapsed.TotalMilliseconds;
    uncertainResidualCandidates=@($uncertain.Values);remainingBeforeCleanup=$remainingBeforeCleanup;
    remainingAfterCleanup=$remainingAfterCleanup;cleanupErrors=$cleanupErrors;
    scope='NATIVE_HANDLE_BIRTH_FENCED_SAMPLED_DESCENDANTS_NOT_EXHAUSTIVE'} }
  else { [Console]::Out.WriteLine('{"kind":"FINAL","status":"FAILED","failure":"TYPEGEN_PROTOCOL_SERIALIZER_STARTUP_FAILED"}') }
  foreach ($handle in $handles.Values) { $handle.Dispose() }
  if ($creator) { $creator.Dispose() }
  if ($inputStream) { $inputStream.Dispose() }
}
if ($status -ne 'PASSED') { exit 1 } else { exit 0 }
