// Immutable .NET 4 read-only profile census. No runtime compilation, prewarm or process termination.
export const WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE_SHA256 = "c10edffe9c28aac0b096077f857560d570fe43de7903b44ef9586000e411f131";
export const WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_SHA256 = "99a4fb9826798c95ddbab7c9b394147f67fa4e509afcec25ea6bd70cc9efa884";
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
          FileTime diagnosticCreation,diagnosticExit,diagnosticKernel,diagnosticUser;
          bool sameIdentity=GetProcessId(handle)==(uint)(int)row["pid"] &&
            GetProcessTimes(handle,out diagnosticCreation,out diagnosticExit,out diagnosticKernel,out diagnosticUser) &&
            diagnosticCreation.Value.ToString(CultureInfo.InvariantCulture)==(string)row["nativeBirthStamp"];
          Console.Error.WriteLine("VERIDIA_PROFILE_PROBE_CENSUS_IMAGE={0}:{1}:{2}:{3}:{4}:{5}:{6}",
            row["pid"],row["nativeBirthStamp"],imageError,imageRead?"TRUE":"FALSE",length,sameIdentity?"TRUE":"FALSE",WaitForSingleObject(handle,0));
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
             !SameHeldIdentityExited(handle,(int)row["pid"],(string)row["nativeBirthStamp"]))throw;
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
  "YgJ7SQAABG5gKh4CKDEAAAoqHgIoMQAACipCU0pCAQABAAAAAAAMAAAAdjQuMC4zMDMxOQAAAAAFAGwAAACADQAAI34A",
  "AOwNAAC4DAAAI1N0cmluZ3MAAAAApBoAAHAPAAAjVVMAFCoAABAAAAAjR1VJRAAAACQqAADIBAAAI0Jsb2IAAAAAAAAA",
  "AgAAAVc9oh0JAgAAAPolMwAWAAABAAAAMgAAABEAAABjAAAAMgAAAHMAAABIAAAABgAAAAgAAAABAAAADQAAAAEAAAAB",
  "AAAAAQAAAAMAAAAGAAAADAAAAAEAAAADAAAADwAAAAAACgABAAAAAAAGAAAB+QAGAAcB+QAGABEB+QAGANEBxQEKALUC",
  "ogIGABAD9QIGABcD9QIGAFEG+QAGAF4G+QAGAKYGhwYGALkHmQcGANkHmQcGAPcHhwYGAGcI+QAGAHcI+QAGAHwI+QAG",
  "AKAIhwYGAMAI+QAGAOsI+QAGABIJ+QAGAD0J+QAGAFYJ+QAGAHIJ+QAGAKkJ+QAOAOEJ9QIGACUK+QAGAEIKLwoGAFcK",
  "+QAGAHIKXQoGAJMK+QAGAJkK+QAGALIK+QAGAMIK+QAGANMK+QAGAOgK+QAGAPsK+QAGAA0LAwsGAIUL+QAGAJgLAwsb",
  "AKkLAAAGAM4L+QAGAPgLLwoGAAsM+QAGACcMhwYGAD0MhwYGAEgMhwYGAFsMhwYGAGkMhwYGAIsMhwYGAJ0MmQcAAAAA",
  "AQAAAAAAAQABAIEBAAAqAAAABQABAAEACwEQAEYAAAAJAA4AGgALARAATgAAAAkAEQAaAAsBEQBYAAAACQAyABoACwEQ",
  "AGAAAAAJADgAGgALARAAawAAAAkAQwAaAAsBEAB8AAAACQBJABoACwEQAIUAAAAJAEsAGwADARAAlAAAAAUAVQAbAAMB",
  "EACdAAAABQBZABwAAwEAAK0AAAANAGMAHQADAQAAuAAAAA0AYwAhAAMBAADEAAAADQBjACUAAwEAAM8AAAANAGMAKQAD",
  "AQAA3wAAAA0AYwAtAAMBEABQCwAABQBjADEAUYAjAQoAUYAvAQoAUYA9AQoAUYBLAQoAUYBWAQoAUYBnASYAEQB4AZ4A",
  "MQBdAvoAMQBoAv4AMQB0AgIBMQB/AgYBMQCPAgoBFgA3AyYABgCfA3UBBgCmA3UBBgCuAwoBBgC1A3gBBgC6A3gBBgDC",
  "A3sBBgDJA3sBBgDQA3sBBgDXA3sBBgDgA3sBBgDlA3sBBgDsA34BBgDyAwoABgD7AwoBBgD/AwoBBgAGBHgBBgAOBHgB",
  "BgAWBIIBBgAkBIIBBgAwBIIBBgA8BHgBBgBDBIIBBgBPBIIBBgBXBIIBBgBhBIIBBgBnBIIBBgB0BIIBBgB9BIIBBgCG",
  "BIIBBgCTBIIBBgCgBHsBBgCoBHsBBgCxBHsBBgC6BHsBBgDEBHsBBgDPBHsBBgDaBHgBBgDfBHgBBgDlBHgBBgDrBHgB",
  "BgDxBHgBBhD6BCYABgAGBXUBBgATBXUBBgAcBXgBBgAlBQoBBgCmAwoBBgAtBYIBBgAyBXgBBgA9BXgBBgBCBXgBBgBO",
  "BXUBBgBUBXUBBgBdBQoABgBoBQoBBgBsBYIBBgDyAwoABgD7A4IBBgB1BYIBBgB/BXgBBgCDBXgBBgDaBHgBBgA8BHgB",
  "BgCYBYIBBgCnBYIBBgBXBIIBBgBhBIIBBgBnBIIBBgB0BIIBBgB9BIIBBgCGBIIBBgCyBQoBBgD7A3gBBgC5BY0BBgC/",
  "BZABBgDJBQoABgDRBQoABgDcBQoABgDnBQoABgD1BY0BBgD/BY0BBgAMBiYABgAVBiYABgAhBiYABgA0BiYABgD7AwoA",
  "AAAAAIAAkSCIAaIAAQAAAAAAgACRIJwBqQACAAAAAACAAJEgqAGwAAUAAAAAAIAAkSC1AbUABgAAAAAAgACRIN8BxgAL",
  "AAAAAACAAJEg6QHQAA8AAAAAAIAAkSD1AdUAEAAAAAAAgACRIAkC2wASAAAAAACAAJEgGQLbABMAAAAAAIAAkSAlAuAA",
  "FAAAAAAAgACRIDQC5gAWAAAAAACAAJEgSQLvABkAUCAAAAAAkRibAg0BHwC8IgAAAACRAL8CEQEfAOgiAAAAAJEAyQIY",
  "ASEATCMAAAAAkQDZAhwBIQDcIwAAAACRAOQCIAEhAJAkAAAAAJEAJAMlASIAZCkAAAAAkQAtAzgBJwCgKgAAAACRAEED",
  "TwEqANgqAAAAAJYARwNWASwAQCsAAAAAlgBVA1oBLAB8KwAAAACRAGgDYQEuAMwrAAAAAJEAfwNoATEANC0AAAAAlgCP",
  "A20BMgD8MgAAAACGCIgFhQE0ABAzAAAAAIYYwwWYATQAGDMAAAAAhhjDBZgBNAAAAAAAAwCGGMMFnAE0AAAAAAADAMYB",
  "SgaiATYAAAAAAAMAxgFsBq4BOwAAAAAAAwDGAXgGvgFCAAAAAAADAIYYwwWcAUUAAAAAAAMAxgFKBskBRwAAAAAAAwDG",
  "AWwG0gFLAAAAAAADAMYBeAbfAVEAAAAAAAMAhhjDBZwBUwAAAAAAAwDGAUoG5wFVAAAAAAADAMYBbAbuAVYAAAAAAAMA",
  "xgF4BvkBWQAAAAAAAwCGGMMFnAFbAAAAAAADAMYBSgYCAl0AAAAAAAMAxgFsBgkCXgAAAAAAAwDGAXgGFAJhAAAAAAAD",
  "AIYYwwWcAWMAAAAAAAMAxgFKBh0CZQAAAAAAAwDGAWwGJwJqAAAAAAADAMYBeAbfAXEAHCsAAAAAhhjDBZgBcwAkKwAA",
  "AACGAGMLjANzAAIAAQCCBgAAAQCzBgAAAgC6BgAAAwD7AwAAAQCyBQAAAQCyBQIAAgDXAwIAAwDCBgIABADlAwIABQDg",
  "AwAAAQCyBQAAAgDHBgAAAwDNBgAABACfAwAAAQCyBQAAAQCyBQAAAgDTBgAAAQDgBgAAAQDgBgAAAQDlBgAAAgDgBgAA",
  "AQCyBQAAAgDsBgAAAwDaBAAAAQD1BgAAAgD7BgAAAwABBwAABAAJBwAABQAQBwAABgATBQAAAQAbBwAAAgAhBwAAAQDg",
  "BgAAAQCuAwAAAgAqBwAAAwAzBwAABAAbBwAABQAhBwAAAQAbBwAAAgAhBwIAAwBGBwAAAQDNBgAAAgBPBwAAAQD7AwAA",
  "AgAbBwAAAQCyBQAAAgD7AwAAAwC5BQAAAQCyBQAAAQBVBwAAAgAbBwAAAQBgBwAAAgBnBwAAAQCyBQAAAgBuBwIAAwBz",
  "BwAABADaBAIABQAqBwAAAQCyBQAAAgBuBwIAAwBzBwAABADaBAIABQAqBwAABgB6BwAABwBgBwIAAQBzBwIAAgAqBwAA",
  "AwCDBwAAAQBgBwAAAgBnBwAAAQBuBwAAAgCuAwAAAwD7BgIABAAqBwAAAQBuBwAAAgCuAwAAAwD7BgIABAAqBwAABQB6",
  "BwAABgBgBwIAAQAqBwAAAgBzBwAAAQBgBwAAAgBnBwAAAQCMBwAAAQCMBwAAAgB6BwAAAwBgBwAAAQCMBwAAAgBzBwAA",
  "AQBgBwAAAgBnBwIAAQCUBwIAAQCUBwAAAgB6BwAAAwBgBwIAAQCUBwAAAgBzBwAAAQBgBwAAAgBnBwAAAQCyBQAAAgBu",
  "BwAAAwCuAwAABAD7BgIABQAqBwAAAQCyBQAAAgBuBwAAAwCuAwAABAD7BgIABQAqBwAABgB6BwAABwBgBwIAAQAqBwAA",
  "AgBzBwAAAQC/BVEAwwWYAVkAwwU1AmEAwwWYAWkAwwU6AnEAbgg/AnkAjghDAokAqAhKAokArwhQAnEAuAhXApEAwwU6",
  "AnEA2ggKAXEA3whbAokA9AhhAikAGwlzAqEAJwl4AqkARgmBArkAeQmUArkAjAlXArkAlwmZArkAnwmeAsEArgmjAsEA",
  "vgmjAnEAzQmsAgwAwwWYARQAwwWYAXEA6wnBAokA7wnHAgwA/glXAhQA6wnOAnEACApbAokAFgrUAtEATgraAhwAwwWY",
  "ARwA6wnmAukAfgruAvEAqQrzAgEBqQrzAtkAuQr5AqkAqQr/AgkBygqFAQwA6wkGA4kA2wo/A4kA7wpEAyEBGAtrAykA",
  "IgusAikBOgtxA9EARAt8A7kA3wiAAwkAwwWYARwAfAuWAyQAwwWcAQwAkQupAywAwwWYATkBnQvrAwwAtAvwAzQAwgsG",
  "BLkA3wsLBIkA5gs/AikBOgsUBLkACAqAAyEAwwU1AgkAqQp8A1EBwwWYAVEB6wn5AiwA6wkGAzQAAgwbBFkBFwyYASwA",
  "HwwfBGEBwwV5BHEBwwWABIEBwwWLBJEBwwWYAQgABAANAAgACAASAAgADAAXAAgAEAAcAAgAFAAhAA4AGAApAC4AEwCg",
  "BC4AGwCpBIMBOwKSBKMBOwKSBMMBOwKSBOMBOwKSBAMCOwKSBCMCQwKbBG4AhwRpAnwChwKNAqgCDANJA3gDhgO0A8kD",
  "1QMlBAgAAQAAAJIFiQECABoAAwAKCFAIWgiwArsC3wKdA+UD+gMAAQMAiAEBAEABBQCcAQEAQAEHAKgBAQBAAQkAtQEB",
  "AEQBCwAXCAEAQAENAOkBAQBAAQ8A9QEBAEQBEQAyCAEARAETAEMIAQBDARUAJQIBAEABFwA0AgIAQAEZAEkCAwAEgAAA",
  "AAAAAAAAAAAAAAAAAAAqAAAABAAAAAAAAAAAAAAAAQDwAAAAAAAEAAAAAAAAAAAAAAABAPkAAAAAAAQAAAAAAAAAAAAA",
  "AAEA1QkAAAAAAwACAAQAAgAFAAIABgACAAcAAgAIAAIACQACAAoAAgALAAIADAACAA0AAgAOAAIADwACABAAAgARAAIA",
  "AAAAPE1vZHVsZT4AVmVyaWRpYUJyb3dzZXJQcm9maWxlQ2Vuc3VzLmRsbABWZXJpZGlhQnJvd3NlclByb2ZpbGVDZW5z",
  "dXMAVW5pY29kZQBTcGlQcmVmaXgAVmVyc2lvbgBTeXN0ZW1JbmZvAEJhc2ljSW5mb3JtYXRpb24ARmlsZVRpbWUATWVt",
  "b3J5Q291bnRlcnMAUmV0YWluZWQAUHJvdmlkZXJCaW5kaW5nAFF1ZXJ5QmFzaWMAUXVlcnlTeXN0ZW0AR2V0VmVyc2lv",
  "bgBRdWVyeVByZWNpc2VVdGMAUXVlcnlJbmZvcm1hdGlvbgBtc2NvcmxpYgBTeXN0ZW0AT2JqZWN0AFZhbHVlVHlwZQBN",
  "dWx0aWNhc3REZWxlZ2F0ZQBTcGlDYXBhY2l0eQBTcGlIZWFkZXJTaXplAFNwaVRocmVhZFNpemUAU3BpTWF4Um93cwBT",
  "cGlNYXhJbWFnZUNoYXJzAFNwaUxheW91dFByb2ZpbGUAcHJvdmlkZXJCaW5kaW5nAEdldE5hdGl2ZVN5c3RlbUluZm8A",
  "T3BlblByb2Nlc3MAR2V0UHJvY2Vzc0lkAEdldFByb2Nlc3NUaW1lcwBTeXN0ZW0uVGV4dABTdHJpbmdCdWlsZGVyAElt",
  "YWdlTmFtZQBDbG9zZUhhbmRsZQBXYWl0Rm9yU2luZ2xlT2JqZWN0AEdldE1vZHVsZUhhbmRsZQBMb2FkTGlicmFyeQBH",
  "ZXRQcm9jQWRkcmVzcwBHZXRQcm9jZXNzTWVtb3J5SW5mbwBHZXRFeHRlbmRlZFRjcFRhYmxlAHF1ZXJ5QmFzaWMAcXVl",
  "cnlTeXN0ZW0AZ2V0VmVyc2lvbgBxdWVyeVByZWNpc2VVdGMAbnRkbGxNb2R1bGUALmNjdG9yAFN5c3RlbS5EaWFnbm9z",
  "dGljcwBTdG9wd2F0Y2gAUmVtYWluaW5nAFByZWNpc2VVdGNCb3VuZABTcGlWZXJzaW9uAFZhbGlkYXRlU3BpSW1hZ2UA",
  "U3lzdGVtLkNvbGxlY3Rpb25zLkdlbmVyaWMATGlzdGAxAERpY3Rpb25hcnlgMgBQYXJzZVNwaQBQcm9jZXNzZXMATGFz",
  "dFN0YWdlAFN0YWdlAElzQXBwcm92ZWRBYmkAUHJvY2Vzc1N0aWxsRXhpc3RzAFNhbWVIZWxkSWRlbnRpdHlFeGl0ZWQA",
  "UmVhZENvbW1hbmRMaW5lAFJlYWRQcm9maWxlUm93cwBsZW5ndGgAbWF4aW11bQBidWZmZXIAbmV4dAB0aHJlYWRzAHNw",
  "YXJlMQBzcGFyZTIAc3BhcmUzAGNyZWF0aW9uAHVzZXIAa2VybmVsAGltYWdlAHByaW9yaXR5AHBpZABwYXJlbnQAaGFu",
  "ZGxlcwBzZXNzaW9uAHBhZ2VEaXJlY3RvcnkAcGVha1ZpcnR1YWwAdmlydHVhbFNpemUAZmF1bHRzAHBlYWtXb3JraW5n",
  "AHdvcmtpbmcAcGVha1BhZ2VkAHBhZ2VkAHBlYWtOb25QYWdlZABub25QYWdlZABwYWdlZmlsZQBwZWFrUGFnZWZpbGUA",
  "cHJpdmF0ZVBhZ2VzAHJlYWRPcHMAd3JpdGVPcHMAb3RoZXJPcHMAcmVhZEJ5dGVzAHdyaXRlQnl0ZXMAb3RoZXJCeXRl",
  "cwBzaXplAG1ham9yAG1pbm9yAGJ1aWxkAHBsYXRmb3JtAHNlcnZpY2VQYWNrAGFyY2hpdGVjdHVyZQByZXNlcnZlZABw",
  "YWdlU2l6ZQBtaW5pbXVtAG1hc2sAcHJvY2Vzc29ycwB0eXBlAGdyYW51bGFyaXR5AGxldmVsAHJldmlzaW9uAGV4aXRT",
  "dGF0dXMAcGViAGFmZmluaXR5AHBhcmVudFBpZABsb3cAaGlnaABnZXRfVmFsdWUAVmFsdWUAcGVha1dvcmtpbmdTZXQA",
  "d29ya2luZ1NldABoYW5kbGUAYmlydGgAcm93AC5jdG9yAHNlbGZQaWQAd3JhcHBlclBpZABzZWxmUGFyZW50AHdyYXBw",
  "ZXJQYXJlbnQAc2VsZkJpcnRoAHdyYXBwZXJCaXJ0aABzZWxmTmFtZQB3cmFwcGVyTmFtZQBzZWxmQ2Fub25pY2FsQmly",
  "dGgAd3JhcHBlckNhbm9uaWNhbEJpcnRoAEludm9rZQBJQXN5bmNSZXN1bHQAQXN5bmNDYWxsYmFjawBCZWdpbkludm9r",
  "ZQBFbmRJbnZva2UAaW5mbwBTeXN0ZW0uUnVudGltZS5JbnRlcm9wU2VydmljZXMAT3V0QXR0cmlidXRlAGFjY2VzcwBp",
  "bmhlcml0AGV4aXQAZmxhZ3MAdmFsdWUAbWlsbGlzZWNvbmRzAG5hbWUAbW9kdWxlAGNvdW50ZXJzAHRhYmxlAGJ5dGVz",
  "AG9yZGVyZWQAZmFtaWx5AHRhYmxlQ2xhc3MAd2F0Y2gAYnVkZ2V0TXMAcmV0dXJuZWQAdXRjQmlydGhVcHBlckJvdW5k",
  "AGNvdmVyYWdlAGNsb2NrAGV4ZWN1dGFibGUAb2JqZWN0AG1ldGhvZABraW5kAHJlc3VsdABjYWxsYmFjawBfX3Jlc3Vs",
  "dAB2ZXJzaW9uAHRpbWUAU3lzdGVtLlJ1bnRpbWUuQ29tcGlsZXJTZXJ2aWNlcwBDb21waWxhdGlvblJlbGF4YXRpb25z",
  "QXR0cmlidXRlAFJ1bnRpbWVDb21wYXRpYmlsaXR5QXR0cmlidXRlAERsbEltcG9ydEF0dHJpYnV0ZQBrZXJuZWwzMi5k",
  "bGwAUXVlcnlGdWxsUHJvY2Vzc0ltYWdlTmFtZVcAR2V0TW9kdWxlSGFuZGxlVwBMb2FkTGlicmFyeVcAcHNhcGkuZGxs",
  "AGlwaGxwYXBpLmRsbABJbnRQdHIAZ2V0X1NpemUAVHlwZQBSdW50aW1lVHlwZUhhbmRsZQBHZXRUeXBlRnJvbUhhbmRs",
  "ZQBNYXJzaGFsAFNpemVPZgBPZmZzZXRPZgBUb0ludDMyAEludmFsaWRPcGVyYXRpb25FeGNlcHRpb24AWmVybwBvcF9F",
  "cXVhbGl0eQBEZWxlZ2F0ZQBHZXREZWxlZ2F0ZUZvckZ1bmN0aW9uUG9pbnRlcgBUaW1lU3BhbgBnZXRfRWxhcHNlZABn",
  "ZXRfVG90YWxNaWxsaXNlY29uZHMARGF0ZVRpbWUARnJvbUZpbGVUaW1lVXRjAEFyZ3VtZW50T3V0T2ZSYW5nZUV4Y2Vw",
  "dGlvbgBTdHJpbmcASXNOdWxsT3JXaGl0ZVNwYWNlAGdldF9MZW5ndGgASW5kZXhPZgBnZXRfQ2hhcnMAQ2hhcgBJc0hp",
  "Z2hTdXJyb2dhdGUASXNMb3dTdXJyb2dhdGUAVG9JbnQ2NABTeXN0ZW0uQ29yZQBIYXNoU2V0YDEAQWRkAFB0clRvU3Ry",
  "dWN0dXJlAGdldF9Db3VudABvcF9JbmVxdWFsaXR5AFB0clRvU3RyaW5nVW5pAEV4Y2VwdGlvbgBTeXN0ZW0uQ29sbGVj",
  "dGlvbnMASURpY3Rpb25hcnkAZ2V0X0RhdGEASW50MzIAU3lzdGVtLkdsb2JhbGl6YXRpb24AQ3VsdHVyZUluZm8AZ2V0",
  "X0ludmFyaWFudEN1bHR1cmUASW50NjQASUZvcm1hdFByb3ZpZGVyAFRvU3RyaW5nAFVJbnQ2NABzZXRfSXRlbQBVSW50",
  "UHRyAFRvVUludDY0AEJvb2xlYW4AQWxsb2NIR2xvYmFsAFVJbnQzMgBGcmVlSEdsb2JhbABDb25zb2xlAFN5c3RlbS5J",
  "TwBUZXh0V3JpdGVyAGdldF9FcnJvcgBnZXRfRWxhcHNlZE1pbGxpc2Vjb25kcwBXcml0ZUxpbmUAZ2V0X01lc3NhZ2UA",
  "PD5jX19EaXNwbGF5Q2xhc3M0ADxQcm9jZXNzU3RpbGxFeGlzdHM+Yl9fMwBnZXRfSXRlbQBQcmVkaWNhdGVgMQBFeGlz",
  "dHMAUGF0aABHZXRGaWxlTmFtZQBFbnVtZXJhdG9yAEdldEVudW1lcmF0b3IAZ2V0X0N1cnJlbnQAU3RyaW5nQ29tcGFy",
  "aXNvbgBFcXVhbHMAR2V0TGFzdFdpbjMyRXJyb3IASGFzaHRhYmxlAE1vdmVOZXh0AElEaXNwb3NhYmxlAERpc3Bvc2UA",
  "VG9BcnJheQBTdHJ1Y3RMYXlvdXRBdHRyaWJ1dGUATGF5b3V0S2luZABNYXJzaGFsQXNBdHRyaWJ1dGUAVW5tYW5hZ2Vk",
  "VHlwZQBVbm1hbmFnZWRGdW5jdGlvblBvaW50ZXJBdHRyaWJ1dGUAQ2FsbGluZ0NvbnZlbnRpb24AQ29tcGlsZXJHZW5l",
  "cmF0ZWRBdHRyaWJ1dGUAABFjAHIAZQBhAHQAaQBvAG4AAAtpAG0AYQBnAGUAAAdwAGkAZAAADXAAYQByAGUAbgB0AAAP",
  "dwBvAHIAawBpAG4AZwAAM04AQQBUAEkAVgBFAF8ATABBAFkATwBVAFQAXwBVAE4AUwBVAFAAUABPAFIAVABFAEQAABNu",
  "AHQAZABsAGwALgBkAGwAbAAAMU4AQQBUAEkAVgBFAF8ATgBUAEQATABMAF8AVQBOAEEAVgBBAEkATABBAEIATABFAAAz",
  "TgB0AFEAdQBlAHIAeQBJAG4AZgBvAHIAbQBhAHQAaQBvAG4AUAByAG8AYwBlAHMAcwAAP04AQQBUAEkAVgBFAF8AQgBB",
  "AFMASQBDAF8ARQBYAFAATwBSAFQAXwBVAE4AQQBWAEEASQBMAEEAQgBMAEUAADFOAHQAUQB1AGUAcgB5AFMAeQBzAHQA",
  "ZQBtAEkAbgBmAG8AcgBtAGEAdABpAG8AbgAAO1MAUABJAF8AUwBZAFMAVABFAE0AXwBFAFgAUABPAFIAVABfAFUATgBB",
  "AFYAQQBJAEwAQQBCAEwARQAAG1IAdABsAEcAZQB0AFYAZQByAHMAaQBvAG4AAD1TAFAASQBfAFYARQBSAFMASQBPAE4A",
  "XwBFAFgAUABPAFIAVABfAFUATgBBAFYAQQBJAEwAQQBCAEwARQAAGWsAZQByAG4AZQBsADMAMgAuAGQAbABsAAA9RwBl",
  "AHQAUwB5AHMAdABlAG0AVABpAG0AZQBQAHIAZQBjAGkAcwBlAEEAcwBGAGkAbABlAFQAaQBtAGUAAEVTAFAASQBfAFAA",
  "UgBFAEMASQBTAEUAXwBVAFQAQwBfAEUAWABQAE8AUgBUAF8AVQBOAEEAVgBBAEkATABBAEIATABFAAArTgBBAFQASQBW",
  "AEUAXwBRAFUARQBSAFkAXwBEAEUAQQBEAEwASQBOAEUAADtTAFAASQBfAFAAUgBFAEMASQBTAEUAXwBVAFQAQwBfAEIA",
  "TwBVAE4ARABfAEkATgBWAEEATABJAEQAACtTAFAASQBfAFUATgBBAFAAUABSAE8AVgBFAEQAXwBPAFMAXwBBAEIASQAA",
  "LVMAUABJAF8ASQBNAEEARwBFAF8ATgBBAE0ARQBfAEkATgBWAEEATABJAEQAAC9TAFAASQBfAEkATQBBAEcARQBfAFUA",
  "VABGADEANgBfAEkATgBWAEEATABJAEQAADNTAFAASQBfAFIARQBUAFUAUgBOAF8ATABFAE4ARwBUAEgAXwBJAE4AVgBB",
  "AEwASQBEAAAxUwBQAEkAXwBFAE4AVABSAFkAXwBCAE8AVQBOAEQAUwBfAEkATgBWAEEATABJAEQAAENTAFAASQBfAFQA",
  "SABSAEUAQQBEAF8ATwBSAF8ATgBFAFgAVABfAEIATwBVAE4ARABTAF8ASQBOAFYAQQBMAEkARAAAOVMAUABJAF8ASQBO",
  "AFYARQBOAFQATwBSAFkAXwBMAEkATQBJAFQAXwBFAFgAQwBFAEUARABFAEQAADlTAFAASQBfAFAASQBEAF8ASQBOAFYA",
  "QQBMAEkARABfAE8AUgBfAEQAVQBQAEwASQBDAEEAVABFAAAzUwBQAEkAXwBJAEQATABFAF8AUwBFAE4AVABJAE4ARQBM",
  "AF8ASQBOAFYAQQBMAEkARAAANVMAUABJAF8AVQBOAEkAQwBPAEQARQBfAEIATwBVAE4ARABTAF8ASQBOAFYAQQBMAEkA",
  "RAAAR1MAUABJAF8AQgBJAFIAVABIAF8ATwBVAFQAUwBJAEQARQBfAEMAQQBQAFQAVQBSAEUAXwBVAFQAQwBfAEIATwBV",
  "AE4ARAAAI2IAaQByAHQAaABHAHUAYQByAGQARgBhAGkAbAB1AHIAZQAADWIAcgBhAG4AYwBoAAAvQQBGAFQARQBSAF8A",
  "UABSAEUAQwBJAFMARQBfAFUAVABDAF8AQgBPAFUATgBEAAAlTgBPAE4AXwBQAE8AUwBJAFQASQBWAEUAXwBCAEkAUgBU",
  "AEgAABNwAGEAcgBlAG4AdABQAGkAZAAAHWMAcgBlAGEAdABpAG8AbgBTAGkAZwBuAGUAZAAAJXUAdABjAEIAaQByAHQA",
  "aABVAHAAcABlAHIAQgBvAHUAbgBkAAAXYwBsAG8AYwBrAFMAbwB1AHIAYwBlAABJRwBFAFQAXwBTAFkAUwBUAEUATQBf",
  "AFQASQBNAEUAXwBQAFIARQBDAEkAUwBFAF8AQQBTAF8ARgBJAEwARQBfAFQASQBNAEUAADl5AHkAeQB5AC0ATQBNAC0A",
  "ZABkAFQASABIADoAbQBtADoAcwBzAC4AZgBmAGYAZgBmAGYAZgBaAAE/UwBQAEkAXwBXAE8AUgBLAEkATgBHAF8AUwBF",
  "AFQAXwBVAE4AUgBFAFAAUgBFAFMARQBOAFQAQQBCAEwARQAACW4AYQBtAGUAABNjAHIAZQBhAHQAZQBkAEEAdAAAIW4A",
  "YQB0AGkAdgBlAEIAaQByAHQAaABTAHQAYQBtAHAAAB93AG8AcgBrAGkAbgBnAFMAZQB0AEIAeQB0AGUAcwAAKW4AYQB0",
  "AGkAdgBlAEkAZABlAG4AdABpAHQAeQBTAHQAYQB0AHUAcwAAV1MATgBBAFAAUwBIAE8AVABfAE8ATgBMAFkAXwBCAEkA",
  "UgBUAEgAXwBQAEEAUgBFAE4AVABfAE4AQQBNAEUAXwBPAEIAUwBFAFIAVgBBAFQASQBPAE4AAD1TAFAASQBfAEkARABM",
  "AEUAXwBTAEUATgBUAEkATgBFAEwAXwBOAE8AXwBBAFUAVABIAE8AUgBJAFQAWQAAJ3AAYQByAGUAbgB0AEkAZABlAG4A",
  "dABpAHQAeQBQAHIAbwBvAGYAAF9TAFAASQBfAFMATgBBAFAAUwBIAE8AVABfAEIASQBSAFQASABfAFAAQQBSAEUATgBU",
  "AF8ATgBBAE0ARQBfAE8AQgBTAEUAUgBWAEEAVABJAE8ATgBfAE8ATgBMAFkAACFsAGkAdgBlAEEAdABDAGEAcAB0AHUA",
  "cgBlAEUAbgBkAAAlbwB3AG4AZQByAHMAaABpAHAAQQB1AHQAaABvAHIAaQB0AHkAACdTAFAASQBfAEUATQBQAFQAWQBf",
  "AEkATgBWAEUATgBUAE8AUgBZAAAzUwBQAEkAXwBRAFUARQBSAFkAXwBOAFQAUwBUAEEAVABVAFMAXwBGAEEASQBMAEUA",
  "RAAAD28AcwBCAHUAaQBsAGQAABlhAHIAYwBoAGkAdABlAGMAdAB1AHIAZQAAC0EATQBEADYANAAAG2wAYQB5AG8AdQB0",
  "AFAAcgBvAGYAaQBsAGUAAHVTAFAASQBfAFgANgA0AF8AUABSAEUARgBJAFgAMgA1ADYAXwBUAEgAUgBFAEEARAA4ADAA",
  "XwBDAFIARQBBAFQARQAzADIAXwBJAE0AQQBHAEUANQA2AF8AUABJAEQAOAAwAF8AUABBAFIARQBOAFQAOAA4AAAXcQB1",
  "AGUAcgB5AFMAdABhAHQAdQBzAAAZcgBlAHQAdQByAG4ATABlAG4AZwB0AGgAAB1iAHUAZgBmAGUAcgBDAGEAcABhAGMA",
  "aQB0AHkAACNpAG4AdgBlAG4AdABvAHIAeQBDAG8AbQBwAGwAZQB0AGUAADlzAG4AYQBwAHMAaABvAHQAQwBvAG0AcABs",
  "AGUAdABlAGQAVQB0AGMARgBpAGwAZQBUAGkAbQBlAABHVgBFAFIASQBEAEkAQQBfAFAAUgBPAEYASQBMAEUAXwBQAFIA",
  "TwBCAEUAXwBTAFQAQQBHAEUAPQB7ADAAfQA6AHsAMQB9AAA7UABSAE8ARgBJAEwARQBfAE8AVwBOAEUAUgBTAEgASQBQ",
  "AF8AVQBOAEEAVgBBAEkATABBAEIATABFAAAjUwBQAEkAXwBDAEEAUABUAFUAUgBFAF8ARQBOAFQARQBSAAAlUwBQAEkA",
  "XwBDAEEAUABUAFUAUgBFAF8AUgBFAFQAVQBSAE4AACtTAFAASQBfAEgARQBMAEQAXwBQAFIATwBDAEUAUwBTAF8ATwBQ",
  "AEUATgAAY1YARQBSAEkARABJAEEAXwBQAFIATwBGAEkATABFAF8AUABSAE8AQgBFAF8AQwBFAE4AUwBVAFMAXwBPAFAA",
  "RQBOAD0AewAwAH0AOgB7ADEAfQA6AHsAMgB9ADoAewAzAH0AAAtGAEEATABTAEUAAAlUAFIAVQBFAAAzUwBQAEkAXwBW",
  "AEUAUgBJAEYASQBFAEQAXwBBAEIAUwBFAE4AQwBFAF8AUwBLAEkAUAAAP0wASQBWAEUAXwBQAFIATwBDAEUAUwBTAF8A",
  "SABBAE4ARABMAEUAXwBVAE4AQQBWAEEASQBMAEEAQgBMAEUAADdMAEkAVgBFAF8AUABSAE8AQwBFAFMAUwBfAEIASQBS",
  "AFQASABfAE0ASQBTAE0AQQBUAEMASAAAHVMAUABJAF8ASQBNAEEARwBFAF8AUgBFAEEARAAAfVYARQBSAEkARABJAEEA",
  "XwBQAFIATwBGAEkATABFAF8AUABSAE8AQgBFAF8AQwBFAE4AUwBVAFMAXwBJAE0AQQBHAEUAPQB7ADAAfQA6AHsAMQB9",
  "ADoAewAyAH0AOgB7ADMAfQA6AHsANAB9ADoAewA1AH0AOgB7ADYAfQAAIVMAUABJAF8ASQBNAEEARwBFAF8AUgBFAFQA",
  "VQBSAE4AACtTAFAASQBfAEMATwBNAE0AQQBOAEQAXwBMAEkATgBFAF8AUgBFAEEARAAAL1MAUABJAF8AQwBPAE0ATQBB",
  "AE4ARABfAEwASQBOAEUAXwBSAEUAVABVAFIATgAAE1AAcgBvAGMAZQBzAHMASQBkAAAfUABhAHIAZQBuAHQAUAByAG8A",
  "YwBlAHMAcwBJAGQAAB1FAHgAZQBjAHUAdABhAGIAbABlAFAAYQB0AGgAABdDAG8AbQBtAGEAbgBkAEwAaQBuAGUAABlD",
  "AHIAZQBhAHQAaQBvAG4ARABhAHQAZQAAMU4AYQB0AGkAdgBlAFMAbgBhAHAAcwBoAG8AdABCAGkAcgB0AGgAUwB0AGEA",
  "bQBwAAAtUwBQAEkAXwBWAEUAUgBJAEYASQBFAEQAXwBFAFgASQBUAF8AUwBLAEkAUAAAMVMAUABJAF8ASABFAEwARABf",
  "AFAAUgBPAEMARQBTAFMAXwBEAEkAUwBQAE8AUwBFAABFTgBBAFQASQBWAEUAXwBQAFIATwBDAEUAUwBTAF8ASABBAE4A",
  "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",
  "GAAAgAAAAAAAAAAAAAAAAAAAAQABAAAAMAAAgAAAAAAAAAAAAAAAAAAAAQAAAAAASAAAAFiAAACUAgAAAAAAAAAAAACU",
  "AjQAAABWAFMAXwBWAEUAUgBTAEkATwBOAF8ASQBOAEYATwAAAAAAvQTv/gAAAQAAAAAAAAAAAAAAAAAAAAAAPwAAAAAA",
  "AAAEAAAAAgAAAAAAAAAAAAAAAAAAAEQAAAABAFYAYQByAEYAaQBsAGUASQBuAGYAbwAAAAAAJAAEAAAAVAByAGEAbgBz",
  "AGwAYQB0AGkAbwBuAAAAAAAAALAE9AEAAAEAUwB0AHIAaQBuAGcARgBpAGwAZQBJAG4AZgBvAAAA0AEAAAEAMAAwADAA",
  "MAAwADQAYgAwAAAALAACAAEARgBpAGwAZQBEAGUAcwBjAHIAaQBwAHQAaQBvAG4AAAAAACAAAAAwAAgAAQBGAGkAbABl",
  "AFYAZQByAHMAaQBvAG4AAAAAADAALgAwAC4AMAAuADAAAABgACAAAQBJAG4AdABlAHIAbgBhAGwATgBhAG0AZQAAAFYA",
  "ZQByAGkAZABpAGEAQgByAG8AdwBzAGUAcgBQAHIAbwBmAGkAbABlAEMAZQBuAHMAdQBzAC4AZABsAGwAAAAoAAIAAQBM",
  "AGUAZwBhAGwAQwBvAHAAeQByAGkAZwBoAHQAAAAgAAAAaAAgAAEATwByAGkAZwBpAG4AYQBsAEYAaQBsAGUAbgBhAG0A",
  "ZQAAAFYAZQByAGkAZABpAGEAQgByAG8AdwBzAGUAcgBQAHIAbwBmAGkAbABlAEMAZQBuAHMAdQBzAC4AZABsAGwAAAA0",
  "AAgAAQBQAHIAbwBkAHUAYwB0AFYAZQByAHMAaQBvAG4AAAAwAC4AMAAuADAALgAwAAAAOAAIAAEAQQBzAHMAZQBtAGIA",
  "bAB5ACAAVgBlAHIAcwBpAG8AbgAAADAALgAwAC4AMAAuADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAADAAAAGAyAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
].join("");
