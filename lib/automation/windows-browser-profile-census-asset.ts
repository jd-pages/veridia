// Immutable .NET 4 read-only profile census. No runtime compilation, prewarm or process termination.
export const WINDOWS_BROWSER_PROFILE_CENSUS_SOURCE_SHA256 = "c69cc083c6cd670a4764c5e92e12ffcfdf0bbaf72bdaa855f60c17b4e8f10753";
export const WINDOWS_BROWSER_PROFILE_CENSUS_ASSEMBLY_SHA256 = "c4e12d49ca4100ea18a6b5fa77e553f03d6efe97ab522150cbcade85293020b7";
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
        Stage("SPI_IMAGE_READ",watch); if(!ImageName(handle,0,image,ref length) || length==0 || length>=32768)
          throw new InvalidOperationException("PROFILE_OWNERSHIP_UNAVAILABLE");
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
  "BgAAAfkABgAHAfkABgARAfkABgDRAcUBCgC1AqICBgAQA/UCBgAXA/UCBgBRBvkABgBeBvkABgCmBocGBgC5B5kHBgDZ",
  "B5kHBgD3B4cGBgBnCPkABgB3CPkABgB8CPkABgCgCIcGBgDACPkABgDrCPkABgASCfkABgA9CfkABgBWCfkABgByCfkA",
  "BgCpCfkADgDhCfUCBgAlCvkABgBCCi8KBgBXCvkABgByCl0KBgCTCvkABgCZCvkABgCyCvkABgDCCvkABgDTCvkABgDo",
  "CvkABgD7CvkABgANCwMLBgCFC/kABgCYCwMLGwCpCwAABgDOC/kABgD4Cy8KBgALDPkABgAnDIcGBgA9DIcGBgBIDIcG",
  "BgBbDIcGBgBpDIcGBgCLDIcGBgCdDJkHAAAAAAEAAAAAAAEAAQCBAQAAKgAAAAUAAQABAAsBEABGAAAACQAOABoACwEQ",
  "AE4AAAAJABEAGgALAREAWAAAAAkAMgAaAAsBEABgAAAACQA4ABoACwEQAGsAAAAJAEMAGgALARAAfAAAAAkASQAaAAsB",
  "EACFAAAACQBLABsAAwEQAJQAAAAFAFUAGwADARAAnQAAAAUAWQAcAAMBAACtAAAADQBjAB0AAwEAALgAAAANAGMAIQAD",
  "AQAAxAAAAA0AYwAlAAMBAADPAAAADQBjACkAAwEAAN8AAAANAGMALQADARAAUAsAAAUAYwAxAFGAIwEKAFGALwEKAFGA",
  "PQEKAFGASwEKAFGAVgEKAFGAZwEmABEAeAGeADEAXQL6ADEAaAL+ADEAdAICATEAfwIGATEAjwIKARYANwMmAAYAnwN1",
  "AQYApgN1AQYArgMKAQYAtQN4AQYAugN4AQYAwgN7AQYAyQN7AQYA0AN7AQYA1wN7AQYA4AN7AQYA5QN7AQYA7AN+AQYA",
  "8gMKAAYA+wMKAQYA/wMKAQYABgR4AQYADgR4AQYAFgSCAQYAJASCAQYAMASCAQYAPAR4AQYAQwSCAQYATwSCAQYAVwSC",
  "AQYAYQSCAQYAZwSCAQYAdASCAQYAfQSCAQYAhgSCAQYAkwSCAQYAoAR7AQYAqAR7AQYAsQR7AQYAugR7AQYAxAR7AQYA",
  "zwR7AQYA2gR4AQYA3wR4AQYA5QR4AQYA6wR4AQYA8QR4AQYQ+gQmAAYABgV1AQYAEwV1AQYAHAV4AQYAJQUKAQYApgMK",
  "AQYALQWCAQYAMgV4AQYAPQV4AQYAQgV4AQYATgV1AQYAVAV1AQYAXQUKAAYAaAUKAQYAbAWCAQYA8gMKAAYA+wOCAQYA",
  "dQWCAQYAfwV4AQYAgwV4AQYA2gR4AQYAPAR4AQYAmAWCAQYApwWCAQYAVwSCAQYAYQSCAQYAZwSCAQYAdASCAQYAfQSC",
  "AQYAhgSCAQYAsgUKAQYA+wN4AQYAuQWNAQYAvwWQAQYAyQUKAAYA0QUKAAYA3AUKAAYA5wUKAAYA9QWNAQYA/wWNAQYA",
  "DAYmAAYAFQYmAAYAIQYmAAYANAYmAAYA+wMKAAAAAACAAJEgiAGiAAEAAAAAAIAAkSCcAakAAgAAAAAAgACRIKgBsAAF",
  "AAAAAACAAJEgtQG1AAYAAAAAAIAAkSDfAcYACwAAAAAAgACRIOkB0AAPAAAAAACAAJEg9QHVABAAAAAAAIAAkSAJAtsA",
  "EgAAAAAAgACRIBkC2wATAAAAAACAAJEgJQLgABQAAAAAAIAAkSA0AuYAFgAAAAAAgACRIEkC7wAZAFAgAAAAAJEYmwIN",
  "AR8AvCIAAAAAkQC/AhEBHwDoIgAAAACRAMkCGAEhAEwjAAAAAJEA2QIcASEA3CMAAAAAkQDkAiABIQCQJAAAAACRACQD",
  "JQEiAGQpAAAAAJEALQM4AScAoCoAAAAAkQBBA08BKgDYKgAAAACWAEcDVgEsAEArAAAAAJYAVQNaASwAfCsAAAAAkQBo",
  "A2EBLgDMKwAAAACRAH8DaAExADQtAAAAAJYAjwNtATIABDIAAAAAhgiIBYUBNAAYMgAAAACGGMMFmAE0ACAyAAAAAIYY",
  "wwWYATQAAAAAAAMAhhjDBZwBNAAAAAAAAwDGAUoGogE2AAAAAAADAMYBbAauATsAAAAAAAMAxgF4Br4BQgAAAAAAAwCG",
  "GMMFnAFFAAAAAAADAMYBSgbJAUcAAAAAAAMAxgFsBtIBSwAAAAAAAwDGAXgG3wFRAAAAAAADAIYYwwWcAVMAAAAAAAMA",
  "xgFKBucBVQAAAAAAAwDGAWwG7gFWAAAAAAADAMYBeAb5AVkAAAAAAAMAhhjDBZwBWwAAAAAAAwDGAUoGAgJdAAAAAAAD",
  "AMYBbAYJAl4AAAAAAAMAxgF4BhQCYQAAAAAAAwCGGMMFnAFjAAAAAAADAMYBSgYdAmUAAAAAAAMAxgFsBicCagAAAAAA",
  "AwDGAXgG3wFxABwrAAAAAIYYwwWYAXMAJCsAAAAAhgBjC4wDcwACAAEAggYAAAEAswYAAAIAugYAAAMA+wMAAAEAsgUA",
  "AAEAsgUCAAIA1wMCAAMAwgYCAAQA5QMCAAUA4AMAAAEAsgUAAAIAxwYAAAMAzQYAAAQAnwMAAAEAsgUAAAEAsgUAAAIA",
  "0wYAAAEA4AYAAAEA4AYAAAEA5QYAAAIA4AYAAAEAsgUAAAIA7AYAAAMA2gQAAAEA9QYAAAIA+wYAAAMAAQcAAAQACQcA",
  "AAUAEAcAAAYAEwUAAAEAGwcAAAIAIQcAAAEA4AYAAAEArgMAAAIAKgcAAAMAMwcAAAQAGwcAAAUAIQcAAAEAGwcAAAIA",
  "IQcCAAMARgcAAAEAzQYAAAIATwcAAAEA+wMAAAIAGwcAAAEAsgUAAAIA+wMAAAMAuQUAAAEAsgUAAAEAVQcAAAIAGwcA",
  "AAEAYAcAAAIAZwcAAAEAsgUAAAIAbgcCAAMAcwcAAAQA2gQCAAUAKgcAAAEAsgUAAAIAbgcCAAMAcwcAAAQA2gQCAAUA",
  "KgcAAAYAegcAAAcAYAcCAAEAcwcCAAIAKgcAAAMAgwcAAAEAYAcAAAIAZwcAAAEAbgcAAAIArgMAAAMA+wYCAAQAKgcA",
  "AAEAbgcAAAIArgMAAAMA+wYCAAQAKgcAAAUAegcAAAYAYAcCAAEAKgcAAAIAcwcAAAEAYAcAAAIAZwcAAAEAjAcAAAEA",
  "jAcAAAIAegcAAAMAYAcAAAEAjAcAAAIAcwcAAAEAYAcAAAIAZwcCAAEAlAcCAAEAlAcAAAIAegcAAAMAYAcCAAEAlAcA",
  "AAIAcwcAAAEAYAcAAAIAZwcAAAEAsgUAAAIAbgcAAAMArgMAAAQA+wYCAAUAKgcAAAEAsgUAAAIAbgcAAAMArgMAAAQA",
  "+wYCAAUAKgcAAAYAegcAAAcAYAcCAAEAKgcAAAIAcwcAAAEAvwVRAMMFmAFZAMMFNQJhAMMFmAFpAMMFOgJxAG4IPwJ5",
  "AI4IQwKJAKgISgKJAK8IUAJxALgIVwKRAMMFOgJxANoICgFxAN8IWwKJAPQIYQIpABsJcwKhACcJeAKpAEYJgQK5AHkJ",
  "lAK5AIwJVwK5AJcJmQK5AJ8JngLBAK4JowLBAL4JowJxAM0JrAIMAMMFmAEUAMMFmAFxAOsJwQKJAO8JxwIMAP4JVwIU",
  "AOsJzgJxAAgKWwKJABYK1ALRAE4K2gIcAMMFmAEcAOsJ5gLpAH4K7gLxAKkK8wIBAakK8wLZALkK+QKpAKkK/wIJAcoK",
  "hQEMAOsJBgOJANsKPwOJAO8KRAMhARgLawMpACILrAIpAToLcQPRAEQLfAO5AN8IgAMJAMMFmAEcAHwLlgMkAMMFnAEM",
  "AJELqQMsAMMFmAE5AZ0L6wMMALQL8AM0AMILBgS5AN8LCwSJAOYLPwIpAToLFAS5AAgKgAMhAMMFNQIJAKkKfANRAcMF",
  "mAFRAesJ+QIsAOsJBgM0AAIMGwRZARcMmAEsAB8MHwRhAcMFawRxAcMFcgSBAcMFfQSRAcMFmAEIAAQADQAIAAgAEgAI",
  "AAwAFwAIABAAHAAIABQAIQAOABgAKQAuABMAkgQuABsAmwSDATsChASjATsChATDATsChATjATsChAQDAjsChAQjAkMC",
  "jQRuAHkEaQJ8AocCjQKoAgwDSQN4A4YDtAPJA9UDJQQIAAEAAACSBYkBAgAaAAMACghQCFoIsAK7At8CnQPlA/oDAAED",
  "AIgBAQBAAQUAnAEBAEABBwCoAQEAQAEJALUBAQBEAQsAFwgBAEABDQDpAQEAQAEPAPUBAQBEAREAMggBAEQBEwBDCAEA",
  "QwEVACUCAQBAARcANAICAEABGQBJAgMABIAAAAAAAAAAAAAAAAAAAAAAKgAAAAQAAAAAAAAAAAAAAAEA8AAAAAAABAAA",
  "AAAAAAAAAAAAAQD5AAAAAAAEAAAAAAAAAAAAAAABANUJAAAAAAMAAgAEAAIABQACAAYAAgAHAAIACAACAAkAAgAKAAIA",
  "CwACAAwAAgANAAIADgACAA8AAgAQAAIAEQACAAAAADxNb2R1bGU+AFZlcmlkaWFCcm93c2VyUHJvZmlsZUNlbnN1cy5k",
  "bGwAVmVyaWRpYUJyb3dzZXJQcm9maWxlQ2Vuc3VzAFVuaWNvZGUAU3BpUHJlZml4AFZlcnNpb24AU3lzdGVtSW5mbwBC",
  "YXNpY0luZm9ybWF0aW9uAEZpbGVUaW1lAE1lbW9yeUNvdW50ZXJzAFJldGFpbmVkAFByb3ZpZGVyQmluZGluZwBRdWVy",
  "eUJhc2ljAFF1ZXJ5U3lzdGVtAEdldFZlcnNpb24AUXVlcnlQcmVjaXNlVXRjAFF1ZXJ5SW5mb3JtYXRpb24AbXNjb3Js",
  "aWIAU3lzdGVtAE9iamVjdABWYWx1ZVR5cGUATXVsdGljYXN0RGVsZWdhdGUAU3BpQ2FwYWNpdHkAU3BpSGVhZGVyU2l6",
  "ZQBTcGlUaHJlYWRTaXplAFNwaU1heFJvd3MAU3BpTWF4SW1hZ2VDaGFycwBTcGlMYXlvdXRQcm9maWxlAHByb3ZpZGVy",
  "QmluZGluZwBHZXROYXRpdmVTeXN0ZW1JbmZvAE9wZW5Qcm9jZXNzAEdldFByb2Nlc3NJZABHZXRQcm9jZXNzVGltZXMA",
  "U3lzdGVtLlRleHQAU3RyaW5nQnVpbGRlcgBJbWFnZU5hbWUAQ2xvc2VIYW5kbGUAV2FpdEZvclNpbmdsZU9iamVjdABH",
  "ZXRNb2R1bGVIYW5kbGUATG9hZExpYnJhcnkAR2V0UHJvY0FkZHJlc3MAR2V0UHJvY2Vzc01lbW9yeUluZm8AR2V0RXh0",
  "ZW5kZWRUY3BUYWJsZQBxdWVyeUJhc2ljAHF1ZXJ5U3lzdGVtAGdldFZlcnNpb24AcXVlcnlQcmVjaXNlVXRjAG50ZGxs",
  "TW9kdWxlAC5jY3RvcgBTeXN0ZW0uRGlhZ25vc3RpY3MAU3RvcHdhdGNoAFJlbWFpbmluZwBQcmVjaXNlVXRjQm91bmQA",
  "U3BpVmVyc2lvbgBWYWxpZGF0ZVNwaUltYWdlAFN5c3RlbS5Db2xsZWN0aW9ucy5HZW5lcmljAExpc3RgMQBEaWN0aW9u",
  "YXJ5YDIAUGFyc2VTcGkAUHJvY2Vzc2VzAExhc3RTdGFnZQBTdGFnZQBJc0FwcHJvdmVkQWJpAFByb2Nlc3NTdGlsbEV4",
  "aXN0cwBTYW1lSGVsZElkZW50aXR5RXhpdGVkAFJlYWRDb21tYW5kTGluZQBSZWFkUHJvZmlsZVJvd3MAbGVuZ3RoAG1h",
  "eGltdW0AYnVmZmVyAG5leHQAdGhyZWFkcwBzcGFyZTEAc3BhcmUyAHNwYXJlMwBjcmVhdGlvbgB1c2VyAGtlcm5lbABp",
  "bWFnZQBwcmlvcml0eQBwaWQAcGFyZW50AGhhbmRsZXMAc2Vzc2lvbgBwYWdlRGlyZWN0b3J5AHBlYWtWaXJ0dWFsAHZp",
  "cnR1YWxTaXplAGZhdWx0cwBwZWFrV29ya2luZwB3b3JraW5nAHBlYWtQYWdlZABwYWdlZABwZWFrTm9uUGFnZWQAbm9u",
  "UGFnZWQAcGFnZWZpbGUAcGVha1BhZ2VmaWxlAHByaXZhdGVQYWdlcwByZWFkT3BzAHdyaXRlT3BzAG90aGVyT3BzAHJl",
  "YWRCeXRlcwB3cml0ZUJ5dGVzAG90aGVyQnl0ZXMAc2l6ZQBtYWpvcgBtaW5vcgBidWlsZABwbGF0Zm9ybQBzZXJ2aWNl",
  "UGFjawBhcmNoaXRlY3R1cmUAcmVzZXJ2ZWQAcGFnZVNpemUAbWluaW11bQBtYXNrAHByb2Nlc3NvcnMAdHlwZQBncmFu",
  "dWxhcml0eQBsZXZlbAByZXZpc2lvbgBleGl0U3RhdHVzAHBlYgBhZmZpbml0eQBwYXJlbnRQaWQAbG93AGhpZ2gAZ2V0",
  "X1ZhbHVlAFZhbHVlAHBlYWtXb3JraW5nU2V0AHdvcmtpbmdTZXQAaGFuZGxlAGJpcnRoAHJvdwAuY3RvcgBzZWxmUGlk",
  "AHdyYXBwZXJQaWQAc2VsZlBhcmVudAB3cmFwcGVyUGFyZW50AHNlbGZCaXJ0aAB3cmFwcGVyQmlydGgAc2VsZk5hbWUA",
  "d3JhcHBlck5hbWUAc2VsZkNhbm9uaWNhbEJpcnRoAHdyYXBwZXJDYW5vbmljYWxCaXJ0aABJbnZva2UASUFzeW5jUmVz",
  "dWx0AEFzeW5jQ2FsbGJhY2sAQmVnaW5JbnZva2UARW5kSW52b2tlAGluZm8AU3lzdGVtLlJ1bnRpbWUuSW50ZXJvcFNl",
  "cnZpY2VzAE91dEF0dHJpYnV0ZQBhY2Nlc3MAaW5oZXJpdABleGl0AGZsYWdzAHZhbHVlAG1pbGxpc2Vjb25kcwBuYW1l",
  "AG1vZHVsZQBjb3VudGVycwB0YWJsZQBieXRlcwBvcmRlcmVkAGZhbWlseQB0YWJsZUNsYXNzAHdhdGNoAGJ1ZGdldE1z",
  "AHJldHVybmVkAHV0Y0JpcnRoVXBwZXJCb3VuZABjb3ZlcmFnZQBjbG9jawBleGVjdXRhYmxlAG9iamVjdABtZXRob2QA",
  "a2luZAByZXN1bHQAY2FsbGJhY2sAX19yZXN1bHQAdmVyc2lvbgB0aW1lAFN5c3RlbS5SdW50aW1lLkNvbXBpbGVyU2Vy",
  "dmljZXMAQ29tcGlsYXRpb25SZWxheGF0aW9uc0F0dHJpYnV0ZQBSdW50aW1lQ29tcGF0aWJpbGl0eUF0dHJpYnV0ZQBE",
  "bGxJbXBvcnRBdHRyaWJ1dGUAa2VybmVsMzIuZGxsAFF1ZXJ5RnVsbFByb2Nlc3NJbWFnZU5hbWVXAEdldE1vZHVsZUhh",
  "bmRsZVcATG9hZExpYnJhcnlXAHBzYXBpLmRsbABpcGhscGFwaS5kbGwASW50UHRyAGdldF9TaXplAFR5cGUAUnVudGlt",
  "ZVR5cGVIYW5kbGUAR2V0VHlwZUZyb21IYW5kbGUATWFyc2hhbABTaXplT2YAT2Zmc2V0T2YAVG9JbnQzMgBJbnZhbGlk",
  "T3BlcmF0aW9uRXhjZXB0aW9uAFplcm8Ab3BfRXF1YWxpdHkARGVsZWdhdGUAR2V0RGVsZWdhdGVGb3JGdW5jdGlvblBv",
  "aW50ZXIAVGltZVNwYW4AZ2V0X0VsYXBzZWQAZ2V0X1RvdGFsTWlsbGlzZWNvbmRzAERhdGVUaW1lAEZyb21GaWxlVGlt",
  "ZVV0YwBBcmd1bWVudE91dE9mUmFuZ2VFeGNlcHRpb24AU3RyaW5nAElzTnVsbE9yV2hpdGVTcGFjZQBnZXRfTGVuZ3Ro",
  "AEluZGV4T2YAZ2V0X0NoYXJzAENoYXIASXNIaWdoU3Vycm9nYXRlAElzTG93U3Vycm9nYXRlAFRvSW50NjQAU3lzdGVt",
  "LkNvcmUASGFzaFNldGAxAEFkZABQdHJUb1N0cnVjdHVyZQBnZXRfQ291bnQAb3BfSW5lcXVhbGl0eQBQdHJUb1N0cmlu",
  "Z1VuaQBFeGNlcHRpb24AU3lzdGVtLkNvbGxlY3Rpb25zAElEaWN0aW9uYXJ5AGdldF9EYXRhAEludDMyAFN5c3RlbS5H",
  "bG9iYWxpemF0aW9uAEN1bHR1cmVJbmZvAGdldF9JbnZhcmlhbnRDdWx0dXJlAEludDY0AElGb3JtYXRQcm92aWRlcgBU",
  "b1N0cmluZwBVSW50NjQAc2V0X0l0ZW0AVUludFB0cgBUb1VJbnQ2NABCb29sZWFuAEFsbG9jSEdsb2JhbABVSW50MzIA",
  "RnJlZUhHbG9iYWwAQ29uc29sZQBTeXN0ZW0uSU8AVGV4dFdyaXRlcgBnZXRfRXJyb3IAZ2V0X0VsYXBzZWRNaWxsaXNl",
  "Y29uZHMAV3JpdGVMaW5lAGdldF9NZXNzYWdlADw+Y19fRGlzcGxheUNsYXNzNAA8UHJvY2Vzc1N0aWxsRXhpc3RzPmJf",
  "XzMAZ2V0X0l0ZW0AUHJlZGljYXRlYDEARXhpc3RzAFBhdGgAR2V0RmlsZU5hbWUARW51bWVyYXRvcgBHZXRFbnVtZXJh",
  "dG9yAGdldF9DdXJyZW50AFN0cmluZ0NvbXBhcmlzb24ARXF1YWxzAEdldExhc3RXaW4zMkVycm9yAEhhc2h0YWJsZQBN",
  "b3ZlTmV4dABJRGlzcG9zYWJsZQBEaXNwb3NlAFRvQXJyYXkAU3RydWN0TGF5b3V0QXR0cmlidXRlAExheW91dEtpbmQA",
  "TWFyc2hhbEFzQXR0cmlidXRlAFVubWFuYWdlZFR5cGUAVW5tYW5hZ2VkRnVuY3Rpb25Qb2ludGVyQXR0cmlidXRlAENh",
  "bGxpbmdDb252ZW50aW9uAENvbXBpbGVyR2VuZXJhdGVkQXR0cmlidXRlAAARYwByAGUAYQB0AGkAbwBuAAALaQBtAGEA",
  "ZwBlAAAHcABpAGQAAA1wAGEAcgBlAG4AdAAAD3cAbwByAGsAaQBuAGcAADNOAEEAVABJAFYARQBfAEwAQQBZAE8AVQBU",
  "AF8AVQBOAFMAVQBQAFAATwBSAFQARQBEAAATbgB0AGQAbABsAC4AZABsAGwAADFOAEEAVABJAFYARQBfAE4AVABEAEwA",
  "TABfAFUATgBBAFYAQQBJAEwAQQBCAEwARQAAM04AdABRAHUAZQByAHkASQBuAGYAbwByAG0AYQB0AGkAbwBuAFAAcgBv",
  "AGMAZQBzAHMAAD9OAEEAVABJAFYARQBfAEIAQQBTAEkAQwBfAEUAWABQAE8AUgBUAF8AVQBOAEEAVgBBAEkATABBAEIA",
  "TABFAAAxTgB0AFEAdQBlAHIAeQBTAHkAcwB0AGUAbQBJAG4AZgBvAHIAbQBhAHQAaQBvAG4AADtTAFAASQBfAFMAWQBT",
  "AFQARQBNAF8ARQBYAFAATwBSAFQAXwBVAE4AQQBWAEEASQBMAEEAQgBMAEUAABtSAHQAbABHAGUAdABWAGUAcgBzAGkA",
  "bwBuAAA9UwBQAEkAXwBWAEUAUgBTAEkATwBOAF8ARQBYAFAATwBSAFQAXwBVAE4AQQBWAEEASQBMAEEAQgBMAEUAABlr",
  "AGUAcgBuAGUAbAAzADIALgBkAGwAbAAAPUcAZQB0AFMAeQBzAHQAZQBtAFQAaQBtAGUAUAByAGUAYwBpAHMAZQBBAHMA",
  "RgBpAGwAZQBUAGkAbQBlAABFUwBQAEkAXwBQAFIARQBDAEkAUwBFAF8AVQBUAEMAXwBFAFgAUABPAFIAVABfAFUATgBB",
  "AFYAQQBJAEwAQQBCAEwARQAAK04AQQBUAEkAVgBFAF8AUQBVAEUAUgBZAF8ARABFAEEARABMAEkATgBFAAA7UwBQAEkA",
  "XwBQAFIARQBDAEkAUwBFAF8AVQBUAEMAXwBCAE8AVQBOAEQAXwBJAE4AVgBBAEwASQBEAAArUwBQAEkAXwBVAE4AQQBQ",
  "AFAAUgBPAFYARQBEAF8ATwBTAF8AQQBCAEkAAC1TAFAASQBfAEkATQBBAEcARQBfAE4AQQBNAEUAXwBJAE4AVgBBAEwA",
  "SQBEAAAvUwBQAEkAXwBJAE0AQQBHAEUAXwBVAFQARgAxADYAXwBJAE4AVgBBAEwASQBEAAAzUwBQAEkAXwBSAEUAVABV",
  "AFIATgBfAEwARQBOAEcAVABIAF8ASQBOAFYAQQBMAEkARAAAMVMAUABJAF8ARQBOAFQAUgBZAF8AQgBPAFUATgBEAFMA",
  "XwBJAE4AVgBBAEwASQBEAABDUwBQAEkAXwBUAEgAUgBFAEEARABfAE8AUgBfAE4ARQBYAFQAXwBCAE8AVQBOAEQAUwBf",
  "AEkATgBWAEEATABJAEQAADlTAFAASQBfAEkATgBWAEUATgBUAE8AUgBZAF8ATABJAE0ASQBUAF8ARQBYAEMARQBFAEQA",
  "RQBEAAA5UwBQAEkAXwBQAEkARABfAEkATgBWAEEATABJAEQAXwBPAFIAXwBEAFUAUABMAEkAQwBBAFQARQAAM1MAUABJ",
  "AF8ASQBEAEwARQBfAFMARQBOAFQASQBOAEUATABfAEkATgBWAEEATABJAEQAADVTAFAASQBfAFUATgBJAEMATwBEAEUA",
  "XwBCAE8AVQBOAEQAUwBfAEkATgBWAEEATABJAEQAAEdTAFAASQBfAEIASQBSAFQASABfAE8AVQBUAFMASQBEAEUAXwBD",
  "AEEAUABUAFUAUgBFAF8AVQBUAEMAXwBCAE8AVQBOAEQAACNiAGkAcgB0AGgARwB1AGEAcgBkAEYAYQBpAGwAdQByAGUA",
  "AA1iAHIAYQBuAGMAaAAAL0EARgBUAEUAUgBfAFAAUgBFAEMASQBTAEUAXwBVAFQAQwBfAEIATwBVAE4ARAAAJU4ATwBO",
  "AF8AUABPAFMASQBUAEkAVgBFAF8AQgBJAFIAVABIAAATcABhAHIAZQBuAHQAUABpAGQAAB1jAHIAZQBhAHQAaQBvAG4A",
  "UwBpAGcAbgBlAGQAACV1AHQAYwBCAGkAcgB0AGgAVQBwAHAAZQByAEIAbwB1AG4AZAAAF2MAbABvAGMAawBTAG8AdQBy",
  "AGMAZQAASUcARQBUAF8AUwBZAFMAVABFAE0AXwBUAEkATQBFAF8AUABSAEUAQwBJAFMARQBfAEEAUwBfAEYASQBMAEUA",
  "XwBUAEkATQBFAAA5eQB5AHkAeQAtAE0ATQAtAGQAZABUAEgASAA6AG0AbQA6AHMAcwAuAGYAZgBmAGYAZgBmAGYAWgAB",
  "P1MAUABJAF8AVwBPAFIASwBJAE4ARwBfAFMARQBUAF8AVQBOAFIARQBQAFIARQBTAEUATgBUAEEAQgBMAEUAAAluAGEA",
  "bQBlAAATYwByAGUAYQB0AGUAZABBAHQAACFuAGEAdABpAHYAZQBCAGkAcgB0AGgAUwB0AGEAbQBwAAAfdwBvAHIAawBp",
  "AG4AZwBTAGUAdABCAHkAdABlAHMAACluAGEAdABpAHYAZQBJAGQAZQBuAHQAaQB0AHkAUwB0AGEAdAB1AHMAAFdTAE4A",
  "QQBQAFMASABPAFQAXwBPAE4ATABZAF8AQgBJAFIAVABIAF8AUABBAFIARQBOAFQAXwBOAEEATQBFAF8ATwBCAFMARQBS",
  "AFYAQQBUAEkATwBOAAA9UwBQAEkAXwBJAEQATABFAF8AUwBFAE4AVABJAE4ARQBMAF8ATgBPAF8AQQBVAFQASABPAFIA",
  "SQBUAFkAACdwAGEAcgBlAG4AdABJAGQAZQBuAHQAaQB0AHkAUAByAG8AbwBmAABfUwBQAEkAXwBTAE4AQQBQAFMASABP",
  "AFQAXwBCAEkAUgBUAEgAXwBQAEEAUgBFAE4AVABfAE4AQQBNAEUAXwBPAEIAUwBFAFIAVgBBAFQASQBPAE4AXwBPAE4A",
  "TABZAAAhbABpAHYAZQBBAHQAQwBhAHAAdAB1AHIAZQBFAG4AZAAAJW8AdwBuAGUAcgBzAGgAaQBwAEEAdQB0AGgAbwBy",
  "AGkAdAB5AAAnUwBQAEkAXwBFAE0AUABUAFkAXwBJAE4AVgBFAE4AVABPAFIAWQAAM1MAUABJAF8AUQBVAEUAUgBZAF8A",
  "TgBUAFMAVABBAFQAVQBTAF8ARgBBAEkATABFAEQAAA9vAHMAQgB1AGkAbABkAAAZYQByAGMAaABpAHQAZQBjAHQAdQBy",
  "AGUAAAtBAE0ARAA2ADQAABtsAGEAeQBvAHUAdABQAHIAbwBmAGkAbABlAAB1UwBQAEkAXwBYADYANABfAFAAUgBFAEYA",
  "SQBYADIANQA2AF8AVABIAFIARQBBAEQAOAAwAF8AQwBSAEUAQQBUAEUAMwAyAF8ASQBNAEEARwBFADUANgBfAFAASQBE",
  "ADgAMABfAFAAQQBSAEUATgBUADgAOAAAF3EAdQBlAHIAeQBTAHQAYQB0AHUAcwAAGXIAZQB0AHUAcgBuAEwAZQBuAGcA",
  "dABoAAAdYgB1AGYAZgBlAHIAQwBhAHAAYQBjAGkAdAB5AAAjaQBuAHYAZQBuAHQAbwByAHkAQwBvAG0AcABsAGUAdABl",
  "AAA5cwBuAGEAcABzAGgAbwB0AEMAbwBtAHAAbABlAHQAZQBkAFUAdABjAEYAaQBsAGUAVABpAG0AZQAAR1YARQBSAEkA",
  "RABJAEEAXwBQAFIATwBGAEkATABFAF8AUABSAE8AQgBFAF8AUwBUAEEARwBFAD0AewAwAH0AOgB7ADEAfQAAO1AAUgBP",
  "AEYASQBMAEUAXwBPAFcATgBFAFIAUwBIAEkAUABfAFUATgBBAFYAQQBJAEwAQQBCAEwARQAAI1MAUABJAF8AQwBBAFAA",
  "VABVAFIARQBfAEUATgBUAEUAUgAAJVMAUABJAF8AQwBBAFAAVABVAFIARQBfAFIARQBUAFUAUgBOAAArUwBQAEkAXwBI",
  "AEUATABEAF8AUABSAE8AQwBFAFMAUwBfAE8AUABFAE4AAGNWAEUAUgBJAEQASQBBAF8AUABSAE8ARgBJAEwARQBfAFAA",
  "UgBPAEIARQBfAEMARQBOAFMAVQBTAF8ATwBQAEUATgA9AHsAMAB9ADoAewAxAH0AOgB7ADIAfQA6AHsAMwB9AAALRgBB",
  "AEwAUwBFAAAJVABSAFUARQAAM1MAUABJAF8AVgBFAFIASQBGAEkARQBEAF8AQQBCAFMARQBOAEMARQBfAFMASwBJAFAA",
  "AD9MAEkAVgBFAF8AUABSAE8AQwBFAFMAUwBfAEgAQQBOAEQATABFAF8AVQBOAEEAVgBBAEkATABBAEIATABFAAA3TABJ",
  "AFYARQBfAFAAUgBPAEMARQBTAFMAXwBCAEkAUgBUAEgAXwBNAEkAUwBNAEEAVABDAEgAAB1TAFAASQBfAEkATQBBAEcA",
  "RQBfAFIARQBBAEQAACFTAFAASQBfAEkATQBBAEcARQBfAFIARQBUAFUAUgBOAAArUwBQAEkAXwBDAE8ATQBNAEEATgBE",
  "AF8ATABJAE4ARQBfAFIARQBBAEQAAC9TAFAASQBfAEMATwBNAE0AQQBOAEQAXwBMAEkATgBFAF8AUgBFAFQAVQBSAE4A",
  "ABNQAHIAbwBjAGUAcwBzAEkAZAAAH1AAYQByAGUAbgB0AFAAcgBvAGMAZQBzAHMASQBkAAAdRQB4AGUAYwB1AHQAYQBi",
  "AGwAZQBQAGEAdABoAAAXQwBvAG0AbQBhAG4AZABMAGkAbgBlAAAZQwByAGUAYQB0AGkAbwBuAEQAYQB0AGUAADFOAGEA",
  "dABpAHYAZQBTAG4AYQBwAHMAaABvAHQAQgBpAHIAdABoAFMAdABhAG0AcAAALVMAUABJAF8AVgBFAFIASQBGAEkARQBE",
  "AF8ARQBYAEkAVABfAFMASwBJAFAAADFTAFAASQBfAEgARQBMAEQAXwBQAFIATwBDAEUAUwBTAF8ARABJAFMAUABPAFMA",
  "RQAARU4AQQBUAEkAVgBFAF8AUABSAE8AQwBFAFMAUwBfAEgAQQBOAEQATABFAF8AQwBMAE8AUwBFAF8ARgBBAEkATABF",
  "AEQAAAAAAMc8OKK4UL9KpVSrHX22c+AACLd6XFYZNOCJAgYIBAAAgAAEAAEAAARQAAAABACAAAAEBAEAAAIGDnRTAFAA",
  "SQBfAFgANgA0AF8AUABSAEUARgBJAFgAMgA1ADYAXwBUAEgAUgBFAEEARAA4ADAAXwBDAFIARQBBAFQARQAzADIAXwBJ",
  "AE0AQQBHAEUANQA2AF8AUABJAEQAOAAwAF8AUABBAFIARQBOAFQAOAA4AAMGEiwGAAEBEBEYBgADGAkCCQQAAQkYEAAF",
  "AhgQESAQESAQESAQESAJAAQCGAkSERAJBAABAhgFAAIJGAkEAAEYDgUAAhgYDggAAwIYEBEkCQoABgkYEAkCCQgJAwYS",
  "MAMGEjQDBhI4AwYSPAIGGAMAAAEGAAIBEhUIAwAACwMAAAkEAAEBDhIABRUSGQEVEh0CDhwYCQsSFQgWAAMVEhkBFRId",
  "Ag4cEhUIEBUSHQIOHAYAAgEOEhUDAAACBgACAggSFQYAAwIYCA4EAAEOGAcAAh0cDhIVAgYHAgYJAgYKAwYRDAIGGQMg",
  "AAsDKAALAgYLBwYVEh0CDhwDIAABBSACARwYCyAFCBgIEBEcCRAJDyAHEiEYCBARHAkQCRIlHAogAwgQERwQCRIhCCAE",
  "CAgYCRAJDCAGEiEIGAkQCRIlHAcgAggQCRIhBiABCBARFAogAxIhEBEUEiUcCCACCBARFBIhBiABARARIAogAxIhEBEg",
  "EiUcCCACARARIBIhCSAFCBgIGAkQCQ0gBxIhGAgYCRAJEiUcBCABAQgEIAEBDgMAAAgGAAESPRFBBQABCBI9BgACGBI9",
  "DgMgAAgFAAICGBgHAAISTRgSPQkHBxgYGBgYGBgEIAARUQMgAA0EBwERUQUAARFVCgUHAhEgCwYHAhEYERQEAAECDgQg",
  "AQgDBCABAwgEAAECAwMHAQgDIAAKChUSGQEVEh0CDhwFFRJlAQgFAAIYGAgGAAIcGBI9BSABAhMABQACDhgIBCAAEm0G",
  "FRIdAg4cByACARMAEwEEAAASdQUgAQ4SfQUgAgEcHAYgAg4OEn0FIAEBEwAyBxYKCggVEhkBFRIdAg4cFRJlAQgREAoK",
  "Cg4KCgoKDg4SSRUSHQIOHAsLFRIdAg4cEVUEAAEYCAQAAQEYIQcICRgJCAsVEhkBFRIdAg4cFRIdAg4cFRIZARUSHQIO",
  "HAUAABKAlQYgAwEOHBwDBwEKAyAADgUAAgIODgUHAhJJAgkgAQIVEh0CDhwGIAETARMACxUSgJkBFRIdAg4cCiABAhUS",
  "gJkBEwAUBwMVEh0CDhwVEhkBFRIdAg4cEkQLBwURIBEgESARIAsPBwsYEkAYCQgRDAoKCg4OBRUSGQEcBAABDg4JIAAV",
  "EYChARMACxURgKEBFRIdAg4cBCAAEwAIAAMCDg4RgKUGIAIBDh0cAyAAAgUgAB0TAEUHGBUSHQIOHBUSGQEVEh0CDhwV",
  "EhkBHA4VEh0CDhwYCAIRHAkRIBEgESARIBIRCQ4OEoCpEkkVEYChARUSHQIOHB0cCwsGIAEBEYC1BiABARGAvQMXgIAG",
  "IAEBEYDFCAEAAQAAAAAABAEAAAAIAQAIAAAAAAAeAQABAFQCFldyYXBOb25FeGNlcHRpb25UaHJvd3MBAAC0YAAAAAAA",
  "AAAAAADOYAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwGAAAAAAAAAAAAAAAABfQ29yRGxsTWFpbgBtc2NvcmVlLmRs",
  "bAAAAAAA/yUAIAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAEAAAABgAAIAAAAAAAAAAAAAAAAAAAAEAAQAAADAAAIAA",
  "AAAAAAAAAAAAAAAAAAEAAAAAAEgAAABYgAAAlAIAAAAAAAAAAAAAlAI0AAAAVgBTAF8AVgBFAFIAUwBJAE8ATgBfAEkA",
  "TgBGAE8AAAAAAL0E7/4AAAEAAAAAAAAAAAAAAAAAAAAAAD8AAAAAAAAABAAAAAIAAAAAAAAAAAAAAAAAAABEAAAAAQBW",
  "AGEAcgBGAGkAbABlAEkAbgBmAG8AAAAAACQABAAAAFQAcgBhAG4AcwBsAGEAdABpAG8AbgAAAAAAAACwBPQBAAABAFMA",
  "dAByAGkAbgBnAEYAaQBsAGUASQBuAGYAbwAAANABAAABADAAMAAwADAAMAA0AGIAMAAAACwAAgABAEYAaQBsAGUARABl",
  "AHMAYwByAGkAcAB0AGkAbwBuAAAAAAAgAAAAMAAIAAEARgBpAGwAZQBWAGUAcgBzAGkAbwBuAAAAAAAwAC4AMAAuADAA",
  "LgAwAAAAYAAgAAEASQBuAHQAZQByAG4AYQBsAE4AYQBtAGUAAABWAGUAcgBpAGQAaQBhAEIAcgBvAHcAcwBlAHIAUABy",
  "AG8AZgBpAGwAZQBDAGUAbgBzAHUAcwAuAGQAbABsAAAAKAACAAEATABlAGcAYQBsAEMAbwBwAHkAcgBpAGcAaAB0AAAA",
  "IAAAAGgAIAABAE8AcgBpAGcAaQBuAGEAbABGAGkAbABlAG4AYQBtAGUAAABWAGUAcgBpAGQAaQBhAEIAcgBvAHcAcwBl",
  "AHIAUAByAG8AZgBpAGwAZQBDAGUAbgBzAHUAcwAuAGQAbABsAAAANAAIAAEAUAByAG8AZAB1AGMAdABWAGUAcgBzAGkA",
  "bwBuAAAAMAAuADAALgAwAC4AMAAAADgACAABAEEAcwBzAGUAbQBiAGwAeQAgAFYAZQByAHMAaQBvAG4AAAAwAC4AMAAu",
  "ADAALgAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAGAAAAwAAADgMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
].join("");
