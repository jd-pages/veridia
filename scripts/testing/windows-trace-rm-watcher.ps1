param(
  [Parameter(Mandatory=$true)][string]$Configuration,
  [ValidateSet('Supervisor','Guardian','Worker')][string]$Role = 'Supervisor',
  [switch]$BootstrapProbe
)
[Console]::Out.WriteLine('VERIDIA_NATIVE_SCRIPT_ENTERED='+$Role+':'+$PID)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
function Bootstrap-Stage([string]$Stage) {
  [Console]::Out.WriteLine('VERIDIA_NATIVE_BOOTSTRAP_STAGE='+$Role+':'+$PID+':'+$Stage)
}
Bootstrap-Stage UTF8_ENCODING_START
$utf8 = New-Object Text.UTF8Encoding $false
Bootstrap-Stage UTF8_ENCODING_READY
Bootstrap-Stage CONFIG_READ_START
$configurationText = Get-Content -LiteralPath $Configuration -Raw
Bootstrap-Stage CONFIG_READ_READY
Bootstrap-Stage CONFIG_PARSE_START
$cfg = $configurationText | ConvertFrom-Json
Bootstrap-Stage CONFIG_PARSE_READY
$directory = [IO.Path]::GetFullPath($cfg.directory)
$target = [IO.Path]::GetFullPath($cfg.target)
$watch = [Diagnostics.Stopwatch]::StartNew()
function Utc { [DateTime]::UtcNow.ToString('o') }
function Qpc { [Diagnostics.Stopwatch]::GetTimestamp().ToString() }
function Bound-Record($Record) {
  $Record.invocationId = $cfg.invocationId; $Record.nonce = $cfg.nonce
  $Record.target = $target; $Record.supportIdentity = $cfg.supportIdentity
  $Record.utc = Utc; $Record.qpcTicks = Qpc
  $Record.qpcFrequency = [Diagnostics.Stopwatch]::Frequency.ToString()
  $Record.label = $cfg.label
  $Record.emitterRole = $Role; $Record.emitterPid = $PID; $Record.emitterNativeStartFileTime = $selfBirth
  return $Record
}
function New-Json([string]$Name, $Record) {
  $bytes = $utf8.GetBytes(((Bound-Record $Record) | ConvertTo-Json -Depth 18 -Compress) + "`n")
  if ($bytes.Length -gt 262144) { throw 'DIAGNOSTIC_RECORD_CAP' }
  $temporary = [IO.Path]::Combine($directory,$Name+'.'+$Role+'.writing')
  $file = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  $primary = $null
  try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } catch { $primary=$_.Exception;throw }
  finally { try{$file.Dispose()}catch{if($primary){$primary.Data['closeFailure']=$_.Exception.GetType().FullName}else{throw}} }
  [IO.File]::Move($temporary,[IO.Path]::Combine($directory,$Name))
}
function Read-Record([string]$Name) {
  $file = [IO.Path]::Combine($directory,$Name)
  if (-not [IO.File]::Exists($file)) { return $null }
  $r = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  if ($r.invocationId -ne $cfg.invocationId -or $r.nonce -ne $cfg.nonce -or $r.target -ne $target -or $r.supportIdentity -ne $cfg.supportIdentity) { throw 'CONTROL_IDENTITY_MISMATCH' }
  return $r
}
function Stop-Present { return $null -ne (Read-Record 'stop.json') }
function Safe-Text([string]$Value) {
  if (-not $Value) { return $null }
  $v = [regex]::Replace($Value,'(?is)-----BEGIN.*?PRIVATE KEY-----.*?-----END.*?PRIVATE KEY-----','[REDACTED]')
  $v = [regex]::Replace($v,'(?i)(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)','[REDACTED]')
  $v = [regex]::Replace($v,'(?i)(bearer\s+)\S+','$1[REDACTED]')
  $v = [regex]::Replace($v,'(?i)([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\/\s@]+@','$1[REDACTED]@')
  $v = [regex]::Replace($v,'(?i)((?:--?|/)?[A-Za-z0-9_]*(?:api[_-]?key|secret|password|passwd|pwd|token|credential|authorization|connection[_-]?string|database[_-]?url)[A-Za-z0-9_-]*["'']?\s*(?:=|:|\s)\s*)(?:"[^"]*"|''[^'']*''|[^\s;]+)','$1[REDACTED]')
  # Never retain any payload after inline/encoded-program flags, including spaces.
  $v = [regex]::Replace($v,'(?i)((?:--?(?:encodedcommand|encodedarguments|eval|command|e|c)|/(?:c|k))["'']?(?:\s+|=|:)).*','$1[REDACTED_INLINE_PROGRAM]')
  $v = [regex]::Replace($v,'(?i)([?&](?:key|code|auth|access_token|token|password|secret)=)[^&\s]+','$1[REDACTED]')
  if ($v.Length -gt 8192) { $v = $v.Substring(0,8192) + '[TRUNCATED]' }
  return $v
}
Bootstrap-Stage CONFIG_VALIDATE_START
if ($cfg.schemaVersion -ne 1 -or $cfg.invocationId -notmatch '^[0-9a-f-]{36}$' -or $cfg.nonce -notmatch '^[0-9a-f-]{36}$') { throw 'CONFIGURATION_IDENTITY_INVALID' }
if ($directory -ne [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Configuration))) { throw 'CONFIGURATION_DIRECTORY_INVALID' }
if ($cfg.label -eq 'FORMAL_VERIFY_TRACE') {
  if ($target -ne [IO.Path]::Combine([IO.Path]::GetFullPath($cfg.root),'.next\trace') -or $cfg.leaseMs -ne 660000 -or $cfg.fixtureMode -ne 'NORMAL') { throw 'FORMAL_SCOPE_INVALID' }
} elseif ($cfg.label -eq 'SYNTHETIC_TOOL_VALIDATION') {
  if ($directory -notmatch '[\\/]\.playwright[\\/]build-lock-diagnostics-fixtures[\\/]lab-[0-9a-f-]{36}[\\/]run-[0-9a-f-]{36}$' -or [IO.Path]::GetDirectoryName($target) -ne [IO.Path]::GetDirectoryName($directory)) { throw 'FIXTURE_SCOPE_INVALID' }
} else { throw 'LABEL_INVALID' }
Bootstrap-Stage CONFIG_VALIDATE_READY

# Fixed low-volume startup notices, consumed privately by the owning controller.
# They cannot prove native identity/readiness and contain no raw env or errors.
function Ready-Stage([string]$Stage) {
  $r=[ordered]@{invocationId=$cfg.invocationId;nonce=$cfg.nonce;supportIdentity=$cfg.supportIdentity;role=$Role;pid=$PID;stage=$Stage;utc=Utc;qpcTicks=Qpc;qpcFrequency=[Diagnostics.Stopwatch]::Frequency.ToString()}
  [Console]::Out.WriteLine('VERIDIA_NATIVE_READY_STAGE='+($r|ConvertTo-Json -Compress))
}
Ready-Stage CONFIG_VALIDATED
if ($BootstrapProbe) {
  if ($cfg.label -ne 'SYNTHETIC_TOOL_VALIDATION') { throw 'BOOTSTRAP_PROBE_REQUIRES_SYNTHETIC_SCOPE' }
  exit 0
}

# Ownership operations use the exact retained native handle. GetProcessById or
# a future PID lookup is never the stop authority. No target file is opened.
Ready-Stage ADD_TYPE_START
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class VeridiaBuildRmNative {
  [StructLayout(LayoutKind.Sequential)] public struct FT { public uint Low,High; public ulong Value { get { return ((ulong)High<<32)|Low; } } }
  [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr R1,Peb,R20,R21,Pid,Parent; }
  [DllImport("kernel32.dll",SetLastError=true)] public static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool GetProcessTimes(IntPtr handle,out FT creation,out FT exit,out FT kernel,out FT user);
  [DllImport("kernel32.dll")] public static extern uint GetProcessId(IntPtr handle);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll",SetLastError=true)] public static extern bool TerminateProcess(IntPtr handle,uint code);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle,int info,out PBI basic,int length,out int returned);
  public static string Birth(IntPtr h) { FT c,e,k,u; if (!GetProcessTimes(h,out c,out e,out k,out u)) throw new Exception("NATIVE_BIRTH_UNAVAILABLE"); return c.Value.ToString(); }
  public static uint Parent(IntPtr h) { PBI b; int n; if (NtQueryInformationProcess(h,0,out b,Marshal.SizeOf(typeof(PBI)),out n)!=0) throw new Exception("NATIVE_PARENT_UNAVAILABLE"); return (uint)b.Parent.ToInt64(); }
  public static IntPtr Enroll(uint pid,string birth,uint parent,bool terminate) {
    IntPtr h=OpenProcess(0x100000|0x1000|(terminate?1u:0u),false,pid);
    if(h==IntPtr.Zero) throw new Exception("NATIVE_ENROLL_UNAVAILABLE");
    try { if(GetProcessId(h)!=pid || (!String.IsNullOrEmpty(birth) && Birth(h)!=birth) || Parent(h)!=parent || WaitForSingleObject(h,0)!=258) throw new Exception("NATIVE_IDENTITY_MISMATCH"); return h; }
    catch {CloseHandle(h); throw;}
  }
  public static bool Eof;
  public static void WatchEof() { var t=new Thread(()=>{try {while(Console.In.Read()!=-1) {} } catch {} Eof=true;}); t.IsBackground=true;t.Start(); }
  [StructLayout(LayoutKind.Sequential)] public struct Unique { public uint Pid;public FT Birth; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Info {
    public Unique Process;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=256)] public string Name;
    [MarshalAs(UnmanagedType.ByValTStr,SizeConst=64)] public string Service;
    public uint Type,Status,Session;[MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  public class Result { public int Error,Calls;public uint Needed;public double Ms;public Info[] Users; }
  [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] public static extern int RmStartSession(out uint session,uint flags,StringBuilder key);
  [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] public static extern int RmRegisterResources(uint session,uint files,string[] paths,uint apps,IntPtr applications,uint services,IntPtr serviceNames);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint session,out uint needed,ref uint count,[In,Out]Info[] users,ref uint reboot);
  [DllImport("rstrtmgr.dll")] public static extern int RmEndSession(uint session);
  public static Result Query(uint session) {
    var w=Stopwatch.StartNew();var r=new Result();uint capacity=64;
    for(int i=0;i<4;i++){uint count=capacity,needed,reboot=0;var a=new Info[capacity];r.Error=RmGetList(session,out needed,ref count,a,ref reboot);r.Calls++;r.Needed=needed;
      if(r.Error==234 && needed>0 && needed<=4096){capacity=needed;continue;}
      if(r.Error==0){r.Users=new Info[count];Array.Copy(a,r.Users,count);}break;}
    if(r.Users==null)r.Users=new Info[0];r.Ms=w.Elapsed.TotalMilliseconds;return r;
  }
}
'@
Ready-Stage ADD_TYPE_END
[VeridiaBuildRmNative]::WatchEof()
$self = [VeridiaBuildRmNative]::OpenProcess(0x100000 -bor 0x1000,$false,[uint32]$PID)
if ($self -eq [IntPtr]::Zero) { throw 'SELF_NATIVE_HANDLE_UNAVAILABLE' }
$selfBirth = [VeridiaBuildRmNative]::Birth($self)
$selfParent = [VeridiaBuildRmNative]::Parent($self)
Ready-Stage SELF_BOUND
$nodeHandle = [IntPtr]::Zero
$workerHandle = [IntPtr]::Zero
$supervisorHandle = [IntPtr]::Zero
$failure = $null
$forced = $false
$workerExited = $false
$reason = 'UNEXPECTED_EXIT'
$leaseDeadline = [long]0
$workerIdentity = $null
try {
  if ($Role -eq 'Supervisor') {
    if ($selfParent -ne $cfg.creatorPid) { throw 'SUPERVISOR_CREATOR_MISMATCH' }
    $nodeHandle = [VeridiaBuildRmNative]::Enroll([uint32]$cfg.creatorPid,$null,[uint32]$cfg.creatorParentPid,$false)
    $remainingMs = ([DateTime]::Parse($cfg.leaseDeadlineUtc).ToUniversalTime() - [DateTime]::UtcNow).TotalMilliseconds
    if ($remainingMs -le 0 -or $remainingMs -gt $cfg.leaseMs) { throw 'LEASE_START_CLOCK_UNAVAILABLE' }
    $leaseDeadline = [Diagnostics.Stopwatch]::GetTimestamp() + [long]($remainingMs * [Diagnostics.Stopwatch]::Frequency / 1000)
    Ready-Stage SUPERVISOR_ENROLLED
    New-Json 'supervisor-created.json' ([ordered]@{event='supervisor-created';pid=$PID;nativeStartFileTime=$selfBirth;parentPid=$selfParent;creatorNativeStartFileTime=[VeridiaBuildRmNative]::Birth($nodeHandle);leaseDeadlineQpc=$leaseDeadline.ToString()})
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName = [IO.Path]::Combine($PSHOME,'powershell.exe');$psi.UseShellExecute=$false;$psi.CreateNoWindow=$true
    $args = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$PSCommandPath,'-Configuration',$Configuration,'-Role','Worker')
    $psi.Arguments = (@($args | ForEach-Object { if($_ -match '["\r\n]'){throw 'ARGUMENT_INVALID'}; '"'+$_+'"' }) -join ' ')
    Ready-Stage WORKER_SPAWN_START
    $worker = [Diagnostics.Process]::Start($psi)
    Ready-Stage WORKER_SPAWN_RETURN
    $workerBirth = $worker.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
    $workerHandle = [VeridiaBuildRmNative]::Enroll([uint32]$worker.Id,$workerBirth,[uint32]$PID,$true)
    $workerIdentity = @{pid=$worker.Id;nativeStartFileTime=$workerBirth;parentPid=$PID}
    Ready-Stage WORKER_ENROLLED
    New-Json 'worker-created.json' ([ordered]@{event='worker-created';pid=$worker.Id;nativeStartFileTime=$workerBirth;parentPid=$PID;supervisorNativeStartFileTime=$selfBirth;creatorNativeStartFileTime=[VeridiaBuildRmNative]::Birth($nodeHandle);leaseDeadlineQpc=$leaseDeadline.ToString()})
  } else {
    Ready-Stage WAIT_WORKER_CREATED
    while (-not ($workerIdentity = Read-Record 'worker-created.json')) {
      if ($watch.ElapsedMilliseconds -gt $cfg.readyMs -or [VeridiaBuildRmNative]::Eof) { throw 'ENROLLMENT_DEADLINE_OR_EOF' }
      [Threading.Thread]::Sleep(25)
    }
    Ready-Stage WORKER_CREATED_OBSERVED
    $leaseDeadline = [long]$workerIdentity.leaseDeadlineQpc
    if ($workerIdentity.qpcFrequency -ne [Diagnostics.Stopwatch]::Frequency.ToString()) { throw 'NATIVE_CLOCK_DOMAIN_MISMATCH' }
    if ($Role -eq 'Guardian') {
      if ($selfParent -ne $cfg.creatorPid) { throw 'GUARDIAN_CREATOR_MISMATCH' }
      $nodeHandle = [VeridiaBuildRmNative]::Enroll([uint32]$cfg.creatorPid,$workerIdentity.creatorNativeStartFileTime,[uint32]$cfg.creatorParentPid,$false)
      $supervisorHandle = [VeridiaBuildRmNative]::Enroll([uint32]$workerIdentity.parentPid,$workerIdentity.supervisorNativeStartFileTime,[uint32]$cfg.creatorPid,$false)
      $workerHandle = [VeridiaBuildRmNative]::Enroll([uint32]$workerIdentity.pid,$workerIdentity.nativeStartFileTime,[uint32]$workerIdentity.parentPid,$true)
      Ready-Stage GUARDIAN_ENROLLED
      New-Json 'guardian-armed.json' ([ordered]@{event='guardian-armed';pid=$PID;nativeStartFileTime=$selfBirth;parentPid=$selfParent;workerPid=$workerIdentity.pid;workerNativeStartFileTime=$workerIdentity.nativeStartFileTime;workerHandleHeld=$true;supervisorNativeStartFileTime=$workerIdentity.supervisorNativeStartFileTime})
    } else {
      if ($PID -ne $workerIdentity.pid -or $selfBirth -ne $workerIdentity.nativeStartFileTime -or $selfParent -ne $workerIdentity.parentPid) { throw 'WORKER_CREATED_IDENTITY_MISMATCH' }
    }
  }

  if ($Role -ne 'Worker') {
    $stopAt = $null
    while ([VeridiaBuildRmNative]::WaitForSingleObject($workerHandle,0) -eq 258) {
      $nowQpc = [Diagnostics.Stopwatch]::GetTimestamp()
      if ($null -eq $stopAt) {
        if (Stop-Present) { $reason='STOP_SIGNAL';$stopAt=$nowQpc }
        elseif ($nowQpc -ge $leaseDeadline) { $reason='LEASE_EXPIRED';$stopAt=$nowQpc }
        elseif ([VeridiaBuildRmNative]::Eof -or [VeridiaBuildRmNative]::WaitForSingleObject($nodeHandle,0) -ne 258) { $reason='CREATOR_EXIT_OR_CONTROL_EOF';$stopAt=$nowQpc }
        elseif ($Role -eq 'Guardian' -and [VeridiaBuildRmNative]::WaitForSingleObject($supervisorHandle,0) -ne 258) { $reason='SUPERVISOR_EXITED';$stopAt=$nowQpc }
        if ($null -ne $stopAt -and -not (Stop-Present)) {
          try { New-Json 'stop.json' ([ordered]@{event='stop';reason=$reason}) } catch { if(-not (Stop-Present)){throw} }
        }
      }
      if ($null -ne $stopAt -and ($nowQpc-$stopAt)*1000/[Diagnostics.Stopwatch]::Frequency -ge $cfg.graceMs) {
        $forced=$true
        if ([VeridiaBuildRmNative]::WaitForSingleObject($workerHandle,0) -eq 258 -and -not [VeridiaBuildRmNative]::TerminateProcess($workerHandle,231)) {
          # Another enrolled supervisor may have just terminated the same
          # incarnation. Preserve the native error; never retry termination or
          # reopen by PID. Only this still-held handle can confirm physical exit.
          $failure='HELD_WORKER_TERMINATE_NATIVE_ERROR_'+[Runtime.InteropServices.Marshal]::GetLastWin32Error()
        }
        if ([VeridiaBuildRmNative]::WaitForSingleObject($workerHandle,[uint32]$cfg.finalMs) -ne 0) { throw 'HELD_WORKER_EXIT_UNCONFIRMED' }
        break
      }
      [Threading.Thread]::Sleep(25)
    }
    $workerExited = [VeridiaBuildRmNative]::WaitForSingleObject($workerHandle,0) -eq 0
    if ($reason -eq 'UNEXPECTED_EXIT' -and (Stop-Present)) { $reason='STOP_SIGNAL' }
    if ($Role -eq 'Guardian') {
      New-Json 'worker-exit-proof.json' ([ordered]@{event='WORKER_EXITED_BOUND_HANDLE';pid=$workerIdentity.pid;nativeStartFileTime=$workerIdentity.nativeStartFileTime;workerExited=$workerExited;forced=$forced;reason=$reason;guardianPid=$PID;guardianNativeStartFileTime=$selfBirth;proof='SAME_PREARMED_NATIVE_HANDLE_WAIT_SIGNALED'})
      if ($cfg.fixtureMode -eq 'STALL_GUARDIAN_AFTER_PROOF') { [Threading.Thread]::Sleep(60000) }
    }
  } else {
    $samples=0;$changes=0;$queryErrors=0;$maxGap=0.0;$maxQuery=0.0;$queryTotal=0.0;$lastStart=$null;$lastState=$null;$lastEnd=$null;$bytesWritten=0
    $startedAt = Utc;$metadataCache=@{};$rmStarted=$false;[uint32]$rmSession=0;$endResult=$null
    try {
      while ([Diagnostics.Stopwatch]::GetTimestamp() -lt $leaseDeadline) {
        if ((Stop-Present) -and $cfg.fixtureMode -ne 'IGNORE_STOP') { $reason='STOP_SIGNAL';break }
        if ($cfg.fixtureMode -eq 'IGNORE_STOP' -and $samples -gt 0) { [Threading.Thread]::Sleep(25);continue }
        $startTicks=[Diagnostics.Stopwatch]::GetTimestamp();$startUtc=Utc
        $gap=$null;if($null -ne $lastStart){$gap=($startTicks-$lastStart)*1000/[Diagnostics.Stopwatch]::Frequency;$maxGap=[math]::Max($maxGap,$gap)};$lastStart=$startTicks
        if($samples -eq 0){Ready-Stage FIRST_RM_START}
        $key=New-Object Text.StringBuilder 33
        $startResult=[VeridiaBuildRmNative]::RmStartSession([ref]$rmSession,0,$key)
        if($startResult -ne 0){throw ('RM_START_'+$startResult)};$rmStarted=$true
        $registerResult=[VeridiaBuildRmNative]::RmRegisterResources($rmSession,1,@($target),0,[IntPtr]::Zero,0,[IntPtr]::Zero)
        if($registerResult -ne 0){throw ('RM_REGISTER_'+$registerResult)}
        $queryStartUtc=Utc;$queryStart=Qpc
        $querySession=$rmSession;if($cfg.fixtureMode -eq 'INVALID_QUERY_SESSION'){$querySession=[uint32]::MaxValue}
        $r=[VeridiaBuildRmNative]::Query($querySession)
        $queryEndUtc=Utc;$queryEnd=Qpc
        $endResult=[VeridiaBuildRmNative]::RmEndSession($rmSession);$rmStarted=$false
        if($r.Error -ne 0){$queryErrors++;throw ('RM_QUERY_'+$r.Error)}
        if($endResult -ne 0){throw ('RM_END_'+$endResult)}
        if($samples -eq 0){Ready-Stage FIRST_RM_END}
        $samples++;$queryTotal+=$r.Ms;$maxQuery=[math]::Max($maxQuery,$r.Ms);$lastEnd=Utc
        $users=@($r.Users|Sort-Object {$_.Process.Pid},{$_.Process.Birth.Value})
        $exists=[IO.File]::Exists($target)
        $state=$exists.ToString()+'|'+(@($users|ForEach-Object {$_.Process.Pid.ToString()+':'+$_.Process.Birth.Value.ToString()}) -join ',')
        if($samples -eq 1){Ready-Stage FIRST_METADATA_START}
        if($state -ne $lastState){
          $holders=@()
          foreach($u in $users){
            $identity=$u.Process.Pid.ToString()+':'+$u.Process.Birth.Value.ToString()
            if(-not $metadataCache.ContainsKey($identity)){
              $m=[ordered]@{identity='UNAVAILABLE';processName=$null;executablePath=$null;sanitizedCommandLine=$null;parentPid=$null;sessionId=$null;error=$null};$h=[IntPtr]::Zero
              try{
                $h=[VeridiaBuildRmNative]::OpenProcess(0x100000 -bor 0x1000,$false,$u.Process.Pid)
                if($h -eq [IntPtr]::Zero -or [VeridiaBuildRmNative]::Birth($h) -ne $u.Process.Birth.Value.ToString()){throw 'HOLDER_BIRTH_UNAVAILABLE_OR_REUSED'}
                $cim=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$u.Process.Pid) -OperationTimeoutSec 2 -ErrorAction Stop
                if(-not $cim -or [VeridiaBuildRmNative]::WaitForSingleObject($h,0) -ne 258){throw 'HOLDER_EXITED_DURING_METADATA'}
                $m.identity='MATCHED_RM_PID_AND_NATIVE_FILETIME';$m.processName=Safe-Text $cim.Name;$m.executablePath=Safe-Text $cim.ExecutablePath;$m.sanitizedCommandLine=Safe-Text $cim.CommandLine;$m.parentPid=$cim.ParentProcessId;$m.sessionId=$cim.SessionId
              }catch{$m.error=Safe-Text $_.Exception.Message}finally{if($h -ne [IntPtr]::Zero){[void][VeridiaBuildRmNative]::CloseHandle($h)}}
              $metadataCache[$identity]=$m
            }
            $holders+=[ordered]@{pid=$u.Process.Pid;nativeStartFileTime=$u.Process.Birth.Value.ToString();nativeFileTimeHigh=$u.Process.Birth.High;nativeFileTimeLow=$u.Process.Birth.Low;rmName=Safe-Text $u.Name;rmSessionId=$u.Session;metadata=$metadataCache[$identity];association='RM_RESOURCE_USER_NOT_SHARE_ACCESS_OR_CAUSE_PROOF'}
          }
          $record=Bound-Record ([ordered]@{event='state-owner-change';sample=$samples;queryStartUtc=$queryStartUtc;queryEndUtc=$queryEndUtc;queryStartQpcTicks=$queryStart;queryEndQpcTicks=$queryEnd;rmLifecycleStartUtc=$startUtc;rmLifecycleElapsedMs=([Diagnostics.Stopwatch]::GetTimestamp()-$startTicks)*1000/[Diagnostics.Stopwatch]::Frequency;queryElapsedMs=$r.Ms;actualPreviousStartIntervalMs=$gap;targetExistsMetadataOnly=$exists;holders=@($holders);state=$(if($users.Count -eq 0){'NO_RM_RESOURCE_USER_OBSERVED'}else{'RM_RESOURCE_USERS_OBSERVED'});rmEndResult=$endResult})
          $line=$utf8.GetBytes(($record|ConvertTo-Json -Depth 18 -Compress)+"`n")
          if($bytesWritten+$line.Length -gt $cfg.maxObservationBytes){throw 'OBSERVATION_STORAGE_CAP_INCOMPLETE'}
          $file=[IO.File]::Open([IO.Path]::Combine($directory,'owners.jsonl'),[IO.FileMode]::Append,[IO.FileAccess]::Write,[IO.FileShare]::Read)
          try{$file.Write($line,0,$line.Length)}finally{$file.Dispose()};$bytesWritten+=$line.Length;$changes++;$lastState=$state
        }
        if($samples -eq 1){Ready-Stage FIRST_PUBLICATION_END;Ready-Stage WORKER_READY_START;New-Json 'worker-ready.json' ([ordered]@{event='worker-ready';pid=$PID;nativeStartFileTime=$selfBirth;parentPid=$selfParent;firstQueryValid=$true;rmEndResult=0;targetExistsMetadataOnly=$exists;targetFileOpen='NEVER'})}
        $remaining=$cfg.intervalMs-([Diagnostics.Stopwatch]::GetTimestamp()-$startTicks)*1000/[Diagnostics.Stopwatch]::Frequency
        if($remaining -gt 0){[Threading.Thread]::Sleep([int][math]::Ceiling($remaining))}
      }
      if($reason -ne 'STOP_SIGNAL'){$reason='LEASE_EXPIRED'}
    } catch { $failure=Safe-Text $_.Exception.Message;$reason='WORKER_ERROR' }
    finally {
      if($rmStarted){try{$cleanup=[VeridiaBuildRmNative]::RmEndSession($rmSession);if($cleanup -ne 0){if($failure){$failure+='; RM_END_CLEANUP_'+$cleanup}else{$failure='RM_END_CLEANUP_'+$cleanup}};$endResult=$cleanup}catch{if($failure){$failure+='; RM_END_CLEANUP_FAILED'}else{$failure='RM_END_CLEANUP_FAILED'}}}
      New-Json 'worker-summary.json' ([ordered]@{event='worker-summary';pid=$PID;nativeStartFileTime=$selfBirth;startedAt=$startedAt;endedAt=Utc;lastQueryEndedAt=$lastEnd;samples=$samples;ownerStateChanges=$changes;rmQueryErrors=$queryErrors;maxGapMs=$maxGap;maxQueryMs=$maxQuery;meanQueryMs=$(if($samples -gt 0){$queryTotal/$samples}else{$null});rmEndResult=$endResult;reason=$reason;failure=$failure;targetFileOpen='NEVER';freshSessionPerSample=$true;observationBytes=$bytesWritten})
    }
  }
} catch { if($failure){$failure+='; '+(Safe-Text $_.Exception.Message)}else{$failure=Safe-Text $_.Exception.Message} }
finally {
  try { New-Json ($Role.ToLowerInvariant()+'-end.json') ([ordered]@{event=($Role.ToLowerInvariant()+'-end');pid=$PID;nativeStartFileTime=$selfBirth;parentPid=$selfParent;failure=$failure;forced=$forced;workerExited=$(if($Role -eq 'Worker'){$null}else{$workerExited});reason=$reason}) } catch { $failure='END_EVIDENCE_WRITE_FAILED' }
  foreach($h in @($workerHandle,$nodeHandle,$supervisorHandle,$self)){if($h -ne [IntPtr]::Zero){[void][VeridiaBuildRmNative]::CloseHandle($h)}}
}
if($failure -or $forced -or $reason -ne 'STOP_SIGNAL'){exit 2}
exit 0
