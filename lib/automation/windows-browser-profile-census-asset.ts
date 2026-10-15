// Immutable .NET 4 read-only profile census. No runtime compilation, prewarm or process termination.
export const WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE_SHA256 = "72661a0acbb2a504a7fe2a3e12b5e7d497dcb8fe0d9786d5747ac21570b599c7";
export const WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_SHA256 = "6fb23011e75916eaf256b58fc78c0c038ebae3e3bf08d309db42bc114b6a2f35";
export const WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE = String.raw`// Profile census: copied bounded SPI parsing from the already verified runtime observer.
using System;using System.IO;using System.Text;using System.Collections.Generic;using System.Diagnostics;using System.Globalization;using System.Runtime.InteropServices;
public static class VeridiaBrowserProfileCensus {
  const int SpiCapacity=8388608, SpiHeaderSize=256, SpiThreadSize=80, SpiMaxRows=32768, SpiMaxImageChars=260;
  const string SpiLayoutProfile="SPI_X64_PREFIX256_THREAD80_CREATE32_IMAGE56_PID80_PARENT88";
  [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort length, maximum; public IntPtr buffer; }
  [StructLayout(LayoutKind.Sequential)] struct SpiPrefix {
    public uint next, threads;
    public long spare1, spare2, spare3, creation, user, kernel;
    public Unicode image; public int priority; public IntPtr pid, parent;
    public uint handles, session; public UIntPtr pageDirectory, peakVirtual, virtualSize;
    public uint faults;
    public UIntPtr peakWorking, working, peakPaged, paged, peakNonPaged, nonPaged, pagefile, peakPagefile, privatePages;
    public long readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Version {
    public uint size, major, minor, build, platform;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] public string servicePack;
  }
  [StructLayout(LayoutKind.Sequential)] struct SystemInfo {
    public ushort architecture, reserved; public uint pageSize; public IntPtr minimum, maximum; public UIntPtr mask;
    public uint processors, type, granularity; public ushort level, revision;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct BasicInformation {
    public int exitStatus;
    public IntPtr peb;
    public UIntPtr affinity;
    public int priority;
    public UIntPtr pid, parentPid;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct FileTime { public uint low, high; public ulong Value { get { return ((ulong)high << 32) | low; } } }
  [StructLayout(LayoutKind.Sequential)]
  struct MemoryCounters {
    public uint size, faults;
    public UIntPtr peakWorkingSet, workingSet, peakPaged, paged, peakNonPaged, nonPaged, pagefile, peakPagefile;
  }
  sealed class Retained {
    public IntPtr handle;
    public uint pid;
    public ulong birth;
    public Dictionary<string,object> row;
  }
  sealed class ProviderBinding {
    public int selfPid, wrapperPid, selfParent, wrapperParent;
    public ulong selfBirth, wrapperBirth;
    public string selfName, wrapperName, selfCanonicalBirth, wrapperCanonicalBirth;
  }
  static ProviderBinding providerBinding;
  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  delegate int QueryBasic(IntPtr handle, int kind, out BasicInformation result, uint size, out uint returned);
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int QuerySystem(int kind, IntPtr buffer, uint bytes, out uint returned);
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int GetVersion(ref Version version);
  [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void QueryPreciseUtc(out FileTime time);
  [DllImport("kernel32.dll")] static extern void GetNativeSystemInfo(out SystemInfo info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out FileTime creation, out FileTime exit, out FileTime kernel, out FileTime user);
  [DllImport("kernel32.dll", EntryPoint="QueryFullProcessImageNameW", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ImageName(IntPtr handle, uint flags, StringBuilder value, ref uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", EntryPoint="GetModuleHandleW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll", EntryPoint="LoadLibraryW", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr LoadLibrary(string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Ansi, ExactSpelling=true, SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("psapi.dll", SetLastError=true)] static extern bool GetProcessMemoryInfo(IntPtr handle, ref MemoryCounters counters, uint size);
  [DllImport("iphlpapi.dll", SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr table, ref uint bytes, bool ordered, uint family, int tableClass, uint reserved);
  static readonly QueryBasic queryBasic;
  static readonly QuerySystem querySystem;
  static readonly GetVersion getVersion;
  static readonly QueryPreciseUtc queryPreciseUtc;
  static readonly IntPtr ntdllModule;
  static VeridiaBrowserProfileCensus() {
    if (IntPtr.Size != 8 || Marshal.SizeOf(typeof(BasicInformation)) != 48 || Marshal.SizeOf(typeof(SpiPrefix)) != SpiHeaderSize ||
        Marshal.OffsetOf(typeof(SpiPrefix),"creation").ToInt32()!=32 || Marshal.OffsetOf(typeof(SpiPrefix),"image").ToInt32()!=56 ||
        Marshal.OffsetOf(typeof(SpiPrefix),"pid").ToInt32()!=80 || Marshal.OffsetOf(typeof(SpiPrefix),"parent").ToInt32()!=88 ||
        Marshal.OffsetOf(typeof(SpiPrefix),"working").ToInt32()!=144)
      throw new InvalidOperationException("NATIVE_LAYOUT_UNSUPPORTED");
    ntdllModule = GetModuleHandle("ntdll.dll");
    if (ntdllModule == IntPtr.Zero) ntdllModule = LoadLibrary("ntdll.dll");
    if (ntdllModule == IntPtr.Zero) throw new InvalidOperationException("NATIVE_NTDLL_UNAVAILABLE");
    IntPtr address = GetProcAddress(ntdllModule, "NtQueryInformationProcess");
    if (address == IntPtr.Zero) throw new InvalidOperationException("NATIVE_BASIC_EXPORT_UNAVAILABLE");
    queryBasic = (QueryBasic)Marshal.GetDelegateForFunctionPointer(address, typeof(QueryBasic));
    address=GetProcAddress(ntdllModule,"NtQuerySystemInformation");
    if(address==IntPtr.Zero) throw new InvalidOperationException("SPI_SYSTEM_EXPORT_UNAVAILABLE");
    querySystem=(QuerySystem)Marshal.GetDelegateForFunctionPointer(address,typeof(QuerySystem));
    address=GetProcAddress(ntdllModule,"RtlGetVersion");
    if(address==IntPtr.Zero) throw new InvalidOperationException("SPI_VERSION_EXPORT_UNAVAILABLE");
    getVersion=(GetVersion)Marshal.GetDelegateForFunctionPointer(address,typeof(GetVersion));
    // Resolve the precise Windows FILETIME API explicitly. Missing capability
    // is a hard failure, never a coarse-clock fallback or invented time slack.
    IntPtr kernel32Module=GetModuleHandle("kernel32.dll");
    address=kernel32Module==IntPtr.Zero ? IntPtr.Zero : GetProcAddress(kernel32Module,"GetSystemTimePreciseAsFileTime");
    if(address==IntPtr.Zero) throw new InvalidOperationException("SPI_PRECISE_UTC_EXPORT_UNAVAILABLE");
    queryPreciseUtc=(QueryPreciseUtc)Marshal.GetDelegateForFunctionPointer(address,typeof(QueryPreciseUtc));
  }
  static void Remaining(Stopwatch watch, int budgetMs) {
    if (watch.Elapsed.TotalMilliseconds >= budgetMs) throw new InvalidOperationException("NATIVE_QUERY_DEADLINE");
  }
  static ulong PreciseUtcBound() {
    FileTime time; queryPreciseUtc(out time);
    ulong value=time.Value;
    if(value==0 || value>Int64.MaxValue) throw new InvalidOperationException("SPI_PRECISE_UTC_BOUND_INVALID");
    try { DateTime.FromFileTimeUtc((long)value); }
    catch(ArgumentOutOfRangeException) { throw new InvalidOperationException("SPI_PRECISE_UTC_BOUND_INVALID"); }
    return value;
  }
  static uint SpiVersion() {
    SystemInfo info; GetNativeSystemInfo(out info);
    Version version=new Version(); version.size=(uint)Marshal.SizeOf(typeof(Version));
    if(info.architecture!=9 || getVersion(ref version)!=0 || version.major!=10 || version.minor!=0 ||
       (version.build!=26100 && version.build!=26200)) throw new InvalidOperationException("SPI_UNAPPROVED_OS_ABI");
    // These are deliberately narrow candidate profiles, not a public ABI promise
    // or a claim that the cloud 26100 profile has already passed acceptance.
    return version.build;
  }
  static void ValidateSpiImage(string name) {
    if(String.IsNullOrWhiteSpace(name) || name.Length>SpiMaxImageChars || name.IndexOf('\0')>=0 ||
       name.IndexOf('/')>=0 || name.IndexOf('\\')>=0) throw new InvalidOperationException("SPI_IMAGE_NAME_INVALID");
    for(int index=0;index<name.Length;index++) {
      if(Char.IsHighSurrogate(name[index])) {
        if(index+1>=name.Length || !Char.IsLowSurrogate(name[index+1])) throw new InvalidOperationException("SPI_IMAGE_UTF16_INVALID");
        index++;
      } else if(Char.IsLowSurrogate(name[index])) throw new InvalidOperationException("SPI_IMAGE_UTF16_INVALID");
    }
  }
  static List<Dictionary<string,object>> ParseSpi(IntPtr buffer,uint returned,ulong utcBirthUpperBound,Stopwatch watch,int budgetMs) {
    if(returned<SpiHeaderSize || returned>SpiCapacity) throw new InvalidOperationException("SPI_RETURN_LENGTH_INVALID");
    long start=buffer.ToInt64(), end=checked(start+returned); int offset=0;
    List<Dictionary<string,object>> rows=new List<Dictionary<string,object>>(); HashSet<int> seen=new HashSet<int>();
    while(true) {
      Remaining(watch,budgetMs);
      if(offset<0 || offset>(long)returned-SpiHeaderSize || (offset&7)!=0) throw new InvalidOperationException("SPI_ENTRY_BOUNDS_INVALID");
      SpiPrefix entry=(SpiPrefix)Marshal.PtrToStructure(IntPtr.Add(buffer,offset),typeof(SpiPrefix));
      long span=entry.next==0 ? returned-offset : entry.next;
      if(span<SpiHeaderSize || span>returned-offset || (entry.next!=0 && (entry.next&7)!=0) ||
         entry.threads>(span-SpiHeaderSize)/SpiThreadSize) throw new InvalidOperationException("SPI_THREAD_OR_NEXT_BOUNDS_INVALID");
      if(rows.Count>=SpiMaxRows) throw new InvalidOperationException("SPI_INVENTORY_LIMIT_EXCEEDED");
      long pid=entry.pid.ToInt64(), parent=entry.parent.ToInt64();
      if(pid<0 || pid>Int32.MaxValue || parent<0 || parent>Int32.MaxValue || !seen.Add((int)pid))
        throw new InvalidOperationException("SPI_PID_INVALID_OR_DUPLICATE");
      string name=null;
      if(entry.image.length==0) {
        if(pid!=0 || parent!=0 || entry.image.maximum!=0 || entry.image.buffer!=IntPtr.Zero)
          throw new InvalidOperationException("SPI_IDLE_SENTINEL_INVALID");
      } else {
        long pointer=entry.image.buffer.ToInt64(), entryStart=checked(start+offset), entryEnd=checked(entryStart+span);
        long dataStart=checked(entryStart+SpiHeaderSize+(long)entry.threads*SpiThreadSize);
        if((entry.image.length&1)!=0 || (entry.image.maximum&1)!=0 || entry.image.length>entry.image.maximum ||
           entry.image.length/2>SpiMaxImageChars || pointer<dataStart || pointer<start || pointer>end ||
           entry.image.maximum>entryEnd-pointer || (pointer&1)!=0) throw new InvalidOperationException("SPI_UNICODE_BOUNDS_INVALID");
        name=Marshal.PtrToStringUni(entry.image.buffer,entry.image.length/2); ValidateSpiImage(name);
        if(pid==0) throw new InvalidOperationException("SPI_IDLE_SENTINEL_INVALID");
      }
      string canonical=null, nativeBirth=null;
      if(pid!=0) {
        if(entry.creation<=0 || (ulong)entry.creation>utcBirthUpperBound) {
          InvalidOperationException failure=new InvalidOperationException("SPI_BIRTH_OUTSIDE_CAPTURE_UTC_BOUND");
          failure.Data["birthGuardFailure"]=new Dictionary<string,object> {
            {"branch",entry.creation<=0 ? "NON_POSITIVE_BIRTH" : "AFTER_PRECISE_UTC_BOUND"},
            {"pid",(int)pid},{"parentPid",(int)parent},{"creationSigned",entry.creation.ToString(CultureInfo.InvariantCulture)},
            {"utcBirthUpperBound",utcBirthUpperBound.ToString(CultureInfo.InvariantCulture)},
            {"clockSource","GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME"} };
          throw failure;
        }
        ulong birth=(ulong)entry.creation;
        canonical=DateTime.FromFileTimeUtc((long)(birth/10*10)).ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ",CultureInfo.InvariantCulture);
        nativeBirth=birth.ToString(CultureInfo.InvariantCulture);
      }
      // Retain the measured native snapshot working set, never an invented zero
      // for an omitted measurement. No extra per-PID memory query is performed.
      ulong workingSet=entry.working.ToUInt64();
      if(workingSet>9007199254740991UL) throw new InvalidOperationException("SPI_WORKING_SET_UNREPRESENTABLE");
      rows.Add(new Dictionary<string,object> { {"pid",(int)pid},{"parentPid",(int)parent},{"name",name},
        {"createdAt",canonical},{"nativeBirthStamp",nativeBirth},
        {"workingSetBytes",(long)workingSet},
        {"nativeIdentityStatus",pid==0 ? "SPI_IDLE_SENTINEL_NO_AUTHORITY" : "SNAPSHOT_ONLY_BIRTH_PARENT_NAME_OBSERVATION"},
        {"parentIdentityProof","SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY"},
        {"liveAtCaptureEnd",null},{"ownershipAuthority",false} });
      if(entry.next==0) break;
      offset=checked(offset+(int)entry.next);
    }
    if(rows.Count==0) throw new InvalidOperationException("SPI_EMPTY_INVENTORY");
    return rows;
  }
  static List<Dictionary<string,object>> Processes(Stopwatch watch,int budgetMs,out Dictionary<string,object> coverage) {
    uint osBuild=SpiVersion(); Remaining(watch,budgetMs);
    IntPtr buffer=Marshal.AllocHGlobal(SpiCapacity);
    try {
      uint returned; int status=querySystem(5,buffer,SpiCapacity,out returned);
      Remaining(watch,budgetMs);
      if(status!=0) throw new InvalidOperationException("SPI_QUERY_NTSTATUS_FAILED");
      ulong utcBirthUpperBound=PreciseUtcBound(); Remaining(watch,budgetMs);
      // One bounded complete query. Buffer insufficiency, ABI mismatch or UTC
      // rollback fails closed; no resize loop, fallback, truncation or retry.
      List<Dictionary<string,object>> rows=ParseSpi(buffer,returned,utcBirthUpperBound,watch,budgetMs);
      coverage=new Dictionary<string,object> { {"osBuild",osBuild},{"architecture","AMD64"},{"layoutProfile",SpiLayoutProfile},
        {"queryStatus",status},{"returnLength",returned},{"bufferCapacity",SpiCapacity},{"inventoryComplete",true},
        {"snapshotCompletedUtcFileTime",utcBirthUpperBound.ToString(CultureInfo.InvariantCulture)},
        {"clockSource","GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME"} };
      return rows;
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  public static string LastStage;
  static void Stage(string value,Stopwatch clock) {
    LastStage=value;Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_STAGE={0}:{1}",value,clock.ElapsedMilliseconds.ToString(CultureInfo.InvariantCulture));
  }
  public static bool IsApprovedAbi() {
    try {SpiVersion();return true;}
    catch(InvalidOperationException error) {if(error.Message=="SPI_UNAPPROVED_OS_ABI")return false;throw;}
  }
  public static bool ProcessStillExists(int pid,Stopwatch watch) {
    Dictionary<string,object> coverage;var rows=Processes(watch,2000,out coverage);
    return rows.Exists(delegate(Dictionary<string,object> row){return (int)row["pid"]==pid;});
  }
  // A signaled creator-independent handle with the same full birth identity
  // proves this snapshot entry has exited; it never grants reuse/kill authority.
  static bool SameHeldIdentityExited(IntPtr handle,int pid,string birth) {
    FileTime creation,exit,kernel,user;
    return GetProcessId(handle)==(uint)pid &&
      GetProcessTimes(handle,out creation,out exit,out kernel,out user) &&
      creation.Value.ToString(CultureInfo.InvariantCulture)==birth && WaitForSingleObject(handle,0)==0;
  }
  static bool MayAwaitReportedExit(bool exactIdentity,ulong exitFileTime,int exitStatus) {
    return exactIdentity && exitFileTime>0 && exitStatus!=259;
  }
  // A reported exit timestamp is not a close proof. Only an already-exiting,
  // unchanged held identity may be joined, inside the existing query budget.
  static bool WaitForSameHeldExitWithinBudget(IntPtr handle,int pid,string birth,Stopwatch watch,int budgetMs) {
    Remaining(watch,budgetMs);
    if(SameHeldIdentityExited(handle,pid,birth)) {Remaining(watch,budgetMs);return true;}
    FileTime creation=default(FileTime),exit=default(FileTime),kernel=default(FileTime),user=default(FileTime);BasicInformation basic;uint returned;
    bool exact=GetProcessId(handle)==(uint)pid && GetProcessTimes(handle,out creation,out exit,out kernel,out user);
    if(!exact)return false;
    exact=creation.Value.ToString(CultureInfo.InvariantCulture)==birth;
    if(queryBasic(handle,0,out basic,48,out returned)!=0 || returned!=48 || basic.pid.ToUInt64()!=(uint)pid ||
       !MayAwaitReportedExit(exact,exit.Value,basic.exitStatus))return false;
    Remaining(watch,budgetMs);
    double remainingMs=budgetMs-watch.Elapsed.TotalMilliseconds;
    if(remainingMs<1)throw new InvalidOperationException("NATIVE_QUERY_DEADLINE");
    uint waitMs=(uint)Math.Floor(remainingMs);
    Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_EXIT_JOIN={0}:{1}:{2}:START:{3}",pid,birth,waitMs,watch.ElapsedMilliseconds);
    uint waitResult=WaitForSingleObject(handle,waitMs);
    Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_EXIT_JOIN={0}:{1}:{2}:{3}:{4}",pid,birth,waitMs,waitResult,watch.ElapsedMilliseconds);
    Remaining(watch,budgetMs);
    if(waitResult!=0)return false;
    bool closed=SameHeldIdentityExited(handle,pid,birth);Remaining(watch,budgetMs);return closed;
  }
  // Read-only census: never returns ownership authority or terminates a process.
  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  delegate int QueryInformation(IntPtr handle, int kind, IntPtr buffer, uint bytes, out uint returned);
  static string ReadCommandLine(IntPtr handle) {
    const int capacity=131072;
    IntPtr address=GetProcAddress(ntdllModule,"NtQueryInformationProcess");
    if(address==IntPtr.Zero) throw new InvalidOperationException("PROFILE_OWNERSHIP_UNAVAILABLE");
    QueryInformation query=(QueryInformation)Marshal.GetDelegateForFunctionPointer(address,typeof(QueryInformation));
    IntPtr buffer=Marshal.AllocHGlobal(capacity);
    try {
      uint returned;int status=query(handle,60,buffer,capacity,out returned);
      if(status!=0 || returned<16 || returned>capacity) throw new InvalidOperationException("PROFILE_OWNERSHIP_UNAVAILABLE");
      Unicode value=(Unicode)Marshal.PtrToStructure(buffer,typeof(Unicode));
      long start=buffer.ToInt64(),end=checked(start+returned),pointer=value.buffer.ToInt64();
      if(value.length==0 || (value.length&1)!=0 || (value.maximum&1)!=0 || value.length>value.maximum ||
        pointer<start+16 || pointer>end || value.maximum>end-pointer || (pointer&1)!=0)
        throw new InvalidOperationException("PROFILE_OWNERSHIP_UNAVAILABLE");
      string text=Marshal.PtrToStringUni(value.buffer,value.length/2);
      if(text.IndexOf('\0')>=0) throw new InvalidOperationException("PROFILE_OWNERSHIP_UNAVAILABLE");
      return text;
    } finally {Marshal.FreeHGlobal(buffer);}
  }
  public static object[] ReadProfileRows(string executable,Stopwatch watch) {
    Stage("SPI_CAPTURE_ENTER",watch); Dictionary<string,object> coverage;var snapshot=Processes(watch,2000,out coverage); Stage("SPI_CAPTURE_RETURN",watch);
    var rows=new List<object>();string expectedName=Path.GetFileName(executable);
    foreach(var row in snapshot) {
      Remaining(watch,2000);
      if(!String.Equals((string)row["name"],expectedName,StringComparison.OrdinalIgnoreCase))continue;
      Stage("SPI_HELD_PROCESS_OPEN",watch); IntPtr handle=OpenProcess(0x100400,false,(uint)(int)row["pid"]);
      if(handle==IntPtr.Zero) {
        int openError=Marshal.GetLastWin32Error();bool absent=false;
        // Match the legacy census' disappeared-PID check, but only for a
        // rejected open with a fresh, complete native inventory proving absence.
        // Permission/unknown failures and a reused/present PID remain blocked.
        if(openError==87)absent=!ProcessStillExists((int)row["pid"],watch);
        Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_CENSUS_OPEN={0}:{1}:{2}:{3}",
          row["pid"],row["nativeBirthStamp"],openError,absent?"TRUE":"FALSE");
        Remaining(watch,2000);
        if(absent){Stage("SPI_VERIFIED_ABSENCE_SKIP",watch);continue;}
        throw new InvalidOperationException("LIVE_PROCESS_HANDLE_UNAVAILABLE");
      }
      try {
        if(WaitForSingleObject(handle,0)==0)continue;
        BasicInformation basic;uint returned;
        if(GetProcessId(handle)!=(uint)(int)row["pid"] || queryBasic(handle,0,out basic,48,out returned)!=0 || returned!=48 ||
          basic.pid.ToUInt64()!=(uint)(int)row["pid"] || basic.parentPid.ToUInt64()!=(uint)(int)row["parentPid"])
          throw new InvalidOperationException("LIVE_PROCESS_BIRTH_MISMATCH");
        FileTime creation,exit,kernel,user;
        if(!GetProcessTimes(handle,out creation,out exit,out kernel,out user) ||
          creation.Value.ToString(CultureInfo.InvariantCulture)!=(string)row["nativeBirthStamp"])
          throw new InvalidOperationException("LIVE_PROCESS_BIRTH_MISMATCH");
        try {
        var image=new StringBuilder(32768);uint length=32768;
        Stage("SPI_IMAGE_READ",watch); bool imageRead=ImageName(handle,0,image,ref length);
        int imageError=imageRead?0:Marshal.GetLastWin32Error();
        if(!imageRead || length==0 || length>=32768) {
          FileTime diagnosticCreation=default(FileTime),diagnosticExit=default(FileTime),diagnosticKernel=default(FileTime),diagnosticUser=default(FileTime);
          bool sameIdentity=GetProcessId(handle)==(uint)(int)row["pid"] &&
            GetProcessTimes(handle,out diagnosticCreation,out diagnosticExit,out diagnosticKernel,out diagnosticUser) &&
            diagnosticCreation.Value.ToString(CultureInfo.InvariantCulture)==(string)row["nativeBirthStamp"];
          Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_CENSUS_IMAGE={0}:{1}:{2}:{3}:{4}:{5}:{6}",
            row["pid"],row["nativeBirthStamp"],imageError,imageRead?"TRUE":"FALSE",length,sameIdentity?"TRUE":"FALSE",WaitForSingleObject(handle,0));
          // Observation only: values from the existing held-handle queries.
          // They cannot replace the signaled-handle exit proof or grant ownership.
          Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_CENSUS_IMAGE_STATE={0}:{1}:{2}:{3}:{4}",
            row["pid"],row["nativeBirthStamp"],unchecked((uint)basic.exitStatus),diagnosticExit.Value,sameIdentity?"TRUE":"FALSE");
          throw new InvalidOperationException("PROFILE_OWNERSHIP_UNAVAILABLE");
        }
        Stage("SPI_IMAGE_RETURN",watch); string path=image.ToString();
        if(!String.Equals(path,executable,StringComparison.OrdinalIgnoreCase))continue;
        Stage("SPI_COMMAND_LINE_READ",watch); string command=ReadCommandLine(handle); Stage("SPI_COMMAND_LINE_RETURN",watch);
        if(GetProcessId(handle)!=(uint)(int)row["pid"] || !GetProcessTimes(handle,out creation,out exit,out kernel,out user) ||
          creation.Value.ToString(CultureInfo.InvariantCulture)!=(string)row["nativeBirthStamp"] || WaitForSingleObject(handle,0)!=258)
          throw new InvalidOperationException("LIVE_PROCESS_BIRTH_MISMATCH");
        rows.Add(new System.Collections.Hashtable { {"ProcessId",row["pid"]},{"ParentProcessId",row["parentPid"]},
          {"ExecutablePath",path},{"CommandLine",command},{"CreationDate",DateTime.FromFileTimeUtc((long)creation.Value)},
          {"NativeSnapshotBirthStamp",row["nativeBirthStamp"]} });
        } catch(InvalidOperationException failure) {
          Remaining(watch,2000);
          if((failure.Message!="PROFILE_OWNERSHIP_UNAVAILABLE" && failure.Message!="LIVE_PROCESS_BIRTH_MISMATCH") ||
             !WaitForSameHeldExitWithinBudget(handle,(int)row["pid"],(string)row["nativeBirthStamp"],watch,2000))throw;
          // Exclude only a proved exited, unchanged held process. Live,
          // inaccessible, mismatched and deadline failures remain fail closed.
          Stage("SPI_VERIFIED_EXIT_SKIP",watch);
        }
      } finally {Stage("SPI_HELD_PROCESS_DISPOSE",watch); if(!CloseHandle(handle))throw new InvalidOperationException("NATIVE_PROCESS_HANDLE_CLOSE_FAILED");}
    }
    Remaining(watch,2000);return rows.ToArray();
  }
}
`;
export const WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_BASE64 = [
  "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",
  "AcUBCgC1AqICBgAQA/UCBgAXA/UCBgCGBvkABgCTBvkABgDbBrwGBgAJCOkHBgApCOkHBgBHCLwGBgC3CPkABgDHCPkA",
  "BgDMCPkABgDwCLwGBgAQCfkABgA7CfkABgBiCfkABgCNCfkABgCmCfkABgDCCfkABgD5CfkADgAxCvUCBgB1CvkABgCS",
  "Cn8KBgCnCvkABgDCCq0KBgDjCvkABgDpCvkABgACC/kABgASC/kABgAjC/kABgA4C/kABgBLC/kABgBdC1MLBgDVC/kA",
  "BgDoC/kABgDzC1MLGwAEDAAABgApDPkABgBTDH8KBgBmDPkABgCCDLwGBgCYDLwGBgCjDLwGBgC2DLwGBgDEDLwGBgDm",
  "DLwGBgD4DOkHAAAAAAEAAAAAAAEAAQCBAQAAKgAAAAUAAQABAAsBEABGAAAACQAOABwACwEQAE4AAAAJABEAHAALAREA",
  "WAAAAAkAMgAcAAsBEABgAAAACQA4ABwACwEQAGsAAAAJAEMAHAALARAAfAAAAAkASQAcAAsBEACFAAAACQBLAB0AAwEQ",
  "AJQAAAAFAFUAHQADARAAnQAAAAUAWQAeAAMBAACtAAAADQBjAB8AAwEAALgAAAANAGMAIwADAQAAxAAAAA0AYwAnAAMB",
  "AADPAAAADQBjACsAAwEAAN8AAAANAGMALwADARAAoAsAAAUAYwAzAFGAIwEKAFGALwEKAFGAPQEKAFGASwEKAFGAVgEK",
  "AFGAZwEmABEAeAGeADEAXQL6ADEAaAL+ADEAdAICATEAfwIGATEAjwIKARYANwMmAAYA1AOGAQYA2wOGAQYA4wMKAQYA",
  "6gOJAQYA7wOJAQYA9wOMAQYA/gOMAQYABQSMAQYADASMAQYAFQSMAQYAGgSMAQYAIQSPAQYAJwQKAAYAMAQKAQYANAQK",
  "AQYAOwSJAQYAQwSJAQYASwSTAQYAWQSTAQYAZQSTAQYAcQSJAQYAeASTAQYAhASTAQYAjASTAQYAlgSTAQYAnASTAQYA",
  "qQSTAQYAsgSTAQYAuwSTAQYAyASTAQYA1QSMAQYA3QSMAQYA5gSMAQYA7wSMAQYA+QSMAQYABAWMAQYADwWJAQYAFAWJ",
  "AQYAGgWJAQYAIAWJAQYAJgWJAQYQLwUmAAYAOwWGAQYASAWGAQYAUQWJAQYAWgUKAQYA2wMKAQYAYgWTAQYAZwWJAQYA",
  "cgWJAQYAdwWJAQYAgwWGAQYAiQWGAQYAkgUKAAYAnQUKAQYAoQWTAQYAJwQKAAYAMASTAQYAqgWTAQYAtAWJAQYAuAWJ",
  "AQYADwWJAQYAcQSJAQYAzQWTAQYA3AWTAQYAjASTAQYAlgSTAQYAnASTAQYAqQSTAQYAsgSTAQYAuwSTAQYA5wUKAQYA",
  "MASJAQYA7gWeAQYA9AWhAQYA/gUKAAYABgYKAAYAEQYKAAYAHAYKAAYAKgaeAQYANAaeAQYAQQYmAAYASgYmAAYAVgYm",
  "AAYAaQYmAAYAMAQKAAAAAACAAJEgiAGiAAEAAAAAAIAAkSCcAakAAgAAAAAAgACRIKgBsAAFAAAAAACAAJEgtQG1AAYA",
  "AAAAAIAAkSDfAcYACwAAAAAAgACRIOkB0AAPAAAAAACAAJEg9QHVABAAAAAAAIAAkSAJAtsAEgAAAAAAgACRIBkC2wAT",
  "AAAAAACAAJEgJQLgABQAAAAAAIAAkSA0AuYAFgAAAAAAgACRIEkC7wAZAFAgAAAAAJEYmwINAR8AvCIAAAAAkQC/AhEB",
  "HwDoIgAAAACRAMkCGAEhAEwjAAAAAJEA2QIcASEA3CMAAAAAkQDkAiABIQCQJAAAAACRACQDJQEiAGQpAAAAAJEALQM4",
  "AScAoCoAAAAAkQBBA08BKgDYKgAAAACWAEcDVgEsAEArAAAAAJYAVQNaASwAfCsAAAAAkQBoA2EBLgDLKwAAAACRAH8D",
  "aAExAOQrAAAAAJEAlANvATQArC0AAAAAkQC0A3kBOQAULwAAAACWAMQDfgE6AHA1AAAAAIYIvQWWATwAhDUAAAAAhhj4",
  "BakBPACMNQAAAACGGPgFqQE8AAAAAAADAIYY+AWtATwAAAAAAAMAxgF/BrMBPgAAAAAAAwDGAaEGvwFDAAAAAAADAMYB",
  "rQbPAUoAAAAAAAMAhhj4Ba0BTQAAAAAAAwDGAX8G2gFPAAAAAAADAMYBoQbjAVMAAAAAAAMAxgGtBvABWQAAAAAAAwCG",
  "GPgFrQFbAAAAAAADAMYBfwb4AV0AAAAAAAMAxgGhBv8BXgAAAAAAAwDGAa0GCgJhAAAAAAADAIYY+AWtAWMAAAAAAAMA",
  "xgF/BhMCZQAAAAAAAwDGAaEGGgJmAAAAAAADAMYBrQYlAmkAAAAAAAMAhhj4Ba0BawAAAAAAAwDGAX8GLgJtAAAAAAAD",
  "AMYBoQY4AnIAAAAAAAMAxgGtBvABeQAcKwAAAACGGPgFqQF7ACQrAAAAAIYAswudA3sAAgABALcGAAABAOgGAAACAO8G",
  "AAADADAEAAABAOcFAAABAOcFAgACAAwEAgADAPcGAgAEABoEAgAFABUEAAABAOcFAAACAPwGAAADAAIHAAAEANQDAAAB",
  "AOcFAAABAOcFAAACAAgHAAABABUHAAABABUHAAABABoHAAACABUHAAABAOcFAAACACEHAAADAA8FAAABACoHAAACADAH",
  "AAADADYHAAAEAD4HAAAFAEUHAAAGAEgFAAABAFAHAAACAFYHAAABABUHAAABAOMDAAACAF8HAAADAGgHAAAEAFAHAAAF",
  "AFYHAAABAFAHAAACAFYHAgADAHsHAAABAAIHAAACAIQHAAABADAEAAACAFAHAAABAOcFAAACADAEAAADAO4FAAABAIoH",
  "AAACAJgHAAADAJIFAAABAOcFAAACADAEAAADAO4FAAAEAFAHAAAFAFYHAAABAOcFAAABAKUHAAACAFAHAAABALAHAAAC",
  "ALcHAAABAOcFAAACAL4HAgADAMMHAAAEAA8FAgAFAF8HAAABAOcFAAACAL4HAgADAMMHAAAEAA8FAgAFAF8HAAAGAMoH",
  "AAAHALAHAgABAMMHAgACAF8HAAADANMHAAABALAHAAACALcHAAABAL4HAAACAOMDAAADADAHAgAEAF8HAAABAL4HAAAC",
  "AOMDAAADADAHAgAEAF8HAAAFAMoHAAAGALAHAgABAF8HAAACAMMHAAABALAHAAACALcHAAABANwHAAABANwHAAACAMoH",
  "AAADALAHAAABANwHAAACAMMHAAABALAHAAACALcHAgABAOQHAgABAOQHAAACAMoHAAADALAHAgABAOQHAAACAMMHAAAB",
  "ALAHAAACALcHAAABAOcFAAACAL4HAAADAOMDAAAEADAHAgAFAF8HAAABAOcFAAACAL4HAAADAOMDAAAEADAHAgAFAF8H",
  "AAAGAMoHAAAHALAHAgABAF8HAAACAMMHAAABAPQFUQD4BakBWQD4BUYCYQD4BakBaQD4BUsCcQC+CFACeQDeCFQCiQD4",
  "CFsCiQD/CGECcQAICWgCkQD4BUsCcQAqCQoBcQAvCWwCiQBECXICKQBrCYQCoQB3CYkCqQCWCZICuQDJCaUCuQDcCWgC",
  "uQDnCaoCuQDvCa8CwQD+CbQCwQAOCrQCcQAdCr0CDAD4BakBFAD4BakBcQA7CtICiQA/CtgCDABOCmgCFAA7Ct8CcQBY",
  "CmwCiQBmCuUC0QCeCusCHAD4BakBHAA7CvcC6QDOCv8C8QD5CgQDAQH5CgQD2QAJCwoDqQD5ChADCQEaC5YBDAA7ChcD",
  "iQArC1ADiQA/C1UDIQFoC3wDKQByC70CKQGKC4ID0QCUC40DuQAvCZEDCQD4BakBHADMC6cDJAD4Ba0BDADhC7oDOQHt",
  "C+YDKQGKC+sDLAD4BakBQQH4CyIEDAAPDCcENAAdDD0EuQA6DEIEiQBBDFACuQBYCpEDIQD4BUYCCQD5Co0DWQH4BakB",
  "WQE7CgoDLAA7ChcDNABdDEsEYQFyDKkBLAB6DE8EaQH4BasEeQH4BbIEiQH4Bb0EmQH4BakBCAAEAA0ACAAIABIACAAM",
  "ABcACAAQABwACAAUACEADgAYACkALgATANIELgAbANsEgwFDAsQEowFDAsQEwwFDAsQE4wFDAsQEAwJDAsQEIwJLAs0E",
  "bgC5BHoCjQKYAp4CuQIdA1oDiQOXA8UD2gPyAwwEVQQIAAEAAADHBZoBAgAcAAMAWgigCKoIwQLMAvACrgMcBDEEAAED",
  "AIgBAQBAAQUAnAEBAEABBwCoAQEAQAEJALUBAQBEAQsAZwgBAEABDQDpAQEAQAEPAPUBAQBEAREAgggBAEQBEwCTCAEA",
  "QwEVACUCAQBAARcANAICAEABGQBJAgMABIAAAAAAAAAAAAAAAAAAAAAAKgAAAAQAAAAAAAAAAAAAAAEA8AAAAAAABAAA",
  "AAAAAAAAAAAAAQD5AAAAAAAEAAAAAAAAAAAAAAABACUKAAAAAAMAAgAEAAIABQACAAYAAgAHAAIACAACAAkAAgAKAAIA",
  "CwACAAwAAgANAAIADgACAA8AAgAQAAIAEQACAAAAAAAAPE1vZHVsZT4AVmVyaWRpYUJyb3dzZXJQcm9maWxlQ2Vuc3Vz",
  "LmRsbABWZXJpZGlhQnJvd3NlclByb2ZpbGVDZW5zdXMAVW5pY29kZQBTcGlQcmVmaXgAVmVyc2lvbgBTeXN0ZW1JbmZv",
  "AEJhc2ljSW5mb3JtYXRpb24ARmlsZVRpbWUATWVtb3J5Q291bnRlcnMAUmV0YWluZWQAUHJvdmlkZXJCaW5kaW5nAFF1",
  "ZXJ5QmFzaWMAUXVlcnlTeXN0ZW0AR2V0VmVyc2lvbgBRdWVyeVByZWNpc2VVdGMAUXVlcnlJbmZvcm1hdGlvbgBtc2Nv",
  "cmxpYgBTeXN0ZW0AT2JqZWN0AFZhbHVlVHlwZQBNdWx0aWNhc3REZWxlZ2F0ZQBTcGlDYXBhY2l0eQBTcGlIZWFkZXJT",
  "aXplAFNwaVRocmVhZFNpemUAU3BpTWF4Um93cwBTcGlNYXhJbWFnZUNoYXJzAFNwaUxheW91dFByb2ZpbGUAcHJvdmlk",
  "ZXJCaW5kaW5nAEdldE5hdGl2ZVN5c3RlbUluZm8AT3BlblByb2Nlc3MAR2V0UHJvY2Vzc0lkAEdldFByb2Nlc3NUaW1l",
  "cwBTeXN0ZW0uVGV4dABTdHJpbmdCdWlsZGVyAEltYWdlTmFtZQBDbG9zZUhhbmRsZQBXYWl0Rm9yU2luZ2xlT2JqZWN0",
  "AEdldE1vZHVsZUhhbmRsZQBMb2FkTGlicmFyeQBHZXRQcm9jQWRkcmVzcwBHZXRQcm9jZXNzTWVtb3J5SW5mbwBHZXRF",
  "eHRlbmRlZFRjcFRhYmxlAHF1ZXJ5QmFzaWMAcXVlcnlTeXN0ZW0AZ2V0VmVyc2lvbgBxdWVyeVByZWNpc2VVdGMAbnRk",
  "bGxNb2R1bGUALmNjdG9yAFN5c3RlbS5EaWFnbm9zdGljcwBTdG9wd2F0Y2gAUmVtYWluaW5nAFByZWNpc2VVdGNCb3Vu",
  "ZABTcGlWZXJzaW9uAFZhbGlkYXRlU3BpSW1hZ2UAU3lzdGVtLkNvbGxlY3Rpb25zLkdlbmVyaWMATGlzdGAxAERpY3Rp",
  "b25hcnlgMgBQYXJzZVNwaQBQcm9jZXNzZXMATGFzdFN0YWdlAFN0YWdlAElzQXBwcm92ZWRBYmkAUHJvY2Vzc1N0aWxs",
  "RXhpc3RzAFNhbWVIZWxkSWRlbnRpdHlFeGl0ZWQATWF5QXdhaXRSZXBvcnRlZEV4aXQAV2FpdEZvclNhbWVIZWxkRXhp",
  "dFdpdGhpbkJ1ZGdldABSZWFkQ29tbWFuZExpbmUAUmVhZFByb2ZpbGVSb3dzAGxlbmd0aABtYXhpbXVtAGJ1ZmZlcgBu",
  "ZXh0AHRocmVhZHMAc3BhcmUxAHNwYXJlMgBzcGFyZTMAY3JlYXRpb24AdXNlcgBrZXJuZWwAaW1hZ2UAcHJpb3JpdHkA",
  "cGlkAHBhcmVudABoYW5kbGVzAHNlc3Npb24AcGFnZURpcmVjdG9yeQBwZWFrVmlydHVhbAB2aXJ0dWFsU2l6ZQBmYXVs",
  "dHMAcGVha1dvcmtpbmcAd29ya2luZwBwZWFrUGFnZWQAcGFnZWQAcGVha05vblBhZ2VkAG5vblBhZ2VkAHBhZ2VmaWxl",
  "AHBlYWtQYWdlZmlsZQBwcml2YXRlUGFnZXMAcmVhZE9wcwB3cml0ZU9wcwBvdGhlck9wcwByZWFkQnl0ZXMAd3JpdGVC",
  "eXRlcwBvdGhlckJ5dGVzAHNpemUAbWFqb3IAbWlub3IAYnVpbGQAcGxhdGZvcm0Ac2VydmljZVBhY2sAYXJjaGl0ZWN0",
  "dXJlAHJlc2VydmVkAHBhZ2VTaXplAG1pbmltdW0AbWFzawBwcm9jZXNzb3JzAHR5cGUAZ3JhbnVsYXJpdHkAbGV2ZWwA",
  "cmV2aXNpb24AZXhpdFN0YXR1cwBwZWIAYWZmaW5pdHkAcGFyZW50UGlkAGxvdwBoaWdoAGdldF9WYWx1ZQBWYWx1ZQBw",
  "ZWFrV29ya2luZ1NldAB3b3JraW5nU2V0AGhhbmRsZQBiaXJ0aAByb3cALmN0b3IAc2VsZlBpZAB3cmFwcGVyUGlkAHNl",
  "bGZQYXJlbnQAd3JhcHBlclBhcmVudABzZWxmQmlydGgAd3JhcHBlckJpcnRoAHNlbGZOYW1lAHdyYXBwZXJOYW1lAHNl",
  "bGZDYW5vbmljYWxCaXJ0aAB3cmFwcGVyQ2Fub25pY2FsQmlydGgASW52b2tlAElBc3luY1Jlc3VsdABBc3luY0NhbGxi",
  "YWNrAEJlZ2luSW52b2tlAEVuZEludm9rZQBpbmZvAFN5c3RlbS5SdW50aW1lLkludGVyb3BTZXJ2aWNlcwBPdXRBdHRy",
  "aWJ1dGUAYWNjZXNzAGluaGVyaXQAZXhpdABmbGFncwB2YWx1ZQBtaWxsaXNlY29uZHMAbmFtZQBtb2R1bGUAY291bnRl",
  "cnMAdGFibGUAYnl0ZXMAb3JkZXJlZABmYW1pbHkAdGFibGVDbGFzcwB3YXRjaABidWRnZXRNcwByZXR1cm5lZAB1dGNC",
  "aXJ0aFVwcGVyQm91bmQAY292ZXJhZ2UAY2xvY2sAZXhhY3RJZGVudGl0eQBleGl0RmlsZVRpbWUAZXhlY3V0YWJsZQBv",
  "YmplY3QAbWV0aG9kAGtpbmQAcmVzdWx0AGNhbGxiYWNrAF9fcmVzdWx0AHZlcnNpb24AdGltZQBTeXN0ZW0uUnVudGlt",
  "ZS5Db21waWxlclNlcnZpY2VzAENvbXBpbGF0aW9uUmVsYXhhdGlvbnNBdHRyaWJ1dGUAUnVudGltZUNvbXBhdGliaWxp",
  "dHlBdHRyaWJ1dGUARGxsSW1wb3J0QXR0cmlidXRlAGtlcm5lbDMyLmRsbABRdWVyeUZ1bGxQcm9jZXNzSW1hZ2VOYW1l",
  "VwBHZXRNb2R1bGVIYW5kbGVXAExvYWRMaWJyYXJ5VwBwc2FwaS5kbGwAaXBobHBhcGkuZGxsAEludFB0cgBnZXRfU2l6",
  "ZQBUeXBlAFJ1bnRpbWVUeXBlSGFuZGxlAEdldFR5cGVGcm9tSGFuZGxlAE1hcnNoYWwAU2l6ZU9mAE9mZnNldE9mAFRv",
  "SW50MzIASW52YWxpZE9wZXJhdGlvbkV4Y2VwdGlvbgBaZXJvAG9wX0VxdWFsaXR5AERlbGVnYXRlAEdldERlbGVnYXRl",
  "Rm9yRnVuY3Rpb25Qb2ludGVyAFRpbWVTcGFuAGdldF9FbGFwc2VkAGdldF9Ub3RhbE1pbGxpc2Vjb25kcwBEYXRlVGlt",
  "ZQBGcm9tRmlsZVRpbWVVdGMAQXJndW1lbnRPdXRPZlJhbmdlRXhjZXB0aW9uAFN0cmluZwBJc051bGxPcldoaXRlU3Bh",
  "Y2UAZ2V0X0xlbmd0aABJbmRleE9mAGdldF9DaGFycwBDaGFyAElzSGlnaFN1cnJvZ2F0ZQBJc0xvd1N1cnJvZ2F0ZQBU",
  "b0ludDY0AFN5c3RlbS5Db3JlAEhhc2hTZXRgMQBBZGQAUHRyVG9TdHJ1Y3R1cmUAZ2V0X0NvdW50AG9wX0luZXF1YWxp",
  "dHkAUHRyVG9TdHJpbmdVbmkARXhjZXB0aW9uAFN5c3RlbS5Db2xsZWN0aW9ucwBJRGljdGlvbmFyeQBnZXRfRGF0YQBJ",
  "bnQzMgBTeXN0ZW0uR2xvYmFsaXphdGlvbgBDdWx0dXJlSW5mbwBnZXRfSW52YXJpYW50Q3VsdHVyZQBJbnQ2NABJRm9y",
  "bWF0UHJvdmlkZXIAVG9TdHJpbmcAVUludDY0AHNldF9JdGVtAFVJbnRQdHIAVG9VSW50NjQAQm9vbGVhbgBBbGxvY0hH",
  "bG9iYWwAVUludDMyAEZyZWVIR2xvYmFsAENvbnNvbGUAU3lzdGVtLklPAFRleHRXcml0ZXIAZ2V0X0Vycm9yAGdldF9F",
  "bGFwc2VkTWlsbGlzZWNvbmRzAFdyaXRlTGluZQBnZXRfTWVzc2FnZQA8PmNfX0Rpc3BsYXlDbGFzczQAPFByb2Nlc3NT",
  "dGlsbEV4aXN0cz5iX18zAGdldF9JdGVtAFByZWRpY2F0ZWAxAEV4aXN0cwBNYXRoAEZsb29yAFBhdGgAR2V0RmlsZU5h",
  "bWUARW51bWVyYXRvcgBHZXRFbnVtZXJhdG9yAGdldF9DdXJyZW50AFN0cmluZ0NvbXBhcmlzb24ARXF1YWxzAEdldExh",
  "c3RXaW4zMkVycm9yAEhhc2h0YWJsZQBNb3ZlTmV4dABJRGlzcG9zYWJsZQBEaXNwb3NlAFRvQXJyYXkAU3RydWN0TGF5",
  "b3V0QXR0cmlidXRlAExheW91dEtpbmQATWFyc2hhbEFzQXR0cmlidXRlAFVubWFuYWdlZFR5cGUAVW5tYW5hZ2VkRnVu",
  "Y3Rpb25Qb2ludGVyQXR0cmlidXRlAENhbGxpbmdDb252ZW50aW9uAENvbXBpbGVyR2VuZXJhdGVkQXR0cmlidXRlAAAA",
  "EWMAcgBlAGEAdABpAG8AbgAAC2kAbQBhAGcAZQAAB3AAaQBkAAANcABhAHIAZQBuAHQAAA93AG8AcgBrAGkAbgBnAAAz",
  "TgBBAFQASQBWAEUAXwBMAEEAWQBPAFUAVABfAFUATgBTAFUAUABQAE8AUgBUAEUARAAAE24AdABkAGwAbAAuAGQAbABs",
  "AAAxTgBBAFQASQBWAEUAXwBOAFQARABMAEwAXwBVAE4AQQBWAEEASQBMAEEAQgBMAEUAADNOAHQAUQB1AGUAcgB5AEkA",
  "bgBmAG8AcgBtAGEAdABpAG8AbgBQAHIAbwBjAGUAcwBzAAA/TgBBAFQASQBWAEUAXwBCAEEAUwBJAEMAXwBFAFgAUABP",
  "AFIAVABfAFUATgBBAFYAQQBJAEwAQQBCAEwARQAAMU4AdABRAHUAZQByAHkAUwB5AHMAdABlAG0ASQBuAGYAbwByAG0A",
  "YQB0AGkAbwBuAAA7UwBQAEkAXwBTAFkAUwBUAEUATQBfAEUAWABQAE8AUgBUAF8AVQBOAEEAVgBBAEkATABBAEIATABF",
  "AAAbUgB0AGwARwBlAHQAVgBlAHIAcwBpAG8AbgAAPVMAUABJAF8AVgBFAFIAUwBJAE8ATgBfAEUAWABQAE8AUgBUAF8A",
  "VQBOAEEAVgBBAEkATABBAEIATABFAAAZawBlAHIAbgBlAGwAMwAyAC4AZABsAGwAAD1HAGUAdABTAHkAcwB0AGUAbQBU",
  "AGkAbQBlAFAAcgBlAGMAaQBzAGUAQQBzAEYAaQBsAGUAVABpAG0AZQAARVMAUABJAF8AUABSAEUAQwBJAFMARQBfAFUA",
  "VABDAF8ARQBYAFAATwBSAFQAXwBVAE4AQQBWAEEASQBMAEEAQgBMAEUAACtOAEEAVABJAFYARQBfAFEAVQBFAFIAWQBf",
  "AEQARQBBAEQATABJAE4ARQAAO1MAUABJAF8AUABSAEUAQwBJAFMARQBfAFUAVABDAF8AQgBPAFUATgBEAF8ASQBOAFYA",
  "QQBMAEkARAAAK1MAUABJAF8AVQBOAEEAUABQAFIATwBWAEUARABfAE8AUwBfAEEAQgBJAAAtUwBQAEkAXwBJAE0AQQBH",
  "AEUAXwBOAEEATQBFAF8ASQBOAFYAQQBMAEkARAAAL1MAUABJAF8ASQBNAEEARwBFAF8AVQBUAEYAMQA2AF8ASQBOAFYA",
  "QQBMAEkARAAAM1MAUABJAF8AUgBFAFQAVQBSAE4AXwBMAEUATgBHAFQASABfAEkATgBWAEEATABJAEQAADFTAFAASQBf",
  "AEUATgBUAFIAWQBfAEIATwBVAE4ARABTAF8ASQBOAFYAQQBMAEkARAAAQ1MAUABJAF8AVABIAFIARQBBAEQAXwBPAFIA",
  "XwBOAEUAWABUAF8AQgBPAFUATgBEAFMAXwBJAE4AVgBBAEwASQBEAAA5UwBQAEkAXwBJAE4AVgBFAE4AVABPAFIAWQBf",
  "AEwASQBNAEkAVABfAEUAWABDAEUARQBEAEUARAAAOVMAUABJAF8AUABJAEQAXwBJAE4AVgBBAEwASQBEAF8ATwBSAF8A",
  "RABVAFAATABJAEMAQQBUAEUAADNTAFAASQBfAEkARABMAEUAXwBTAEUATgBUAEkATgBFAEwAXwBJAE4AVgBBAEwASQBE",
  "AAA1UwBQAEkAXwBVAE4ASQBDAE8ARABFAF8AQgBPAFUATgBEAFMAXwBJAE4AVgBBAEwASQBEAABHUwBQAEkAXwBCAEkA",
  "UgBUAEgAXwBPAFUAVABTAEkARABFAF8AQwBBAFAAVABVAFIARQBfAFUAVABDAF8AQgBPAFUATgBEAAAjYgBpAHIAdABo",
  "AEcAdQBhAHIAZABGAGEAaQBsAHUAcgBlAAANYgByAGEAbgBjAGgAAC9BAEYAVABFAFIAXwBQAFIARQBDAEkAUwBFAF8A",
  "VQBUAEMAXwBCAE8AVQBOAEQAACVOAE8ATgBfAFAATwBTAEkAVABJAFYARQBfAEIASQBSAFQASAAAE3AAYQByAGUAbgB0",
  "AFAAaQBkAAAdYwByAGUAYQB0AGkAbwBuAFMAaQBnAG4AZQBkAAAldQB0AGMAQgBpAHIAdABoAFUAcABwAGUAcgBCAG8A",
  "dQBuAGQAABdjAGwAbwBjAGsAUwBvAHUAcgBjAGUAAElHAEUAVABfAFMAWQBTAFQARQBNAF8AVABJAE0ARQBfAFAAUgBF",
  "AEMASQBTAEUAXwBBAFMAXwBGAEkATABFAF8AVABJAE0ARQAAOXkAeQB5AHkALQBNAE0ALQBkAGQAVABIAEgAOgBtAG0A",
  "OgBzAHMALgBmAGYAZgBmAGYAZgBmAFoAAT9TAFAASQBfAFcATwBSAEsASQBOAEcAXwBTAEUAVABfAFUATgBSAEUAUABS",
  "AEUAUwBFAE4AVABBAEIATABFAAAJbgBhAG0AZQAAE2MAcgBlAGEAdABlAGQAQQB0AAAhbgBhAHQAaQB2AGUAQgBpAHIA",
  "dABoAFMAdABhAG0AcAAAH3cAbwByAGsAaQBuAGcAUwBlAHQAQgB5AHQAZQBzAAApbgBhAHQAaQB2AGUASQBkAGUAbgB0",
  "AGkAdAB5AFMAdABhAHQAdQBzAABXUwBOAEEAUABTAEgATwBUAF8ATwBOAEwAWQBfAEIASQBSAFQASABfAFAAQQBSAEUA",
  "TgBUAF8ATgBBAE0ARQBfAE8AQgBTAEUAUgBWAEEAVABJAE8ATgAAPVMAUABJAF8ASQBEAEwARQBfAFMARQBOAFQASQBO",
  "AEUATABfAE4ATwBfAEEAVQBUAEgATwBSAEkAVABZAAAncABhAHIAZQBuAHQASQBkAGUAbgB0AGkAdAB5AFAAcgBvAG8A",
  "ZgAAX1MAUABJAF8AUwBOAEEAUABTAEgATwBUAF8AQgBJAFIAVABIAF8AUABBAFIARQBOAFQAXwBOAEEATQBFAF8ATwBC",
  "AFMARQBSAFYAQQBUAEkATwBOAF8ATwBOAEwAWQAAIWwAaQB2AGUAQQB0AEMAYQBwAHQAdQByAGUARQBuAGQAACVvAHcA",
  "bgBlAHIAcwBoAGkAcABBAHUAdABoAG8AcgBpAHQAeQAAJ1MAUABJAF8ARQBNAFAAVABZAF8ASQBOAFYARQBOAFQATwBS",
  "AFkAADNTAFAASQBfAFEAVQBFAFIAWQBfAE4AVABTAFQAQQBUAFUAUwBfAEYAQQBJAEwARQBEAAAPbwBzAEIAdQBpAGwA",
  "ZAAAGWEAcgBjAGgAaQB0AGUAYwB0AHUAcgBlAAALQQBNAEQANgA0AAAbbABhAHkAbwB1AHQAUAByAG8AZgBpAGwAZQAA",
  "dVMAUABJAF8AWAA2ADQAXwBQAFIARQBGAEkAWAAyADUANgBfAFQASABSAEUAQQBEADgAMABfAEMAUgBFAEEAVABFADMA",
  "MgBfAEkATQBBAEcARQA1ADYAXwBQAEkARAA4ADAAXwBQAEEAUgBFAE4AVAA4ADgAABdxAHUAZQByAHkAUwB0AGEAdAB1",
  "AHMAABlyAGUAdAB1AHIAbgBMAGUAbgBnAHQAaAAAHWIAdQBmAGYAZQByAEMAYQBwAGEAYwBpAHQAeQAAI2kAbgB2AGUA",
  "bgB0AG8AcgB5AEMAbwBtAHAAbABlAHQAZQAAOXMAbgBhAHAAcwBoAG8AdABDAG8AbQBwAGwAZQB0AGUAZABVAHQAYwBG",
  "AGkAbABlAFQAaQBtAGUAAEdWAEUAUgBJAEQASQBBAF8AUABSAE8ARgBJAEwARQBfAFAAUgBPAEIARQBfAFMAVABBAEcA",
  "RQA9AHsAMAB9ADoAewAxAH0AAGtWAEUAUgBJAEQASQBBAF8AUABSAE8ARgBJAEwARQBfAFAAUgBPAEIARQBfAEUAWABJ",
  "AFQAXwBKAE8ASQBOAD0AewAwAH0AOgB7ADEAfQA6AHsAMgB9ADoAUwBUAEEAUgBUADoAewAzAH0AAGdWAEUAUgBJAEQA",
  "SQBBAF8AUABSAE8ARgBJAEwARQBfAFAAUgBPAEIARQBfAEUAWABJAFQAXwBKAE8ASQBOAD0AewAwAH0AOgB7ADEAfQA6",
  "AHsAMgB9ADoAewAzAH0AOgB7ADQAfQAAO1AAUgBPAEYASQBMAEUAXwBPAFcATgBFAFIAUwBIAEkAUABfAFUATgBBAFYA",
  "QQBJAEwAQQBCAEwARQAAI1MAUABJAF8AQwBBAFAAVABVAFIARQBfAEUATgBUAEUAUgAAJVMAUABJAF8AQwBBAFAAVABV",
  "AFIARQBfAFIARQBUAFUAUgBOAAArUwBQAEkAXwBIAEUATABEAF8AUABSAE8AQwBFAFMAUwBfAE8AUABFAE4AAGNWAEUA",
  "UgBJAEQASQBBAF8AUABSAE8ARgBJAEwARQBfAFAAUgBPAEIARQBfAEMARQBOAFMAVQBTAF8ATwBQAEUATgA9AHsAMAB9",
  "ADoAewAxAH0AOgB7ADIAfQA6AHsAMwB9AAALRgBBAEwAUwBFAAAJVABSAFUARQAAM1MAUABJAF8AVgBFAFIASQBGAEkA",
  "RQBEAF8AQQBCAFMARQBOAEMARQBfAFMASwBJAFAAAD9MAEkAVgBFAF8AUABSAE8AQwBFAFMAUwBfAEgAQQBOAEQATABF",
  "AF8AVQBOAEEAVgBBAEkATABBAEIATABFAAA3TABJAFYARQBfAFAAUgBPAEMARQBTAFMAXwBCAEkAUgBUAEgAXwBNAEkA",
  "UwBNAEEAVABDAEgAAB1TAFAASQBfAEkATQBBAEcARQBfAFIARQBBAEQAAH1WAEUAUgBJAEQASQBBAF8AUABSAE8ARgBJ",
  "AEwARQBfAFAAUgBPAEIARQBfAEMARQBOAFMAVQBTAF8ASQBNAEEARwBFAD0AewAwAH0AOgB7ADEAfQA6AHsAMgB9ADoA",
  "ewAzAH0AOgB7ADQAfQA6AHsANQB9ADoAewA2AH0AAHlWAEUAUgBJAEQASQBBAF8AUABSAE8ARgBJAEwARQBfAFAAUgBP",
  "AEIARQBfAEMARQBOAFMAVQBTAF8ASQBNAEEARwBFAF8AUwBUAEEAVABFAD0AewAwAH0AOgB7ADEAfQA6AHsAMgB9ADoA",
  "ewAzAH0AOgB7ADQAfQAAIVMAUABJAF8ASQBNAEEARwBFAF8AUgBFAFQAVQBSAE4AACtTAFAASQBfAEMATwBNAE0AQQBO",
  "AEQAXwBMAEkATgBFAF8AUgBFAEEARAAAL1MAUABJAF8AQwBPAE0ATQBBAE4ARABfAEwASQBOAEUAXwBSAEUAVABVAFIA",
  "TgAAE1AAcgBvAGMAZQBzAHMASQBkAAAfUABhAHIAZQBuAHQAUAByAG8AYwBlAHMAcwBJAGQAAB1FAHgAZQBjAHUAdABh",
  "AGIAbABlAFAAYQB0AGgAABdDAG8AbQBtAGEAbgBkAEwAaQBuAGUAABlDAHIAZQBhAHQAaQBvAG4ARABhAHQAZQAAMU4A",
  "YQB0AGkAdgBlAFMAbgBhAHAAcwBoAG8AdABCAGkAcgB0AGgAUwB0AGEAbQBwAAAtUwBQAEkAXwBWAEUAUgBJAEYASQBF",
  "AEQAXwBFAFgASQBUAF8AUwBLAEkAUAAAMVMAUABJAF8ASABFAEwARABfAFAAUgBPAEMARQBTAFMAXwBEAEkAUwBQAE8A",
  "UwBFAABFTgBBAFQASQBWAEUAXwBQAFIATwBDAEUAUwBTAF8ASABBAE4ARABMAEUAXwBDAEwATwBTAEUAXwBGAEEASQBM",
  "AEUARAAAAAAAA59vFhkCgUKGyG1UMcRsKgAIt3pcVhk04IkCBggEAACAAAQAAQAABFAAAAAEAIAAAAQEAQAAAgYOdFMA",
  "UABJAF8AWAA2ADQAXwBQAFIARQBGAEkAWAAyADUANgBfAFQASABSAEUAQQBEADgAMABfAEMAUgBFAEEAVABFADMAMgBf",
  "AEkATQBBAEcARQA1ADYAXwBQAEkARAA4ADAAXwBQAEEAUgBFAE4AVAA4ADgAAwYSLAYAAQEQERgGAAMYCQIJBAABCRgQ",
  "AAUCGBARIBARIBARIBARIAkABAIYCRIREAkEAAECGAUAAgkYCQQAARgOBQACGBgOCAADAhgQESQJCgAGCRgQCQIJCAkD",
  "BhIwAwYSNAMGEjgDBhI8AgYYAwAAAQYAAgESFQgDAAALAwAACQQAAQEOEgAFFRIZARUSHQIOHBgJCxIVCBYAAxUSGQEV",
  "Eh0CDhwSFQgQFRIdAg4cBgACAQ4SFQMAAAIGAAICCBIVBgADAhgIDgYAAwICCwgJAAUCGAgOEhUIBAABDhgHAAIdHA4S",
  "FQIGBwIGCQIGCgMGEQwCBhkDIAALAygACwIGCwcGFRIdAg4cAyAAAQUgAgEcGAsgBQgYCBARHAkQCQ8gBxIhGAgQERwJ",
  "EAkSJRwKIAMIEBEcEAkSIQggBAgIGAkQCQwgBhIhCBgJEAkSJRwHIAIIEAkSIQYgAQgQERQKIAMSIRARFBIlHAggAggQ",
  "ERQSIQYgAQEQESAKIAMSIRARIBIlHAggAgEQESASIQkgBQgYCBgJEAkNIAcSIRgIGAkQCRIlHAQgAQEIBCABAQ4DAAAI",
  "BgABEj0RQQUAAQgSPQYAAhgSPQ4DIAAIBQACAhgYBwACEk0YEj0JBwcYGBgYGBgYBCAAEVEDIAANBAcBEVEFAAERVQoF",
  "BwIRIAsGBwIRGBEUBAABAg4EIAEIAwQgAQMIBAABAgMDBwEIAyAACgoVEhkBFRIdAg4cBRUSZQEIBQACGBgIBgACHBgS",
  "PQUgAQITAAUAAg4YCAQgABJtBhUSHQIOHAcgAgETABMBBAAAEnUFIAEOEn0FIAIBHBwGIAIODhJ9BSABARMAMgcWCgoI",
  "FRIZARUSHQIOHBUSZQEIERAKCgoOCgoKCg4OEkkVEh0CDhwLCxUSHQIOHBFVBAABGAgEAAEBGCEHCAkYCQgLFRIZARUS",
  "HQIOHBUSHQIOHBUSGQEVEh0CDhwFAAASgJUGIAMBDhwcAwcBCgMgAA4FAAICDg4FBwISSQIJIAECFRIdAg4cBiABEwET",
  "AAsVEoCZARUSHQIOHAogAQIVEoCZARMAFAcDFRIdAg4cFRIZARUSHQIOHBJECwcFESARIBEgESALBAABDQ0GIAIBDh0c",
  "GQcPESARIBEgESARHAkCDQkJAgsRUR0cHRwPBwsYEkAYCQgRDAoKCg4OBRUSGQEcBAABDg4JIAAVEYClARMACxURgKUB",
  "FRIdAg4cBCAAEwAIAAMCDg4RgKkDIAACBSAAHRMAVQciFRIdAg4cFRIZARUSHQIOHBUSGQEcDhUSHQIOHBgIAhEcCREg",
  "ESARIBEgEhEJAggRIBEgESARIAIODhKArRJJFRGApQEVEh0CDhwdHAsLHRwdHAsGIAEBEYC5BiABARGAwQMXgIAGIAEB",
  "EYDJCAEAAQAAAAAABAEAAAAIAQAIAAAAAAAeAQABAFQCFldyYXBOb25FeGNlcHRpb25UaHJvd3MBAADkZgAAAAAAAAAA",
  "AAD+ZgAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA8GYAAAAAAAAAAAAAAABfQ29yRGxsTWFpbgBtc2NvcmVlLmRsbAAA",
  "AAAA/yUAIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAEAAAABgAAIAAAAAAAAAA",
  "AAAAAAAAAAEAAQAAADAAAIAAAAAAAAAAAAAAAAAAAAEAAAAAAEgAAABYgAAAlAIAAAAAAAAAAAAAlAI0AAAAVgBTAF8A",
  "VgBFAFIAUwBJAE8ATgBfAEkATgBGAE8AAAAAAL0E7/4AAAEAAAAAAAAAAAAAAAAAAAAAAD8AAAAAAAAABAAAAAIAAAAA",
  "AAAAAAAAAAAAAABEAAAAAQBWAGEAcgBGAGkAbABlAEkAbgBmAG8AAAAAACQABAAAAFQAcgBhAG4AcwBsAGEAdABpAG8A",
  "bgAAAAAAAACwBPQBAAABAFMAdAByAGkAbgBnAEYAaQBsAGUASQBuAGYAbwAAANABAAABADAAMAAwADAAMAA0AGIAMAAA",
  "ACwAAgABAEYAaQBsAGUARABlAHMAYwByAGkAcAB0AGkAbwBuAAAAAAAgAAAAMAAIAAEARgBpAGwAZQBWAGUAcgBzAGkA",
  "bwBuAAAAAAAwAC4AMAAuADAALgAwAAAAYAAgAAEASQBuAHQAZQByAG4AYQBsAE4AYQBtAGUAAABWAGUAcgBpAGQAaQBh",
  "AEIAcgBvAHcAcwBlAHIAUAByAG8AZgBpAGwAZQBDAGUAbgBzAHUAcwAuAGQAbABsAAAAKAACAAEATABlAGcAYQBsAEMA",
  "bwBwAHkAcgBpAGcAaAB0AAAAIAAAAGgAIAABAE8AcgBpAGcAaQBuAGEAbABGAGkAbABlAG4AYQBtAGUAAABWAGUAcgBp",
  "AGQAaQBhAEIAcgBvAHcAcwBlAHIAUAByAG8AZgBpAGwAZQBDAGUAbgBzAHUAcwAuAGQAbABsAAAANAAIAAEAUAByAG8A",
  "ZAB1AGMAdABWAGUAcgBzAGkAbwBuAAAAMAAuADAALgAwAC4AMAAAADgACAABAEEAcwBzAGUAbQBiAGwAeQAgAFYAZQBy",
  "AHMAaQBvAG4AAAAwAC4AMAAuADAALgAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAwAAAAQNwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
].join("");
