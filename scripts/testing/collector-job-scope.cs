using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
// Private scope for this diagnostic collector only. No process opens, kills,
// privilege changes, breakaway, limits changes, or named/public Job handles.
public sealed class VeridiaCollectorJobScope : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct FT { public uint lo,hi; public ulong Value{get{return ((ulong)hi<<32)|lo;}} }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,IntPtr data,uint capacity,out uint returned);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr process,out FT birth,out FT exit,out FT kernel,out FT user);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint ms);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out FT time);
 IntPtr job; readonly uint pid; readonly ulong birth; readonly string scopeId=Guid.NewGuid().ToString("D");
 readonly ulong assignedAt; readonly bool wasInJob; bool disposed,closed;
 static InvalidOperationException Failure(string stage){return new InvalidOperationException("COLLECTOR_JOB_"+stage+"_WIN32_"+Marshal.GetLastWin32Error());}
 static ulong Now(){FT time;GetSystemTimePreciseAsFileTime(out time);return time.Value;}
 static ulong Birth(){FT b,e,k,u;if(!GetProcessTimes(GetCurrentProcess(),out b,out e,out k,out u)||b.Value==0)throw Failure("SELF_BIRTH");return b.Value;}
 public VeridiaCollectorJobScope(){
  if(IntPtr.Size!=8)throw new InvalidOperationException("COLLECTOR_JOB_ARCH_UNSUPPORTED");
  pid=GetCurrentProcessId();birth=Birth();bool prior;
  if(!IsProcessInJob(GetCurrentProcess(),IntPtr.Zero,out prior))throw Failure("OUTER_JOB_OBSERVATION");wasInJob=prior;
  job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw Failure("CREATE");
  try{
   if(!AssignProcessToJobObject(job,GetCurrentProcess()))throw Failure("ASSIGN_SELF");
   assignedAt=Now();Check();
  }catch{CloseHandle(job);job=IntPtr.Zero;throw;}
 }
 uint Limits(){
  IntPtr data=Marshal.AllocHGlobal(144);
  try{uint bytes;if(!QueryInformationJobObject(job,9,data,144,out bytes)||bytes!=144)throw Failure("LIMITS_QUERY");return unchecked((uint)Marshal.ReadInt32(data,16));}
  finally{Marshal.FreeHGlobal(data);}
 }
 void Check(){
  bool member;if(disposed||job==IntPtr.Zero||Birth()!=birth||GetCurrentProcessId()!=pid||WaitForSingleObject(GetCurrentProcess(),0)!=258||
   !IsProcessInJob(GetCurrentProcess(),job,out member)||!member)throw new InvalidOperationException("COLLECTOR_JOB_SELF_BINDING_INVALID");
  if(Limits()!=0)throw new InvalidOperationException("COLLECTOR_JOB_NONZERO_LIMITS_OR_BREAKAWAY");
 }
 public Dictionary<string,object> Capture(){
  Check();ulong start=Now();const int capacity=8+32768*8;IntPtr data=Marshal.AllocHGlobal(capacity);
  try{
   uint bytes;if(!QueryInformationJobObject(job,3,data,capacity,out bytes))throw Failure("MEMBERS_QUERY");
   int assigned=Marshal.ReadInt32(data),count=Marshal.ReadInt32(data,4);
   if(count<1||count>32768||assigned!=count||bytes<8+count*8||bytes>capacity)throw new InvalidOperationException("COLLECTOR_JOB_MEMBERS_INCOMPLETE");
   var members=new List<int>();var unique=new HashSet<int>();
   for(int i=0;i<count;i++){long value=Marshal.ReadInt64(data,8+i*8);if(value<1||value>Int32.MaxValue||!unique.Add((int)value))throw new InvalidOperationException("COLLECTOR_JOB_MEMBER_INVALID");members.Add((int)value);}
   if(!unique.Contains((int)pid))throw new InvalidOperationException("COLLECTOR_JOB_SELF_NOT_IN_COMPLETE_LIST");
   Check();ulong end=Now();if(start> end||assignedAt>start)throw new InvalidOperationException("COLLECTOR_JOB_CAPTURE_TIME_INVALID");
   return new Dictionary<string,object>{{"schemaVersion",1},{"scopeId",scopeId},{"proof","PRIVATE_KERNEL_JOB_SELF_BOUND_NO_BREAKAWAY"},
    {"pid",(int)pid},{"nativeBirthStamp",birth.ToString(CultureInfo.InvariantCulture)},
    {"assignedAtFileTime",assignedAt.ToString(CultureInfo.InvariantCulture)},{"queryStartedFileTime",start.ToString(CultureInfo.InvariantCulture)},
    {"queryEndedFileTime",end.ToString(CultureInfo.InvariantCulture)},{"priorOuterJobPresent",wasInJob},
    {"limitFlags",0},{"inventoryComplete",true},{"selfHeldLive",true},{"selfKernelMembershipVerified",true},
    {"memberPids",members.ToArray()},{"ownershipGranted",false},{"terminationAuthorized",false}};
  }finally{Marshal.FreeHGlobal(data);}
 }
 public bool HandleClosed {get{return closed;}}
 public void Dispose(){if(disposed)return;disposed=true;if(job!=IntPtr.Zero){closed=CloseHandle(job);job=IntPtr.Zero;if(!closed)throw Failure("HANDLE_CLOSE");}}
}
