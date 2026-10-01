param(
  [Parameter(Mandatory=$true)][string]$SourcePath,
  [Parameter(Mandatory=$true)][string]$RunId,
  [Parameter(Mandatory=$true)][string]$ObserverId,
  [Parameter(Mandatory=$true)][int]$WrapperPid,
  [Parameter(Mandatory=$true)][string]$WrapperCreatedAt,
  [Parameter(Mandatory=$true)][int]$Port
)
# Persistent read-only periodic provider. No WMI, database, navigation, kill or retry.
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$sequence=0
$providerClock=[Diagnostics.Stopwatch]::StartNew()
$self=$null
function Emit($frame) { [Console]::Out.WriteLine(($frame | ConvertTo-Json -Depth 7 -Compress)); [Console]::Out.Flush() }
function Identity($event) { return @{event=$event;runId=$RunId;observerId=$ObserverId;wrapperPid=$WrapperPid;providerPid=$PID;port=$Port;
  providerParentPid=$(if($self){$self.parentPid}else{$null});providerNativeBirthStamp=$(if($self){$self.nativeBirthStamp}else{$null});
  callerWrapperNativeBirthStamp=$(if($self){$self.callerWrapperNativeBirthStamp}else{$null});
  callerWrapperCanonicalBirth=$WrapperCreatedAt} }
function ReadBoundedLine {
  $text=New-Object Text.StringBuilder
  while($true) {
    $value=[Console]::In.Read()
    if($value -eq -1) { if($text.Length -ne 0){throw 'PROVIDER_PARTIAL_COMMAND_AT_EOF'};return $null }
    if($value -eq 10) { return $text.ToString() }
    if($text.Length -ge 4096) { throw 'PROVIDER_COMMAND_TOO_LARGE' }
    $null=$text.Append([char]$value)
  }
}
function IsInteger($value) { return ($value -is [int] -or $value -is [long]) }
function SafeFailureCategory($record) {
  # Exact fixed codes only. Never emit exception text, command lines or source.
  $known=@(
    'NATIVE_LAYOUT_UNSUPPORTED','NATIVE_NTDLL_UNAVAILABLE','NATIVE_BASIC_EXPORT_UNAVAILABLE',
    'NATIVE_QUERY_DEADLINE','NATIVE_HANDLE_UNAVAILABLE','NATIVE_HELD_PID_MISMATCH',
    'NATIVE_BASIC_ABI_UNSUPPORTED','NATIVE_HELD_BASIC_INVALID','NATIVE_HELD_BIRTH_UNAVAILABLE',
    'NATIVE_HELD_IMAGE_UNAVAILABLE','NATIVE_HELD_NAME_INVALID','NATIVE_PROCESS_HANDLE_CLOSE_FAILED',
    'NATIVE_RETAINED_IDENTITY_RECHECK_FAILED','NATIVE_RETAINED_LIVENESS_RECHECK_FAILED',
    'NATIVE_PROVIDER_CALLER_IDENTITY_MISMATCH','NATIVE_PROCESS_SNAPSHOT_FAILED',
    'NATIVE_PROCESS_FIRST_FAILED','NATIVE_PROCESS_ROW_INVALID','NATIVE_PROCESS_ITERATION_INCOMPLETE',
    'NATIVE_PROCESS_EMPTY_INVENTORY','NATIVE_SNAPSHOT_CLOSE_FAILED','NATIVE_TCP_TABLE_FAILED',
    'NATIVE_TCP_TABLE_BOUNDS_INVALID','NATIVE_TCP_ROW_INVALID','NATIVE_QUERY_INPUT_INVALID',
    'PROVIDER_INPUT_INVALID','PROVIDER_PARTIAL_COMMAND_AT_EOF','PROVIDER_COMMAND_TOO_LARGE',
    'PROVIDER_COMMAND_BINDING_INVALID',
    'SPI_SYSTEM_EXPORT_UNAVAILABLE','SPI_VERSION_EXPORT_UNAVAILABLE','SPI_UNAPPROVED_OS_ABI',
    'SPI_PROVIDER_BINDING_ALREADY_ESTABLISHED','SPI_PROVIDER_BINDING_UNAVAILABLE',
    'SPI_IMAGE_NAME_INVALID','SPI_IMAGE_UTF16_INVALID','SPI_RETURN_LENGTH_INVALID','SPI_ENTRY_BOUNDS_INVALID',
    'SPI_THREAD_OR_NEXT_BOUNDS_INVALID','SPI_INVENTORY_LIMIT_EXCEEDED','SPI_PID_INVALID_OR_DUPLICATE',
    'SPI_IDLE_SENTINEL_INVALID','SPI_UNICODE_BOUNDS_INVALID','SPI_BIRTH_OUTSIDE_CAPTURE_UTC_BOUND',
    'SPI_EMPTY_INVENTORY','SPI_QUERY_NTSTATUS_FAILED','SPI_SELECTED_HELD_BINDING_MISMATCH','SPI_WORKING_SET_UNREPRESENTABLE',
    'SPI_SELECTED_HELD_COUNT_INVALID','SPI_SELECTED_SNAPSHOT_MISMATCH',
    'SPI_PRECISE_UTC_EXPORT_UNAVAILABLE','SPI_PRECISE_UTC_BOUND_INVALID'
  )
  $exception=$record.Exception
  for($depth=0;$depth -lt 4 -and $null -ne $exception;$depth++) {
    if($known -ccontains [string]$exception.Message) { return [string]$exception.Message }
    $exception=$exception.InnerException
  }
  return 'UNKNOWN_NATIVE_OR_PROTOCOL_FAILURE'
}
function SafeSecondaryHandleReleaseFailure($record) {
  $exception=$record.Exception
  for($depth=0;$depth -lt 4 -and $null -ne $exception;$depth++) {
    if($exception.Data['secondaryHandleReleaseFailure'] -ceq 'NATIVE_PROCESS_HANDLE_CLOSE_FAILED') {
      return 'NATIVE_PROCESS_HANDLE_CLOSE_FAILED'
    }
    $exception=$exception.InnerException
  }
  return $null
}
function SafeBirthGuardFailure($record) {
  # Exact numeric/string provenance only; no arbitrary exception Data, names,
  # paths, commands or machine inventory. Invalid evidence is not trusted.
  $exception=$record.Exception
  for($depth=0;$depth -lt 4 -and $null -ne $exception;$depth++) {
    $value=$exception.Data['birthGuardFailure']
    if($null -ne $value) {
      if($value.Count -ne 6 -or $value.branch -cnotin @('NON_POSITIVE_BIRTH','AFTER_PRECISE_UTC_BOUND') -or
         $value.clockSource -cne 'GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME' -or
         $value.pid -isnot [int] -or $value.pid -lt 1 -or $value.parentPid -isnot [int] -or $value.parentPid -lt 0 -or
         $value.creationSigned -isnot [string] -or $value.creationSigned -notmatch '^-?\d{1,19}$' -or
         $value.utcBirthUpperBound -isnot [string] -or $value.utcBirthUpperBound -notmatch '^\d{1,19}$') { return $null }
      [long]$birth=0;[long]$bound=0
      if(![long]::TryParse($value.creationSigned,[ref]$birth) -or
         ![long]::TryParse($value.utcBirthUpperBound,[ref]$bound) -or $bound -le 0) { return $null }
      try { $null=[DateTime]::FromFileTimeUtc($bound) } catch { return $null }
      if(($value.branch -ceq 'NON_POSITIVE_BIRTH' -and $birth -gt 0) -or
         ($value.branch -ceq 'AFTER_PRECISE_UTC_BOUND' -and $birth -le $bound)) { return $null }
      return @{branch=$value.branch;pid=$value.pid;parentPid=$value.parentPid;creationSigned=$value.creationSigned;
        utcBirthUpperBound=$value.utcBirthUpperBound;clockSource='GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME'}
    }
    $exception=$exception.InnerException
  }
  return $null
}
try {
  if($RunId -notmatch '^[A-Za-z0-9_.-]{1,256}$' -or $ObserverId -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
     $Port -lt 1 -or $Port -gt 65535 -or $WrapperPid -lt 1 -or $WrapperCreatedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$') { throw 'PROVIDER_INPUT_INVALID' }
  Add-Type -TypeDefinition ([IO.File]::ReadAllText($SourcePath))
  $self=[VeridiaWmiFreeRuntime]::VerifyProvider($WrapperPid,$WrapperPid,$WrapperCreatedAt)
  $ready=Identity 'READY';$ready.providerCreatedAt=$self.createdAt
  Emit $ready
  while($null -ne ($line=ReadBoundedLine)) {
    $command=$line | ConvertFrom-Json
    if($command.command -ne 'QUERY' -or $command.runId -cne $RunId -or $command.observerId -cne $ObserverId -or
       $command.wrapperPid -ne $WrapperPid -or $command.providerPid -ne $PID -or $command.port -ne $Port -or
       !(IsInteger $command.wrapperPid) -or !(IsInteger $command.providerPid) -or !(IsInteger $command.port) -or !(IsInteger $command.sequence) -or
       $command.sequence -ne ($sequence+1) -or !(IsInteger $command.remainingMs) -or $command.remainingMs -lt 1 -or $command.remainingMs -gt 15000) { throw 'PROVIDER_COMMAND_BINDING_INVALID' }
    $sequence=$command.sequence
    $frame=Identity 'QUERY_RESULT';$frame.sequence=$sequence;$frame.runtime=$null;$frame.error=$null
    $queryClock=[Diagnostics.Stopwatch]::StartNew()
    try { $frame.runtime=[VeridiaWmiFreeRuntime]::Capture($Port,$command.remainingMs);$frame.providerElapsedMs=$queryClock.Elapsed.TotalMilliseconds }
    catch {
      $frame.nativeErrorCategory=SafeFailureCategory $_;$frame.nativeSecondaryErrorCategory=SafeSecondaryHandleReleaseFailure $_
      if($frame.nativeErrorCategory -ceq 'SPI_BIRTH_OUTSIDE_CAPTURE_UTC_BOUND') { $frame.birthGuardFailure=SafeBirthGuardFailure $_ }
      $frame.error='NATIVE_CENSUS_FAILED_NO_FALLBACK';$frame.providerElapsedMs=$queryClock.Elapsed.TotalMilliseconds;Emit $frame;exit 1
    }
    Emit $frame
  }
  # EOF is requested by the creator only after its one pending query is settled.
  # This receipt is not a join; the client must also observe natural close code0.
  $eof=Identity 'EOF_ACK';$eof.sequence=$sequence;$eof.eofObserved=$true;$eof.providerElapsedMs=$providerClock.Elapsed.TotalMilliseconds;Emit $eof
  exit 0
} catch {
  $failure=Identity 'FAILED';$failure.sequence=$sequence;$failure.error='PROVIDER_SETUP_OR_PROTOCOL_FAILED';$failure.nativeErrorCategory=SafeFailureCategory $_;$failure.nativeSecondaryErrorCategory=SafeSecondaryHandleReleaseFailure $_;Emit $failure
  exit 1
}
