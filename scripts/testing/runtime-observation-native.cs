// Periodic read-only snapshot census. No process termination or WMI fallback.
// Historical SPI layout: Microsoft referencesource ProcessManager.cs:1179-1217,
// commit 3b1eaf5203992df69de44c783a3eda37d3d4cd10. Internal ABI is NOT guaranteed.
using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

public static class VeridiaWmiFreeRuntime {
  sealed class NativeCapabilityFailure : InvalidOperationException {
    public NativeCapabilityFailure(string code) : base(code) {}
  }
  sealed class NativeIdentityReadFailure : InvalidOperationException {
    readonly string operation;
    readonly uint? win32Error;
    readonly int? ntStatus;
    public NativeIdentityReadFailure(string code, string operation, uint? win32Error, int? ntStatus) : base(code) {
      this.operation=operation; this.win32Error=win32Error; this.ntStatus=ntStatus;
    }
    public Dictionary<string,object> Evidence() {
      return new Dictionary<string,object> { {"code", Message}, {"operation", operation},
        {"win32Error", win32Error.HasValue ? (object)win32Error.Value : null},
        {"ntStatus", ntStatus.HasValue ? (object)ntStatus.Value : null} };
    }
  }
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
  static VeridiaWmiFreeRuntime() {
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
  static Dictionary<string,object> Held(uint pid, bool includeMemory, List<Retained> retained) {
    IntPtr handle = OpenProcess(0x100400, false, pid); // Query-information + SYNCHRONIZE, no write/kill rights.
    if (handle == IntPtr.Zero) {
      int error=Marshal.GetLastWin32Error(); // Immediately capture this failing call, never a later helper's errno.
      throw new NativeIdentityReadFailure("NATIVE_HANDLE_UNAVAILABLE", "OPEN_PROCESS", unchecked((uint)error), null);
    }
    Exception primaryFailure=null;
    try {
      BasicInformation basic; uint returned;
      uint actualPid=GetProcessId(handle);
      uint? pidError=actualPid == 0 ? (uint?)unchecked((uint)Marshal.GetLastWin32Error()) : null;
      if (actualPid != pid) throw new NativeIdentityReadFailure("NATIVE_HELD_PID_MISMATCH", "GET_PROCESS_ID", pidError, null);
      int status = queryBasic(handle, 0, out basic, 48, out returned);
      if (status == unchecked((int)0xc0000002) || status == unchecked((int)0xc0000003) || status == unchecked((int)0xc0000004) ||
          (status == 0 && returned != 48)) throw new NativeCapabilityFailure("NATIVE_BASIC_ABI_UNSUPPORTED");
      if (status != 0 || basic.pid.ToUInt64() != pid || basic.parentPid.ToUInt64() > Int32.MaxValue)
        throw new NativeIdentityReadFailure("NATIVE_HELD_BASIC_INVALID", "NT_QUERY_BASIC", null, status);
      FileTime creation, exit, kernel, user;
      bool timesRead=GetProcessTimes(handle, out creation, out exit, out kernel, out user);
      uint? timesError=!timesRead ? (uint?)unchecked((uint)Marshal.GetLastWin32Error()) : null;
      if (!timesRead || creation.Value > Int64.MaxValue || creation.Value == 0)
        throw new NativeIdentityReadFailure("NATIVE_HELD_BIRTH_UNAVAILABLE", "GET_PROCESS_TIMES", timesError, null);
      StringBuilder image = new StringBuilder(32768); uint length = 32768;
      bool imageRead=ImageName(handle, 0, image, ref length);
      uint? imageError=!imageRead ? (uint?)unchecked((uint)Marshal.GetLastWin32Error()) : null;
      if (!imageRead || length == 0 || length >= 32768)
        throw new NativeIdentityReadFailure("NATIVE_HELD_IMAGE_UNAVAILABLE", "QUERY_FULL_PROCESS_IMAGE_NAME", imageError, null);
      string name = Path.GetFileName(image.ToString());
      if (String.IsNullOrWhiteSpace(name)) throw new NativeIdentityReadFailure("NATIVE_HELD_NAME_INVALID", "VALIDATE_IMAGE_BASENAME", null, null);
      ulong canonical = creation.Value / 10 * 10;
      Dictionary<string,object> row = new Dictionary<string,object> {
        {"pid", (int)pid}, {"parentPid", (int)basic.parentPid.ToUInt64()}, {"name", name},
        {"createdAt", DateTime.FromFileTimeUtc((long)canonical).ToString("yyyy-MM-ddTHH:mm:ss.fffffffZ", CultureInfo.InvariantCulture)},
        {"nativeBirthStamp", creation.Value.ToString(CultureInfo.InvariantCulture)},
        {"nativeIdentityStatus", "HELD_HANDLE_PID_PARENT_BIRTH_NAME_VERIFIED"},
        {"parentIdentityProof", "HELD_HANDLE_NT_BASIC_OBSERVATION_ONLY"}, {"liveAtCaptureEnd", false}
      };
      if (includeMemory) {
        MemoryCounters counters = new MemoryCounters(); counters.size = (uint)Marshal.SizeOf(typeof(MemoryCounters));
        if (GetProcessMemoryInfo(handle, ref counters, counters.size) && counters.workingSet.ToUInt64() <= 9007199254740991UL)
          row.Add("workingSetBytes", (long)counters.workingSet.ToUInt64());
      }
      retained.Add(new Retained { handle=handle, pid=pid, birth=creation.Value, row=row });
      handle=IntPtr.Zero; // Ownership moves to complete-census finally, not per-row release.
      return row;
    } catch(Exception error) { primaryFailure=error; throw; }
    finally {
      if(handle!=IntPtr.Zero && !CloseHandle(handle)) {
        if(primaryFailure!=null) primaryFailure.Data["secondaryHandleReleaseFailure"]="NATIVE_PROCESS_HANDLE_CLOSE_FAILED";
        else throw new InvalidOperationException("NATIVE_PROCESS_HANDLE_CLOSE_FAILED");
      }
    }
  }
  static void Revalidate(List<Retained> retained, Stopwatch watch, int budgetMs) {
    foreach(Retained item in retained) {
      Remaining(watch, budgetMs);
      FileTime creation, exit, kernel, user;
      if (GetProcessId(item.handle) != item.pid || !GetProcessTimes(item.handle, out creation, out exit, out kernel, out user) || creation.Value != item.birth)
        throw new NativeCapabilityFailure("NATIVE_RETAINED_IDENTITY_RECHECK_FAILED");
      uint wait=WaitForSingleObject(item.handle, 0);
      if (wait != 0 && wait != 258) throw new NativeCapabilityFailure("NATIVE_RETAINED_LIVENESS_RECHECK_FAILED");
      // lpExitTime is undefined for a live process. Only the actual native wait
      // result establishes endpoint liveness; no inference from that field.
      bool live=wait == 258;
      item.row["nativeWaitResult"]=wait;
      item.row["liveAtCaptureEnd"]=live;
      if (!live) {
        item.row["createdAt"]=null;
        item.row["nativeIdentityStatus"]="HELD_HANDLE_EXITED_NO_AUTHORITY";
      }
    }
  }
  static void CloseAll(List<Retained> retained) {
    bool failed=false;
    foreach(Retained item in retained) { if (!CloseHandle(item.handle)) failed=true; item.handle=IntPtr.Zero; }
    if (failed) throw new InvalidOperationException("NATIVE_PROCESS_HANDLE_CLOSE_FAILED");
  }
  static void CloseAllPreservingPrimary(List<Retained> retained, Exception primaryFailure) {
    try { CloseAll(retained); }
    catch {
      if(primaryFailure==null) throw;
      primaryFailure.Data["secondaryHandleReleaseFailure"]="NATIVE_PROCESS_HANDLE_CLOSE_FAILED";
    }
  }
  public static Dictionary<string,object> VerifyProvider(int expectedParent, int wrapperPid, string wrapperCreatedAt) {
    List<Retained> retained=new List<Retained>(); Stopwatch watch=Stopwatch.StartNew();
    if(providerBinding!=null) throw new InvalidOperationException("SPI_PROVIDER_BINDING_ALREADY_ESTABLISHED");
    Dictionary<string,object> self=null, wrapper=null; Exception primaryFailure=null;
    try {
      SpiVersion(); Remaining(watch,15000);
      int selfPid; using(Process selfProcess=Process.GetCurrentProcess()) { selfPid=selfProcess.Id; }
      self = Held((uint)selfPid, false, retained); wrapper = Held((uint)wrapperPid, false, retained);
      Revalidate(retained, watch, 15000);
      if ((int)self["parentPid"] != expectedParent || expectedParent != wrapperPid || (string)wrapper["createdAt"] != wrapperCreatedAt ||
          !String.Equals((string)self["name"], "powershell.exe", StringComparison.OrdinalIgnoreCase) ||
          !String.Equals((string)wrapper["name"], "node.exe", StringComparison.OrdinalIgnoreCase) ||
          !(bool)self["liveAtCaptureEnd"] || !(bool)wrapper["liveAtCaptureEnd"])
        throw new InvalidOperationException("NATIVE_PROVIDER_CALLER_IDENTITY_MISMATCH");
    } catch(Exception error) { primaryFailure=error; throw; }
    finally { CloseAllPreservingPrimary(retained,primaryFailure); }
    providerBinding=new ProviderBinding { selfPid=(int)self["pid"], wrapperPid=wrapperPid,
      selfParent=(int)self["parentPid"], wrapperParent=(int)wrapper["parentPid"],
      selfBirth=UInt64.Parse((string)self["nativeBirthStamp"],CultureInfo.InvariantCulture),
      wrapperBirth=UInt64.Parse((string)wrapper["nativeBirthStamp"],CultureInfo.InvariantCulture),
      selfName=(string)self["name"], wrapperName=(string)wrapper["name"],
      selfCanonicalBirth=(string)self["createdAt"], wrapperCanonicalBirth=wrapperCreatedAt };
    // Publish the original held native stamp; it cannot be reconstructed from
    // the floor-10 canonical CIM identity. No additional native query is made.
    self.Add("callerWrapperNativeBirthStamp",providerBinding.wrapperBirth.ToString(CultureInfo.InvariantCulture));
    return self;
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
  static void VerifyHeldBinding(Dictionary<string,object> row,int pid,int parent,string name,ulong birth,string canonical) {
    if((int)row["pid"]!=pid || (int)row["parentPid"]!=parent ||
       !String.Equals((string)row["name"],name,StringComparison.OrdinalIgnoreCase) ||
       (string)row["nativeBirthStamp"]!=birth.ToString(CultureInfo.InvariantCulture) ||
       (canonical!=null && (string)row["createdAt"]!=canonical) || !(bool)row["liveAtCaptureEnd"] ||
       (uint)row["nativeWaitResult"]!=258) throw new InvalidOperationException("SPI_SELECTED_HELD_BINDING_MISMATCH");
  }
  static List<Dictionary<string,object>> CompareSelected(List<Dictionary<string,object>> processes,List<Retained> retained,uint[] before) {
    if(retained.Count!=2 || before.Length!=2) throw new InvalidOperationException("SPI_SELECTED_HELD_COUNT_INVALID");
    List<Dictionary<string,object>> comparisons=new List<Dictionary<string,object>>();
    for(int index=0;index<retained.Count;index++) {
      Retained item=retained[index]; Dictionary<string,object> held=item.row;
      Dictionary<string,object> row=processes.Find(delegate(Dictionary<string,object> value) { return (int)value["pid"]==(int)item.pid; });
      uint after=(uint)held["nativeWaitResult"];
      if(before[index]!=258 || after!=258 || row==null || (string)row["nativeIdentityStatus"]!="SNAPSHOT_ONLY_BIRTH_PARENT_NAME_OBSERVATION" ||
         (string)row["nativeBirthStamp"]!=(string)held["nativeBirthStamp"] || (string)row["createdAt"]!=(string)held["createdAt"] ||
         (int)row["parentPid"]!=(int)held["parentPid"] || !String.Equals((string)row["name"],(string)held["name"],StringComparison.OrdinalIgnoreCase))
        throw new InvalidOperationException("SPI_SELECTED_SNAPSHOT_MISMATCH");
      comparisons.Add(new Dictionary<string,object> { {"pid",held["pid"]},{"parentPid",held["parentPid"]},{"name",held["name"]},
        {"createdAt",held["createdAt"]},{"nativeBirthStamp",held["nativeBirthStamp"]},
        {"nativeWaitResultBefore",before[index]},{"nativeWaitResultAfter",after},
        {"sameHandleLiveAtBothBoundaries",true},{"snapshotMatchesHeld",true} });
    }
    return comparisons;
  }
  static void Listeners(int port, uint family, List<Dictionary<string,object>> rows, Stopwatch watch, int budgetMs) {
    const int capacity = 4 * 1024 * 1024;
    IntPtr buffer = Marshal.AllocHGlobal(capacity);
    try {
      Remaining(watch, budgetMs); uint bytes = capacity;
      uint result = GetExtendedTcpTable(buffer, ref bytes, false, family, 3, 0);
      if (result != 0 || bytes < 4 || bytes > capacity) throw new InvalidOperationException("NATIVE_TCP_TABLE_FAILED");
      uint count = unchecked((uint)Marshal.ReadInt32(buffer)); int rowSize = family == 2 ? 24 : 56;
      if (count > (bytes - 4) / rowSize) throw new InvalidOperationException("NATIVE_TCP_TABLE_BOUNDS_INVALID");
      for (uint index = 0; index < count; index++) {
        Remaining(watch, budgetMs); IntPtr row = IntPtr.Add(buffer, checked(4 + (int)index * rowSize));
        uint state = unchecked((uint)Marshal.ReadInt32(row, family == 2 ? 0 : 48));
        uint rawPort = unchecked((uint)Marshal.ReadInt32(row, family == 2 ? 8 : 20));
        uint pid = unchecked((uint)Marshal.ReadInt32(row, family == 2 ? 20 : 52));
        if (state != 2 || pid == 0 || pid > Int32.MaxValue) throw new InvalidOperationException("NATIVE_TCP_ROW_INVALID");
        int localPort = (int)(((rawPort & 255) << 8) | ((rawPort >> 8) & 255));
        if (localPort == port) rows.Add(new Dictionary<string,object> {
          {"port", port}, {"pid", (int)pid}, {"state", "LISTEN"}, {"family", family == 2 ? "IPv4" : "IPv6"}
        });
      }
      Remaining(watch, budgetMs);
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static Dictionary<string,object> Capture(int port, int budgetMs) {
    if (port < 1 || port > 65535 || budgetMs < 1 || budgetMs > 15000) throw new InvalidOperationException("NATIVE_QUERY_INPUT_INVALID");
    Stopwatch watch = Stopwatch.StartNew();
    List<Retained> retained=new List<Retained>();
    Exception primaryFailure=null;
    try {
      ProviderBinding binding=providerBinding;
      if(binding==null) throw new InvalidOperationException("SPI_PROVIDER_BINDING_UNAVAILABLE");
      Dictionary<string,object> self=Held((uint)binding.selfPid,false,retained), wrapper=Held((uint)binding.wrapperPid,false,retained);
      Revalidate(retained,watch,budgetMs);
      VerifyHeldBinding(self,binding.selfPid,binding.selfParent,binding.selfName,binding.selfBirth,binding.selfCanonicalBirth);
      VerifyHeldBinding(wrapper,binding.wrapperPid,binding.wrapperParent,binding.wrapperName,binding.wrapperBirth,binding.wrapperCanonicalBirth);
      uint[] before=new uint[] { (uint)self["nativeWaitResult"], (uint)wrapper["nativeWaitResult"] };
      Dictionary<string,object> coverage;
      List<Dictionary<string,object>> processes=Processes(watch,budgetMs,out coverage), ports=new List<Dictionary<string,object>>();
      Listeners(port, 2, ports, watch, budgetMs); Listeners(port, 23, ports, watch, budgetMs);
      // Only the two independently bound roots are held. Inventory birth/name/
      // parent are observations from one complete SPI buffer, not held-object
      // liveness/exit/kill proofs. Fresh termination fences are unchanged.
      Revalidate(retained, watch, budgetMs); Remaining(watch, budgetMs);
      VerifyHeldBinding(self,binding.selfPid,binding.selfParent,binding.selfName,binding.selfBirth,binding.selfCanonicalBirth);
      VerifyHeldBinding(wrapper,binding.wrapperPid,binding.wrapperParent,binding.wrapperName,binding.wrapperBirth,binding.wrapperCanonicalBirth);
      List<Dictionary<string,object>> comparisons=CompareSelected(processes,retained,before); Remaining(watch,budgetMs);
      return new Dictionary<string,object> { {"processes", processes}, {"ports", ports},
        {"providerElapsedMs", watch.Elapsed.TotalMilliseconds}, {"nativeProvider", "SPI_SNAPSHOT_HELD_ROOTS_IPHELPER_WMI_FREE"},
        {"spiCoverage",coverage},{"heldComparisons",comparisons},{"publicAbiGuarantee","NOT_GUARANTEED"},
        {"tcpFamiliesComplete", new string[] { "IPv4", "IPv6" }} };
    } catch(Exception error) { primaryFailure=error; throw; }
    finally { CloseAllPreservingPrimary(retained,primaryFailure); }
  }
}
