// Immutable .NET 4 read-only profile census. No runtime compilation, prewarm or process termination.
export const WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE_SHA256 = "859c8b2b13e67f9ca741c71c61cef3a545cd5edebec25a8282cc717e48f70f2f";
export const WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_SHA256 = "51c2b0e759ea6cdcd2c8fa80f6fdf6ee07282fdfb3bf6e39026b53aceaa229f6";
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
  "cHMKAAAKetwSGyhCAAAKOmT6///eDhIb/hYGAAAbb0MAAArcAyDQBwAAKA4AAAYIb0QAAAoqQUwAAAAAAAAvAgAAEAMA",
  "AD8FAABtAAAAEgAAAQIAAABXAQAAVwQAAK4FAAAgAAAAAAAAAAIAAAA5AAAAowUAANwFAAAOAAAAAAAAAE4Ce0oAAARu",
  "HyBiAntJAAAEbmAqHgIoMQAACioeAigxAAAKKkJTSkIBAAEAAAAAAAwAAAB2NC4wLjMwMzE5AAAAAAUAbAAAAIANAAAj",
  "fgAA7A0AALgMAAAjU3RyaW5ncwAAAACkGgAA7A8AACNVUwCQKgAAEAAAACNHVUlEAAAAoCoAAMwEAAAjQmxvYgAAAAAA",
  "AAACAAABVz2iHQkCAAAA+iUzABYAAAEAAAAyAAAAEQAAAGMAAAAyAAAAcwAAAEgAAAAGAAAACAAAAAEAAAANAAAAAQAA",
  "AAEAAAABAAAAAwAAAAYAAAAMAAAAAQAAAAMAAAAPAAAAAAAKAAEAAAAAAAYAAAH5AAYABwH5AAYAEQH5AAYA0QHFAQoA",
  "tQKiAgYAEAP1AgYAFwP1AgYAUQb5AAYAXgb5AAYApgaHBgYAuQeZBwYA2QeZBwYA9weHBgYAZwj5AAYAdwj5AAYAfAj5",
  "AAYAoAiHBgYAwAj5AAYA6wj5AAYAEgn5AAYAPQn5AAYAVgn5AAYAcgn5AAYAqQn5AA4A4Qn1AgYAJQr5AAYAQgovCgYA",
  "Vwr5AAYAcgpdCgYAkwr5AAYAmQr5AAYAsgr5AAYAwgr5AAYA0wr5AAYA6Ar5AAYA+wr5AAYADQsDCwYAhQv5AAYAmAsD",
  "CxsAqQsAAAYAzgv5AAYA+AsvCgYACwz5AAYAJwyHBgYAPQyHBgYASAyHBgYAWwyHBgYAaQyHBgYAiwyHBgYAnQyZBwAA",
  "AAABAAAAAAABAAEAgQEAACoAAAAFAAEAAQALARAARgAAAAkADgAaAAsBEABOAAAACQARABoACwERAFgAAAAJADIAGgAL",
  "ARAAYAAAAAkAOAAaAAsBEABrAAAACQBDABoACwEQAHwAAAAJAEkAGgALARAAhQAAAAkASwAbAAMBEACUAAAABQBVABsA",
  "AwEQAJ0AAAAFAFkAHAADAQAArQAAAA0AYwAdAAMBAAC4AAAADQBjACEAAwEAAMQAAAANAGMAJQADAQAAzwAAAA0AYwAp",
  "AAMBAADfAAAADQBjAC0AAwEQAFALAAAFAGMAMQBRgCMBCgBRgC8BCgBRgD0BCgBRgEsBCgBRgFYBCgBRgGcBJgARAHgB",
  "ngAxAF0C+gAxAGgC/gAxAHQCAgExAH8CBgExAI8CCgEWADcDJgAGAJ8DdQEGAKYDdQEGAK4DCgEGALUDeAEGALoDeAEG",
  "AMIDewEGAMkDewEGANADewEGANcDewEGAOADewEGAOUDewEGAOwDfgEGAPIDCgAGAPsDCgEGAP8DCgEGAAYEeAEGAA4E",
  "eAEGABYEggEGACQEggEGADAEggEGADwEeAEGAEMEggEGAE8EggEGAFcEggEGAGEEggEGAGcEggEGAHQEggEGAH0EggEG",
  "AIYEggEGAJMEggEGAKAEewEGAKgEewEGALEEewEGALoEewEGAMQEewEGAM8EewEGANoEeAEGAN8EeAEGAOUEeAEGAOsE",
  "eAEGAPEEeAEGEPoEJgAGAAYFdQEGABMFdQEGABwFeAEGACUFCgEGAKYDCgEGAC0FggEGADIFeAEGAD0FeAEGAEIFeAEG",
  "AE4FdQEGAFQFdQEGAF0FCgAGAGgFCgEGAGwFggEGAPIDCgAGAPsDggEGAHUFggEGAH8FeAEGAIMFeAEGANoEeAEGADwE",
  "eAEGAJgFggEGAKcFggEGAFcEggEGAGEEggEGAGcEggEGAHQEggEGAH0EggEGAIYEggEGALIFCgEGAPsDeAEGALkFjQEG",
  "AL8FkAEGAMkFCgAGANEFCgAGANwFCgAGAOcFCgAGAPUFjQEGAP8FjQEGAAwGJgAGABUGJgAGACEGJgAGADQGJgAGAPsD",
  "CgAAAAAAgACRIIgBogABAAAAAACAAJEgnAGpAAIAAAAAAIAAkSCoAbAABQAAAAAAgACRILUBtQAGAAAAAACAAJEg3wHG",
  "AAsAAAAAAIAAkSDpAdAADwAAAAAAgACRIPUB1QAQAAAAAACAAJEgCQLbABIAAAAAAIAAkSAZAtsAEwAAAAAAgACRICUC",
  "4AAUAAAAAACAAJEgNALmABYAAAAAAIAAkSBJAu8AGQBQIAAAAACRGJsCDQEfALwiAAAAAJEAvwIRAR8A6CIAAAAAkQDJ",
  "AhgBIQBMIwAAAACRANkCHAEhANwjAAAAAJEA5AIgASEAkCQAAAAAkQAkAyUBIgBkKQAAAACRAC0DOAEnAKAqAAAAAJEA",
  "QQNPASoA2CoAAAAAlgBHA1YBLABAKwAAAACWAFUDWgEsAHwrAAAAAJEAaANhAS4AzCsAAAAAkQB/A2gBMQA0LQAAAACW",
  "AI8DbQEyAIgzAAAAAIYIiAWFATQAnDMAAAAAhhjDBZgBNACkMwAAAACGGMMFmAE0AAAAAAADAIYYwwWcATQAAAAAAAMA",
  "xgFKBqIBNgAAAAAAAwDGAWwGrgE7AAAAAAADAMYBeAa+AUIAAAAAAAMAhhjDBZwBRQAAAAAAAwDGAUoGyQFHAAAAAAAD",
  "AMYBbAbSAUsAAAAAAAMAxgF4Bt8BUQAAAAAAAwCGGMMFnAFTAAAAAAADAMYBSgbnAVUAAAAAAAMAxgFsBu4BVgAAAAAA",
  "AwDGAXgG+QFZAAAAAAADAIYYwwWcAVsAAAAAAAMAxgFKBgICXQAAAAAAAwDGAWwGCQJeAAAAAAADAMYBeAYUAmEAAAAA",
  "AAMAhhjDBZwBYwAAAAAAAwDGAUoGHQJlAAAAAAADAMYBbAYnAmoAAAAAAAMAxgF4Bt8BcQAcKwAAAACGGMMFmAFzACQr",
  "AAAAAIYAYwuMA3MAAgABAIIGAAABALMGAAACALoGAAADAPsDAAABALIFAAABALIFAgACANcDAgADAMIGAgAEAOUDAgAF",
  "AOADAAABALIFAAACAMcGAAADAM0GAAAEAJ8DAAABALIFAAABALIFAAACANMGAAABAOAGAAABAOAGAAABAOUGAAACAOAG",
  "AAABALIFAAACAOwGAAADANoEAAABAPUGAAACAPsGAAADAAEHAAAEAAkHAAAFABAHAAAGABMFAAABABsHAAACACEHAAAB",
  "AOAGAAABAK4DAAACACoHAAADADMHAAAEABsHAAAFACEHAAABABsHAAACACEHAgADAEYHAAABAM0GAAACAE8HAAABAPsD",
  "AAACABsHAAABALIFAAACAPsDAAADALkFAAABALIFAAABAFUHAAACABsHAAABAGAHAAACAGcHAAABALIFAAACAG4HAgAD",
  "AHMHAAAEANoEAgAFACoHAAABALIFAAACAG4HAgADAHMHAAAEANoEAgAFACoHAAAGAHoHAAAHAGAHAgABAHMHAgACACoH",
  "AAADAIMHAAABAGAHAAACAGcHAAABAG4HAAACAK4DAAADAPsGAgAEACoHAAABAG4HAAACAK4DAAADAPsGAgAEACoHAAAF",
  "AHoHAAAGAGAHAgABACoHAAACAHMHAAABAGAHAAACAGcHAAABAIwHAAABAIwHAAACAHoHAAADAGAHAAABAIwHAAACAHMH",
  "AAABAGAHAAACAGcHAgABAJQHAgABAJQHAAACAHoHAAADAGAHAgABAJQHAAACAHMHAAABAGAHAAACAGcHAAABALIFAAAC",
  "AG4HAAADAK4DAAAEAPsGAgAFACoHAAABALIFAAACAG4HAAADAK4DAAAEAPsGAgAFACoHAAAGAHoHAAAHAGAHAgABACoH",
  "AAACAHMHAAABAL8FUQDDBZgBWQDDBTUCYQDDBZgBaQDDBToCcQBuCD8CeQCOCEMCiQCoCEoCiQCvCFACcQC4CFcCkQDD",
  "BToCcQDaCAoBcQDfCFsCiQD0CGECKQAbCXMCoQAnCXgCqQBGCYECuQB5CZQCuQCMCVcCuQCXCZkCuQCfCZ4CwQCuCaMC",
  "wQC+CaMCcQDNCawCDADDBZgBFADDBZgBcQDrCcECiQDvCccCDAD+CVcCFADrCc4CcQAIClsCiQAWCtQC0QBOCtoCHADD",
  "BZgBHADrCeYC6QB+Cu4C8QCpCvMCAQGpCvMC2QC5CvkCqQCpCv8CCQHKCoUBDADrCQYDiQDbCj8DiQDvCkQDIQEYC2sD",
  "KQAiC6wCKQE6C3ED0QBEC3wDuQDfCIADCQDDBZgBHAB8C5YDJADDBZwBDACRC6kDLADDBZgBOQGdC+sDDAC0C/ADNADC",
  "CwYEuQDfCwsEiQDmCz8CKQE6CxQEuQAICoADIQDDBTUCCQCpCnwDUQHDBZgBUQHrCfkCLADrCQYDNAACDBsEWQEXDJgB",
  "LAAfDB8EYQHDBXsEcQHDBYIEgQHDBY0EkQHDBZgBCAAEAA0ACAAIABIACAAMABcACAAQABwACAAUACEADgAYACkALgAT",
  "AKIELgAbAKsEgwE7ApQEowE7ApQEwwE7ApQE4wE7ApQEAwI7ApQEIwJDAp0EbgCJBGkCfAKHAo0CqAIMA0kDeAOGA7QD",
  "yQPVAyUECAABAAAAkgWJAQIAGgADAAoIUAhaCLACuwLfAp0D5QP6AwABAwCIAQEAQAEFAJwBAQBAAQcAqAEBAEABCQC1",
  "AQEARAELABcIAQBAAQ0A6QEBAEABDwD1AQEARAERADIIAQBEARMAQwgBAEMBFQAlAgEAQAEXADQCAgBAARkASQIDAASA",
  "AAAAAAAAAAAAAAAAAAAAACoAAAAEAAAAAAAAAAAAAAABAPAAAAAAAAQAAAAAAAAAAAAAAAEA+QAAAAAABAAAAAAAAAAA",
  "AAAAAQDVCQAAAAADAAIABAACAAUAAgAGAAIABwACAAgAAgAJAAIACgACAAsAAgAMAAIADQACAA4AAgAPAAIAEAACABEA",
  "AgAAAAA8TW9kdWxlPgBWZXJpZGlhQnJvd3NlclByb2ZpbGVDZW5zdXMuZGxsAFZlcmlkaWFCcm93c2VyUHJvZmlsZUNl",
  "bnN1cwBVbmljb2RlAFNwaVByZWZpeABWZXJzaW9uAFN5c3RlbUluZm8AQmFzaWNJbmZvcm1hdGlvbgBGaWxlVGltZQBN",
  "ZW1vcnlDb3VudGVycwBSZXRhaW5lZABQcm92aWRlckJpbmRpbmcAUXVlcnlCYXNpYwBRdWVyeVN5c3RlbQBHZXRWZXJz",
  "aW9uAFF1ZXJ5UHJlY2lzZVV0YwBRdWVyeUluZm9ybWF0aW9uAG1zY29ybGliAFN5c3RlbQBPYmplY3QAVmFsdWVUeXBl",
  "AE11bHRpY2FzdERlbGVnYXRlAFNwaUNhcGFjaXR5AFNwaUhlYWRlclNpemUAU3BpVGhyZWFkU2l6ZQBTcGlNYXhSb3dz",
  "AFNwaU1heEltYWdlQ2hhcnMAU3BpTGF5b3V0UHJvZmlsZQBwcm92aWRlckJpbmRpbmcAR2V0TmF0aXZlU3lzdGVtSW5m",
  "bwBPcGVuUHJvY2VzcwBHZXRQcm9jZXNzSWQAR2V0UHJvY2Vzc1RpbWVzAFN5c3RlbS5UZXh0AFN0cmluZ0J1aWxkZXIA",
  "SW1hZ2VOYW1lAENsb3NlSGFuZGxlAFdhaXRGb3JTaW5nbGVPYmplY3QAR2V0TW9kdWxlSGFuZGxlAExvYWRMaWJyYXJ5",
  "AEdldFByb2NBZGRyZXNzAEdldFByb2Nlc3NNZW1vcnlJbmZvAEdldEV4dGVuZGVkVGNwVGFibGUAcXVlcnlCYXNpYwBx",
  "dWVyeVN5c3RlbQBnZXRWZXJzaW9uAHF1ZXJ5UHJlY2lzZVV0YwBudGRsbE1vZHVsZQAuY2N0b3IAU3lzdGVtLkRpYWdu",
  "b3N0aWNzAFN0b3B3YXRjaABSZW1haW5pbmcAUHJlY2lzZVV0Y0JvdW5kAFNwaVZlcnNpb24AVmFsaWRhdGVTcGlJbWFn",
  "ZQBTeXN0ZW0uQ29sbGVjdGlvbnMuR2VuZXJpYwBMaXN0YDEARGljdGlvbmFyeWAyAFBhcnNlU3BpAFByb2Nlc3NlcwBM",
  "YXN0U3RhZ2UAU3RhZ2UASXNBcHByb3ZlZEFiaQBQcm9jZXNzU3RpbGxFeGlzdHMAU2FtZUhlbGRJZGVudGl0eUV4aXRl",
  "ZABSZWFkQ29tbWFuZExpbmUAUmVhZFByb2ZpbGVSb3dzAGxlbmd0aABtYXhpbXVtAGJ1ZmZlcgBuZXh0AHRocmVhZHMA",
  "c3BhcmUxAHNwYXJlMgBzcGFyZTMAY3JlYXRpb24AdXNlcgBrZXJuZWwAaW1hZ2UAcHJpb3JpdHkAcGlkAHBhcmVudABo",
  "YW5kbGVzAHNlc3Npb24AcGFnZURpcmVjdG9yeQBwZWFrVmlydHVhbAB2aXJ0dWFsU2l6ZQBmYXVsdHMAcGVha1dvcmtp",
  "bmcAd29ya2luZwBwZWFrUGFnZWQAcGFnZWQAcGVha05vblBhZ2VkAG5vblBhZ2VkAHBhZ2VmaWxlAHBlYWtQYWdlZmls",
  "ZQBwcml2YXRlUGFnZXMAcmVhZE9wcwB3cml0ZU9wcwBvdGhlck9wcwByZWFkQnl0ZXMAd3JpdGVCeXRlcwBvdGhlckJ5",
  "dGVzAHNpemUAbWFqb3IAbWlub3IAYnVpbGQAcGxhdGZvcm0Ac2VydmljZVBhY2sAYXJjaGl0ZWN0dXJlAHJlc2VydmVk",
  "AHBhZ2VTaXplAG1pbmltdW0AbWFzawBwcm9jZXNzb3JzAHR5cGUAZ3JhbnVsYXJpdHkAbGV2ZWwAcmV2aXNpb24AZXhp",
  "dFN0YXR1cwBwZWIAYWZmaW5pdHkAcGFyZW50UGlkAGxvdwBoaWdoAGdldF9WYWx1ZQBWYWx1ZQBwZWFrV29ya2luZ1Nl",
  "dAB3b3JraW5nU2V0AGhhbmRsZQBiaXJ0aAByb3cALmN0b3IAc2VsZlBpZAB3cmFwcGVyUGlkAHNlbGZQYXJlbnQAd3Jh",
  "cHBlclBhcmVudABzZWxmQmlydGgAd3JhcHBlckJpcnRoAHNlbGZOYW1lAHdyYXBwZXJOYW1lAHNlbGZDYW5vbmljYWxC",
  "aXJ0aAB3cmFwcGVyQ2Fub25pY2FsQmlydGgASW52b2tlAElBc3luY1Jlc3VsdABBc3luY0NhbGxiYWNrAEJlZ2luSW52",
  "b2tlAEVuZEludm9rZQBpbmZvAFN5c3RlbS5SdW50aW1lLkludGVyb3BTZXJ2aWNlcwBPdXRBdHRyaWJ1dGUAYWNjZXNz",
  "AGluaGVyaXQAZXhpdABmbGFncwB2YWx1ZQBtaWxsaXNlY29uZHMAbmFtZQBtb2R1bGUAY291bnRlcnMAdGFibGUAYnl0",
  "ZXMAb3JkZXJlZABmYW1pbHkAdGFibGVDbGFzcwB3YXRjaABidWRnZXRNcwByZXR1cm5lZAB1dGNCaXJ0aFVwcGVyQm91",
  "bmQAY292ZXJhZ2UAY2xvY2sAZXhlY3V0YWJsZQBvYmplY3QAbWV0aG9kAGtpbmQAcmVzdWx0AGNhbGxiYWNrAF9fcmVz",
  "dWx0AHZlcnNpb24AdGltZQBTeXN0ZW0uUnVudGltZS5Db21waWxlclNlcnZpY2VzAENvbXBpbGF0aW9uUmVsYXhhdGlv",
  "bnNBdHRyaWJ1dGUAUnVudGltZUNvbXBhdGliaWxpdHlBdHRyaWJ1dGUARGxsSW1wb3J0QXR0cmlidXRlAGtlcm5lbDMy",
  "LmRsbABRdWVyeUZ1bGxQcm9jZXNzSW1hZ2VOYW1lVwBHZXRNb2R1bGVIYW5kbGVXAExvYWRMaWJyYXJ5VwBwc2FwaS5k",
  "bGwAaXBobHBhcGkuZGxsAEludFB0cgBnZXRfU2l6ZQBUeXBlAFJ1bnRpbWVUeXBlSGFuZGxlAEdldFR5cGVGcm9tSGFu",
  "ZGxlAE1hcnNoYWwAU2l6ZU9mAE9mZnNldE9mAFRvSW50MzIASW52YWxpZE9wZXJhdGlvbkV4Y2VwdGlvbgBaZXJvAG9w",
  "X0VxdWFsaXR5AERlbGVnYXRlAEdldERlbGVnYXRlRm9yRnVuY3Rpb25Qb2ludGVyAFRpbWVTcGFuAGdldF9FbGFwc2Vk",
  "AGdldF9Ub3RhbE1pbGxpc2Vjb25kcwBEYXRlVGltZQBGcm9tRmlsZVRpbWVVdGMAQXJndW1lbnRPdXRPZlJhbmdlRXhj",
  "ZXB0aW9uAFN0cmluZwBJc051bGxPcldoaXRlU3BhY2UAZ2V0X0xlbmd0aABJbmRleE9mAGdldF9DaGFycwBDaGFyAElz",
  "SGlnaFN1cnJvZ2F0ZQBJc0xvd1N1cnJvZ2F0ZQBUb0ludDY0AFN5c3RlbS5Db3JlAEhhc2hTZXRgMQBBZGQAUHRyVG9T",
  "dHJ1Y3R1cmUAZ2V0X0NvdW50AG9wX0luZXF1YWxpdHkAUHRyVG9TdHJpbmdVbmkARXhjZXB0aW9uAFN5c3RlbS5Db2xs",
  "ZWN0aW9ucwBJRGljdGlvbmFyeQBnZXRfRGF0YQBJbnQzMgBTeXN0ZW0uR2xvYmFsaXphdGlvbgBDdWx0dXJlSW5mbwBn",
  "ZXRfSW52YXJpYW50Q3VsdHVyZQBJbnQ2NABJRm9ybWF0UHJvdmlkZXIAVG9TdHJpbmcAVUludDY0AHNldF9JdGVtAFVJ",
  "bnRQdHIAVG9VSW50NjQAQm9vbGVhbgBBbGxvY0hHbG9iYWwAVUludDMyAEZyZWVIR2xvYmFsAENvbnNvbGUAU3lzdGVt",
  "LklPAFRleHRXcml0ZXIAZ2V0X0Vycm9yAGdldF9FbGFwc2VkTWlsbGlzZWNvbmRzAFdyaXRlTGluZQBnZXRfTWVzc2Fn",
  "ZQA8PmNfX0Rpc3BsYXlDbGFzczQAPFByb2Nlc3NTdGlsbEV4aXN0cz5iX18zAGdldF9JdGVtAFByZWRpY2F0ZWAxAEV4",
  "aXN0cwBQYXRoAEdldEZpbGVOYW1lAEVudW1lcmF0b3IAR2V0RW51bWVyYXRvcgBnZXRfQ3VycmVudABTdHJpbmdDb21w",
  "YXJpc29uAEVxdWFscwBHZXRMYXN0V2luMzJFcnJvcgBIYXNodGFibGUATW92ZU5leHQASURpc3Bvc2FibGUARGlzcG9z",
  "ZQBUb0FycmF5AFN0cnVjdExheW91dEF0dHJpYnV0ZQBMYXlvdXRLaW5kAE1hcnNoYWxBc0F0dHJpYnV0ZQBVbm1hbmFn",
  "ZWRUeXBlAFVubWFuYWdlZEZ1bmN0aW9uUG9pbnRlckF0dHJpYnV0ZQBDYWxsaW5nQ29udmVudGlvbgBDb21waWxlckdl",
  "bmVyYXRlZEF0dHJpYnV0ZQAAEWMAcgBlAGEAdABpAG8AbgAAC2kAbQBhAGcAZQAAB3AAaQBkAAANcABhAHIAZQBuAHQA",
  "AA93AG8AcgBrAGkAbgBnAAAzTgBBAFQASQBWAEUAXwBMAEEAWQBPAFUAVABfAFUATgBTAFUAUABQAE8AUgBUAEUARAAA",
  "E24AdABkAGwAbAAuAGQAbABsAAAxTgBBAFQASQBWAEUAXwBOAFQARABMAEwAXwBVAE4AQQBWAEEASQBMAEEAQgBMAEUA",
  "ADNOAHQAUQB1AGUAcgB5AEkAbgBmAG8AcgBtAGEAdABpAG8AbgBQAHIAbwBjAGUAcwBzAAA/TgBBAFQASQBWAEUAXwBC",
  "AEEAUwBJAEMAXwBFAFgAUABPAFIAVABfAFUATgBBAFYAQQBJAEwAQQBCAEwARQAAMU4AdABRAHUAZQByAHkAUwB5AHMA",
  "dABlAG0ASQBuAGYAbwByAG0AYQB0AGkAbwBuAAA7UwBQAEkAXwBTAFkAUwBUAEUATQBfAEUAWABQAE8AUgBUAF8AVQBO",
  "AEEAVgBBAEkATABBAEIATABFAAAbUgB0AGwARwBlAHQAVgBlAHIAcwBpAG8AbgAAPVMAUABJAF8AVgBFAFIAUwBJAE8A",
  "TgBfAEUAWABQAE8AUgBUAF8AVQBOAEEAVgBBAEkATABBAEIATABFAAAZawBlAHIAbgBlAGwAMwAyAC4AZABsAGwAAD1H",
  "AGUAdABTAHkAcwB0AGUAbQBUAGkAbQBlAFAAcgBlAGMAaQBzAGUAQQBzAEYAaQBsAGUAVABpAG0AZQAARVMAUABJAF8A",
  "UABSAEUAQwBJAFMARQBfAFUAVABDAF8ARQBYAFAATwBSAFQAXwBVAE4AQQBWAEEASQBMAEEAQgBMAEUAACtOAEEAVABJ",
  "AFYARQBfAFEAVQBFAFIAWQBfAEQARQBBAEQATABJAE4ARQAAO1MAUABJAF8AUABSAEUAQwBJAFMARQBfAFUAVABDAF8A",
  "QgBPAFUATgBEAF8ASQBOAFYAQQBMAEkARAAAK1MAUABJAF8AVQBOAEEAUABQAFIATwBWAEUARABfAE8AUwBfAEEAQgBJ",
  "AAAtUwBQAEkAXwBJAE0AQQBHAEUAXwBOAEEATQBFAF8ASQBOAFYAQQBMAEkARAAAL1MAUABJAF8ASQBNAEEARwBFAF8A",
  "VQBUAEYAMQA2AF8ASQBOAFYAQQBMAEkARAAAM1MAUABJAF8AUgBFAFQAVQBSAE4AXwBMAEUATgBHAFQASABfAEkATgBW",
  "AEEATABJAEQAADFTAFAASQBfAEUATgBUAFIAWQBfAEIATwBVAE4ARABTAF8ASQBOAFYAQQBMAEkARAAAQ1MAUABJAF8A",
  "VABIAFIARQBBAEQAXwBPAFIAXwBOAEUAWABUAF8AQgBPAFUATgBEAFMAXwBJAE4AVgBBAEwASQBEAAA5UwBQAEkAXwBJ",
  "AE4AVgBFAE4AVABPAFIAWQBfAEwASQBNAEkAVABfAEUAWABDAEUARQBEAEUARAAAOVMAUABJAF8AUABJAEQAXwBJAE4A",
  "VgBBAEwASQBEAF8ATwBSAF8ARABVAFAATABJAEMAQQBUAEUAADNTAFAASQBfAEkARABMAEUAXwBTAEUATgBUAEkATgBF",
  "AEwAXwBJAE4AVgBBAEwASQBEAAA1UwBQAEkAXwBVAE4ASQBDAE8ARABFAF8AQgBPAFUATgBEAFMAXwBJAE4AVgBBAEwA",
  "SQBEAABHUwBQAEkAXwBCAEkAUgBUAEgAXwBPAFUAVABTAEkARABFAF8AQwBBAFAAVABVAFIARQBfAFUAVABDAF8AQgBP",
  "AFUATgBEAAAjYgBpAHIAdABoAEcAdQBhAHIAZABGAGEAaQBsAHUAcgBlAAANYgByAGEAbgBjAGgAAC9BAEYAVABFAFIA",
  "XwBQAFIARQBDAEkAUwBFAF8AVQBUAEMAXwBCAE8AVQBOAEQAACVOAE8ATgBfAFAATwBTAEkAVABJAFYARQBfAEIASQBS",
  "AFQASAAAE3AAYQByAGUAbgB0AFAAaQBkAAAdYwByAGUAYQB0AGkAbwBuAFMAaQBnAG4AZQBkAAAldQB0AGMAQgBpAHIA",
  "dABoAFUAcABwAGUAcgBCAG8AdQBuAGQAABdjAGwAbwBjAGsAUwBvAHUAcgBjAGUAAElHAEUAVABfAFMAWQBTAFQARQBN",
  "AF8AVABJAE0ARQBfAFAAUgBFAEMASQBTAEUAXwBBAFMAXwBGAEkATABFAF8AVABJAE0ARQAAOXkAeQB5AHkALQBNAE0A",
  "LQBkAGQAVABIAEgAOgBtAG0AOgBzAHMALgBmAGYAZgBmAGYAZgBmAFoAAT9TAFAASQBfAFcATwBSAEsASQBOAEcAXwBT",
  "AEUAVABfAFUATgBSAEUAUABSAEUAUwBFAE4AVABBAEIATABFAAAJbgBhAG0AZQAAE2MAcgBlAGEAdABlAGQAQQB0AAAh",
  "bgBhAHQAaQB2AGUAQgBpAHIAdABoAFMAdABhAG0AcAAAH3cAbwByAGsAaQBuAGcAUwBlAHQAQgB5AHQAZQBzAAApbgBh",
  "AHQAaQB2AGUASQBkAGUAbgB0AGkAdAB5AFMAdABhAHQAdQBzAABXUwBOAEEAUABTAEgATwBUAF8ATwBOAEwAWQBfAEIA",
  "SQBSAFQASABfAFAAQQBSAEUATgBUAF8ATgBBAE0ARQBfAE8AQgBTAEUAUgBWAEEAVABJAE8ATgAAPVMAUABJAF8ASQBE",
  "AEwARQBfAFMARQBOAFQASQBOAEUATABfAE4ATwBfAEEAVQBUAEgATwBSAEkAVABZAAAncABhAHIAZQBuAHQASQBkAGUA",
  "bgB0AGkAdAB5AFAAcgBvAG8AZgAAX1MAUABJAF8AUwBOAEEAUABTAEgATwBUAF8AQgBJAFIAVABIAF8AUABBAFIARQBO",
  "AFQAXwBOAEEATQBFAF8ATwBCAFMARQBSAFYAQQBUAEkATwBOAF8ATwBOAEwAWQAAIWwAaQB2AGUAQQB0AEMAYQBwAHQA",
  "dQByAGUARQBuAGQAACVvAHcAbgBlAHIAcwBoAGkAcABBAHUAdABoAG8AcgBpAHQAeQAAJ1MAUABJAF8ARQBNAFAAVABZ",
  "AF8ASQBOAFYARQBOAFQATwBSAFkAADNTAFAASQBfAFEAVQBFAFIAWQBfAE4AVABTAFQAQQBUAFUAUwBfAEYAQQBJAEwA",
  "RQBEAAAPbwBzAEIAdQBpAGwAZAAAGWEAcgBjAGgAaQB0AGUAYwB0AHUAcgBlAAALQQBNAEQANgA0AAAbbABhAHkAbwB1",
  "AHQAUAByAG8AZgBpAGwAZQAAdVMAUABJAF8AWAA2ADQAXwBQAFIARQBGAEkAWAAyADUANgBfAFQASABSAEUAQQBEADgA",
  "MABfAEMAUgBFAEEAVABFADMAMgBfAEkATQBBAEcARQA1ADYAXwBQAEkARAA4ADAAXwBQAEEAUgBFAE4AVAA4ADgAABdx",
  "AHUAZQByAHkAUwB0AGEAdAB1AHMAABlyAGUAdAB1AHIAbgBMAGUAbgBnAHQAaAAAHWIAdQBmAGYAZQByAEMAYQBwAGEA",
  "YwBpAHQAeQAAI2kAbgB2AGUAbgB0AG8AcgB5AEMAbwBtAHAAbABlAHQAZQAAOXMAbgBhAHAAcwBoAG8AdABDAG8AbQBw",
  "AGwAZQB0AGUAZABVAHQAYwBGAGkAbABlAFQAaQBtAGUAAEdWAEUAUgBJAEQASQBBAF8AUABSAE8ARgBJAEwARQBfAFAA",
  "UgBPAEIARQBfAFMAVABBAEcARQA9AHsAMAB9ADoAewAxAH0AADtQAFIATwBGAEkATABFAF8ATwBXAE4ARQBSAFMASABJ",
  "AFAAXwBVAE4AQQBWAEEASQBMAEEAQgBMAEUAACNTAFAASQBfAEMAQQBQAFQAVQBSAEUAXwBFAE4AVABFAFIAACVTAFAA",
  "SQBfAEMAQQBQAFQAVQBSAEUAXwBSAEUAVABVAFIATgAAK1MAUABJAF8ASABFAEwARABfAFAAUgBPAEMARQBTAFMAXwBP",
  "AFAARQBOAABjVgBFAFIASQBEAEkAQQBfAFAAUgBPAEYASQBMAEUAXwBQAFIATwBCAEUAXwBDAEUATgBTAFUAUwBfAE8A",
  "UABFAE4APQB7ADAAfQA6AHsAMQB9ADoAewAyAH0AOgB7ADMAfQAAC0YAQQBMAFMARQAACVQAUgBVAEUAADNTAFAASQBf",
  "AFYARQBSAEkARgBJAEUARABfAEEAQgBTAEUATgBDAEUAXwBTAEsASQBQAAA/TABJAFYARQBfAFAAUgBPAEMARQBTAFMA",
  "XwBIAEEATgBEAEwARQBfAFUATgBBAFYAQQBJAEwAQQBCAEwARQAAN0wASQBWAEUAXwBQAFIATwBDAEUAUwBTAF8AQgBJ",
  "AFIAVABIAF8ATQBJAFMATQBBAFQAQwBIAAAdUwBQAEkAXwBJAE0AQQBHAEUAXwBSAEUAQQBEAAB9VgBFAFIASQBEAEkA",
  "QQBfAFAAUgBPAEYASQBMAEUAXwBQAFIATwBCAEUAXwBDAEUATgBTAFUAUwBfAEkATQBBAEcARQA9AHsAMAB9ADoAewAx",
  "AH0AOgB7ADIAfQA6AHsAMwB9ADoAewA0AH0AOgB7ADUAfQA6AHsANgB9AAB5VgBFAFIASQBEAEkAQQBfAFAAUgBPAEYA",
  "SQBMAEUAXwBQAFIATwBCAEUAXwBDAEUATgBTAFUAUwBfAEkATQBBAEcARQBfAFMAVABBAFQARQA9AHsAMAB9ADoAewAx",
  "AH0AOgB7ADIAfQA6AHsAMwB9ADoAewA0AH0AACFTAFAASQBfAEkATQBBAEcARQBfAFIARQBUAFUAUgBOAAArUwBQAEkA",
  "XwBDAE8ATQBNAEEATgBEAF8ATABJAE4ARQBfAFIARQBBAEQAAC9TAFAASQBfAEMATwBNAE0AQQBOAEQAXwBMAEkATgBF",
  "AF8AUgBFAFQAVQBSAE4AABNQAHIAbwBjAGUAcwBzAEkAZAAAH1AAYQByAGUAbgB0AFAAcgBvAGMAZQBzAHMASQBkAAAd",
  "RQB4AGUAYwB1AHQAYQBiAGwAZQBQAGEAdABoAAAXQwBvAG0AbQBhAG4AZABMAGkAbgBlAAAZQwByAGUAYQB0AGkAbwBu",
  "AEQAYQB0AGUAADFOAGEAdABpAHYAZQBTAG4AYQBwAHMAaABvAHQAQgBpAHIAdABoAFMAdABhAG0AcAAALVMAUABJAF8A",
  "VgBFAFIASQBGAEkARQBEAF8ARQBYAEkAVABfAFMASwBJAFAAADFTAFAASQBfAEgARQBMAEQAXwBQAFIATwBDAEUAUwBT",
  "AF8ARABJAFMAUABPAFMARQAARU4AQQBUAEkAVgBFAF8AUABSAE8AQwBFAFMAUwBfAEgAQQBOAEQATABFAF8AQwBMAE8A",
  "UwBFAF8ARgBBAEkATABFAEQAAAAAAFznM1UF4EFAvlCYJF5eiOkACLd6XFYZNOCJAgYIBAAAgAAEAAEAAARQAAAABACA",
  "AAAEBAEAAAIGDnRTAFAASQBfAFgANgA0AF8AUABSAEUARgBJAFgAMgA1ADYAXwBUAEgAUgBFAEEARAA4ADAAXwBDAFIA",
  "RQBBAFQARQAzADIAXwBJAE0AQQBHAEUANQA2AF8AUABJAEQAOAAwAF8AUABBAFIARQBOAFQAOAA4AAMGEiwGAAEBEBEY",
  "BgADGAkCCQQAAQkYEAAFAhgQESAQESAQESAQESAJAAQCGAkSERAJBAABAhgFAAIJGAkEAAEYDgUAAhgYDggAAwIYEBEk",
  "CQoABgkYEAkCCQgJAwYSMAMGEjQDBhI4AwYSPAIGGAMAAAEGAAIBEhUIAwAACwMAAAkEAAEBDhIABRUSGQEVEh0CDhwY",
  "CQsSFQgWAAMVEhkBFRIdAg4cEhUIEBUSHQIOHAYAAgEOEhUDAAACBgACAggSFQYAAwIYCA4EAAEOGAcAAh0cDhIVAgYH",
  "AgYJAgYKAwYRDAIGGQMgAAsDKAALAgYLBwYVEh0CDhwDIAABBSACARwYCyAFCBgIEBEcCRAJDyAHEiEYCBARHAkQCRIl",
  "HAogAwgQERwQCRIhCCAECAgYCRAJDCAGEiEIGAkQCRIlHAcgAggQCRIhBiABCBARFAogAxIhEBEUEiUcCCACCBARFBIh",
  "BiABARARIAogAxIhEBEgEiUcCCACARARIBIhCSAFCBgIGAkQCQ0gBxIhGAgYCRAJEiUcBCABAQgEIAEBDgMAAAgGAAES",
  "PRFBBQABCBI9BgACGBI9DgMgAAgFAAICGBgHAAISTRgSPQkHBxgYGBgYGBgEIAARUQMgAA0EBwERUQUAARFVCgUHAhEg",
  "CwYHAhEYERQEAAECDgQgAQgDBCABAwgEAAECAwMHAQgDIAAKChUSGQEVEh0CDhwFFRJlAQgFAAIYGAgGAAIcGBI9BSAB",
  "AhMABQACDhgIBCAAEm0GFRIdAg4cByACARMAEwEEAAASdQUgAQ4SfQUgAgEcHAYgAg4OEn0FIAEBEwAyBxYKCggVEhkB",
  "FRIdAg4cFRJlAQgREAoKCg4KCgoKDg4SSRUSHQIOHAsLFRIdAg4cEVUEAAEYCAQAAQEYIQcICRgJCAsVEhkBFRIdAg4c",
  "FRIdAg4cFRIZARUSHQIOHAUAABKAlQYgAwEOHBwDBwEKAyAADgUAAgIODgUHAhJJAgkgAQIVEh0CDhwGIAETARMACxUS",
  "gJkBFRIdAg4cCiABAhUSgJkBEwAUBwMVEh0CDhwVEhkBFRIdAg4cEkQLBwURIBEgESARIAsPBwsYEkAYCQgRDAoKCg4O",
  "BRUSGQEcBAABDg4JIAAVEYChARMACxURgKEBFRIdAg4cBCAAEwAIAAMCDg4RgKUGIAIBDh0cAyAAAgUgAB0TAFUHIhUS",
  "HQIOHBUSGQEVEh0CDhwVEhkBHA4VEh0CDhwYCAIRHAkRIBEgESARIBIRCQIIESARIBEgESACDg4SgKkSSRURgKEBFRId",
  "Ag4cHRwLCx0cHRwLBiABARGAtQYgAQERgL0DF4CABiABARGAxQgBAAEAAAAAAAQBAAAACAEACAAAAAAAHgEAAQBUAhZX",
  "cmFwTm9uRXhjZXB0aW9uVGhyb3dzAQAAQGMAAAAAAAAAAAAAXmMAAAAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFBjAAAA",
  "AAAAAAAAAAAAAAAAAF9Db3JEbGxNYWluAG1zY29yZWUuZGxsAAAAAAD/JQAgABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAQAAAA",
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
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAADAAAAHAzAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
].join("");
