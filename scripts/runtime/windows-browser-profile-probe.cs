using System;
using System.IO;
using System.Text;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using System.Web.Script.Serialization;

// A one-request console host for the unchanged, approved native census/argv
// primitives. No PowerShell engine, background worker, process-name authority,
// observation cache, fallback after failure, privilege change or extra retry.
internal static class VeridiaProfileProbeHost {
 const int BudgetMs=2000, InputLimit=4194304;
 static readonly Stopwatch Clock=Stopwatch.StartNew();
 // Do not use Process.Handle: .NET Framework opens m_processAccess=0x1f0fff.
 // A read-only probe needs query + wait; terminate is requested only in that
 // mode, and never exercised until the entire captured identity set validates.
 const uint QueryAndWait=0x101000, TerminateRight=0x1;
 [DllImport("kernel32.dll",SetLastError=true)] static extern SafeProcessHandle OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(SafeProcessHandle handle);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(SafeProcessHandle handle,out long creation,out long exit,out long kernel,out long user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(SafeProcessHandle handle,uint milliseconds);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(SafeProcessHandle handle,uint exitCode);
 sealed class HeldProcess:IDisposable {
  public readonly int Id;public readonly SafeProcessHandle Handle;
  public HeldProcess(int pid,SafeProcessHandle handle){Id=pid;Handle=handle;}
  public string Birth(){long creation,exit,kernel,user;if(GetProcessId(Handle)!=(uint)Id||!GetProcessTimes(Handle,out creation,out exit,out kernel,out user))throw new InvalidOperationException("LIVE_PROCESS_BIRTH_MISMATCH");return unchecked((ulong)creation).ToString(CultureInfo.InvariantCulture);}
  public bool HasExited{get{uint state=WaitForSingleObject(Handle,0);if(state==0)return true;if(state==258)return false;throw new Win32Exception(Marshal.GetLastWin32Error());}}
  public void Kill(){if(!TerminateProcess(Handle,1))throw new Win32Exception(Marshal.GetLastWin32Error());}
  public void Dispose(){Handle.Dispose();}
 }
 static string Phase="SCRIPT_ENTERED";
 static void Stage(string value){Phase=value;Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_STAGE={0}:{1}",value,Clock.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture));}
 static void Budget(){if(Clock.Elapsed.TotalMilliseconds>=BudgetMs)throw new InvalidOperationException("NATIVE_QUERY_DEADLINE");}
 static string RequiredString(Dictionary<string,object> row,string key){object value;if(!row.TryGetValue(key,out value)||!(value is string)||String.IsNullOrWhiteSpace((string)value)||((string)value).Length>32768)throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");return(string)value;}
 static bool SamePath(string left,string right){return String.Equals(left,right,StringComparison.OrdinalIgnoreCase);}
 static string FullPath(string input){if(!Path.IsPathRooted(input))throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");return Path.GetFullPath(input);}
 static bool Match(Dictionary<string,object> expected,int pid,string birth,string executable,string profile){
  object value;return expected.TryGetValue("pid",out value)&&value is int&&(int)value==pid&&
   expected.TryGetValue("birthStamp",out value)&&value is string&&(string)value==birth&&
   expected.TryGetValue("executablePath",out value)&&value is string&&SamePath((string)value,executable)&&
   expected.TryGetValue("profilePath",out value)&&value is string&&SamePath(((string)value).TrimEnd('\\'),profile);
 }
 static void ValidateExpected(Dictionary<string,object> value){
  if(value==null)throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");
  foreach(string key in value.Keys)if(key!="pid"&&key!="birthStamp"&&key!="executablePath"&&key!="profilePath"&&key!="parentPid"&&key!="browserProcess")throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");
  object pid;if(!value.TryGetValue("pid",out pid)||!(pid is int)||(int)pid<=0)throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");
  ulong birth;if(!UInt64.TryParse(RequiredString(value,"birthStamp"),NumberStyles.None,CultureInfo.InvariantCulture,out birth)||birth==0)throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");
  RequiredString(value,"executablePath");RequiredString(value,"profilePath");
 }
 static string ReadRequest(){var text=new StringBuilder();var buffer=new char[4096];int count;while((count=Console.In.Read(buffer,0,buffer.Length))>0){if(text.Length>InputLimit-count)throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");text.Append(buffer,0,count);Budget();}return text.ToString();}
 static void Failure(Exception error){
  for(int depth=0;depth<4&&error.InnerException!=null;depth++)error=error.InnerException;
  string code="NATIVE_PROBE_SCRIPT_EXCEPTION";
  foreach(string allowed in new[]{"PROFILE_OWNERSHIP_UNAVAILABLE","LIVE_PROCESS_HANDLE_UNAVAILABLE","LIVE_PROCESS_BIRTH_MISMATCH","UNVERIFIED_PROFILE_OWNER","NATIVE_ARGV_ASSET_INVALID"})if(error.Message==allowed)code=allowed;
  Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_FAILURE={0}:{1}",Phase,code);Console.Error.Flush();
 }
 public static int Main(){
  bool written=false,disposed=false;int result=1;
  var handles=new List<HeldProcess>();var births=new Dictionary<int,string>();var owned=new List<Dictionary<string,object>>();
  try{
   Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);Stage("SCRIPT_ENTERED");
   if(Environment.GetEnvironmentVariable("VERIDIA_E2E")=="true")using(var self=Process.GetCurrentProcess()){
    Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_SELF={0}:{1}:{2}",self.Id,self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(CultureInfo.InvariantCulture),DateTimeOffset.UtcNow.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture));Console.Error.Flush();
   }
   Stage("REQUEST_PARSE");var json=new JavaScriptSerializer{MaxJsonLength=InputLimit,RecursionLimit=16};
   var request=json.DeserializeObject(ReadRequest()) as Dictionary<string,object>;
   if(request==null)throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");
   foreach(string key in request.Keys)if(key!="executablePath"&&key!="profilePath"&&key!="terminate")throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");
   string executable=FullPath(RequiredString(request,"executablePath")),profile=FullPath(RequiredString(request,"profilePath")).TrimEnd('\\');
   object terminateValue;object[] terminate=null;
   if(request.TryGetValue("terminate",out terminateValue)&&terminateValue!=null){terminate=terminateValue as object[];if(terminate==null||terminate.Length>32768)throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");foreach(object entry in terminate)ValidateExpected(entry as Dictionary<string,object>);}
   // An empty captured list is observation-only, as in the compatibility path.
   bool terminating=terminate!=null&&terminate.Length>0;Budget();Stage("PROCESS_CENSUS");
   if(!VeridiaBrowserProfileCensus.IsApprovedAbi())throw new InvalidOperationException("NATIVE_ARGV_ASSET_INVALID");
   Stage("PROCESS_CENSUS_QUERY_ENTER");object[] candidates;
   try{candidates=VeridiaBrowserProfileCensus.ReadProfileRows(executable,Clock);}
   catch{if(VeridiaBrowserProfileCensus.LastStage!=null)Phase=VeridiaBrowserProfileCensus.LastStage;throw;}
   Stage("PROCESS_CENSUS_QUERY_RETURN");
   foreach(object item in candidates){
    Budget();Stage("PROCESS_CENSUS_ENUMERATE");var row=item as Hashtable;if(row==null)throw new InvalidOperationException("PROFILE_OWNERSHIP_UNAVAILABLE");
    if(!SamePath((string)row["ExecutablePath"],executable))continue;
    string command=row["CommandLine"] as string,snapshotBirth=row["NativeSnapshotBirthStamp"] as string;
    if(String.IsNullOrEmpty(command)||String.IsNullOrEmpty(snapshotBirth)||!(row["CreationDate"] is DateTime))throw new InvalidOperationException("PROFILE_OWNERSHIP_UNAVAILABLE");
    Stage("PROFILE_ARGUMENT_READ");bool[] profileMatch=VeridiaBrowserArgv.MatchProfile(command,profile);Stage("PROFILE_ARGUMENT_PARSED");if(!profileMatch[0])continue;
    int pid=(int)row["ProcessId"];HeldProcess process=null;Stage("NATIVE_HANDLE_BIND");
    uint access=QueryAndWait|(terminating?TerminateRight:0);Stage("NATIVE_PROCESS_OPEN");Stage("NATIVE_HANDLE_OPEN");
    SafeProcessHandle held=OpenProcess(access,false,(uint)pid);int openError=held.IsInvalid?Marshal.GetLastWin32Error():0;
    if(held.IsInvalid){held.Dispose();bool absent=openError==87&&!VeridiaBrowserProfileCensus.ProcessStillExists(pid,Clock);
     Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_OWNER_OPEN={0}:{1}:{2}:{3}:{4}",pid,snapshotBirth,access,openError,absent?"TRUE":"FALSE");Console.Error.Flush();Budget();
     if(!absent)throw new InvalidOperationException("LIVE_PROCESS_HANDLE_UNAVAILABLE");continue;}
    process=new HeldProcess(pid,held);
    bool retained=false;
    try{
     Budget();Stage("NATIVE_BIRTH_READ");string birth=process.Birth();Stage("NATIVE_BIRTH_VALIDATE");
     if(birth!=snapshotBirth){if(VeridiaBrowserProfileCensus.ProcessStillExists(pid,Clock))throw new InvalidOperationException("LIVE_PROCESS_BIRTH_MISMATCH");continue;}
     if(process.HasExited)continue;Budget();
     var identity=new Dictionary<string,object>{{"pid",pid},{"parentPid",(int)row["ParentProcessId"]},{"browserProcess",profileMatch[1]},{"birthStamp",birth},{"executablePath",executable},{"profilePath",profile}};
     Stage("NATIVE_IDENTITY_APPEND");owned.Add(identity);
     if(terminating){int matches=0;foreach(object entry in terminate)if(Match((Dictionary<string,object>)entry,pid,birth,executable,profile))matches++;
      if(matches!=1)throw new InvalidOperationException("UNVERIFIED_PROFILE_OWNER");births.Add(pid,birth);handles.Add(process);retained=true;}
    }finally{if(!retained){Stage("NATIVE_HANDLE_DISPOSE");process.Dispose();}}
   }
   // Entire current identity set is admitted before any termination. Every Kill
   // is on the exact query/terminate handle bound to native birth, never a PID.
   Budget();Stage("VALIDATED_TERMINATION");
   foreach(var process in handles){Budget();if(!process.HasExited)try{process.Kill();}
    catch(Exception error){Exception detail=error;for(int depth=0;depth<4&&detail.InnerException!=null;depth++)detail=detail.InnerException;
     var win32=detail as Win32Exception;int native=win32==null?0:win32.NativeErrorCode;string exited="UNKNOWN";try{exited=process.HasExited?"TRUE":"FALSE";}catch{}
     Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_TERMINATION_FAILURE={0}:{1}:{2}:{3}:{4}",process.Id,births[process.Id],native,detail.HResult,exited);Console.Error.Flush();
     if(native==5&&exited=="TRUE")continue;throw;}
   }
   Budget();Stage("RESULT_EMIT");string output=json.Serialize(owned);Stage("RESULT_SERIALIZED");Console.Out.WriteLine(output);Console.Out.Flush();Stage("RESULT_WRITTEN");written=true;result=0;
  }catch(Exception error){Failure(error);result=1;}
  finally{disposed=true;foreach(var process in handles)try{process.Dispose();}catch(Exception error){disposed=false;Failure(error);result=1;}}
  if(!written||!disposed||result!=0)return 1;
  Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_EXIT_READY={0}",Clock.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture));Console.Error.Flush();
  // Natural console Main return; no PowerShell host, Environment.Exit,
  // ExitProcess, skipped finally, background work or relaxed parent close gate.
  return 0;
 }
}
