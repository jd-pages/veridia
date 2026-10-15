// Kernel Job proof is an alternative scope proof, never process ownership or
// exit/kill authority. Legacy snapshots still use the unchanged strict guards.
const stamp = value => typeof value === "string" && /^[1-9]\d{16,17}$/u.test(value) ? BigInt(value) : null;
const keys = (value, expected) => value && typeof value === "object" && !Array.isArray(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const ticks = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.slice(0, 23) + "Z"
  ? BigInt(Date.parse(value)) * 10000n + 116444736000000000n + BigInt(value.slice(23, 27)) : null;
const frameKeys = ["schemaVersion", "scopeId", "proof", "pid", "nativeBirthStamp", "assignedAtFileTime", "queryStartedFileTime",
  "queryEndedFileTime", "priorOuterJobPresent", "limitFlags", "inventoryComplete", "selfHeldLive", "selfKernelMembershipVerified",
  "memberPids", "ownershipGranted", "terminationAuthorized"];
const rowKeys = ["pid", "parentPid", "name", "createdAt", "nativeBirthStamp", "workingSetBytes", "nativeIdentityStatus",
  "parentIdentityProof", "liveAtCaptureEnd", "ownershipAuthority"];
function nativeRow(row) {
  const birth = stamp(row?.nativeBirthStamp), canonical = ticks(row?.createdAt);
  return keys(row, rowKeys) && Number.isSafeInteger(row.pid) && row.pid > 0 && row.pid <= 2147483647 &&
    Number.isSafeInteger(row.parentPid) && row.parentPid >= 0 && row.parentPid <= 2147483647 &&
    typeof row.name === "string" && /^[\p{L}\p{N}_. ()\[\]-]{1,260}$/u.test(row.name) &&
    birth !== null && canonical !== null && birth / 10n === canonical / 10n &&
    Number.isSafeInteger(row.workingSetBytes) && row.workingSetBytes >= 0 &&
    row.nativeIdentityStatus === "SNAPSHOT_ONLY_BIRTH_PARENT_NAME_OBSERVATION" &&
    row.parentIdentityProof === "SPI_SNAPSHOT_BIRTH_PARENT_NAME_OBSERVATION_ONLY" &&
    row.liveAtCaptureEnd === null && row.ownershipAuthority === false;
}
export function validateCollectorJobProof(proof, collector) {
  if (proof === undefined) return null; // Original receipts cannot acquire retroactive proof.
  const fail = () => { throw new Error("E2E_COLLECTOR_KERNEL_JOB_PROOF_INVALID"); };
  if (!keys(proof, ["schemaVersion", "before", "after", "jobHandleClosed", "spiCoverage", "nativeCollectorObservation"]) ||
    proof.schemaVersion !== 1 || proof.jobHandleClosed !== true) return fail();
  const c = stamp(collector.nativeCreationFileTime), start = stamp(collector.queryStartedFileTime), end = stamp(collector.queryEndedFileTime);
  if (c === null || start === null || end === null) return fail();
  for (const frame of [proof.before, proof.after]) {
    const assigned = stamp(frame?.assignedAtFileTime), a = stamp(frame?.queryStartedFileTime), b = stamp(frame?.queryEndedFileTime);
    if (!keys(frame, frameKeys) || frame.schemaVersion !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(frame.scopeId) ||
      frame.proof !== "PRIVATE_KERNEL_JOB_SELF_BOUND_NO_BREAKAWAY" || frame.pid !== collector.pid || stamp(frame.nativeBirthStamp) !== c ||
      assigned === null || a === null || b === null || c > assigned || assigned > a || start > a || a > b || b > end ||
      typeof frame.priorOuterJobPresent !== "boolean" || frame.limitFlags !== 0 || frame.inventoryComplete !== true ||
      frame.selfHeldLive !== true || frame.selfKernelMembershipVerified !== true || frame.ownershipGranted !== false || frame.terminationAuthorized !== false ||
      // This collector executes no child workload. Any extra Job member is an
      // unresolved descendant, not something this negative proof may ignore.
      !Array.isArray(frame.memberPids) || frame.memberPids.length !== 1 ||
      frame.memberPids.some(pid => !Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) ||
      new Set(frame.memberPids).size !== frame.memberPids.length || !frame.memberPids.includes(collector.pid)) return fail();
  }
  const before = proof.before, after = proof.after, coverage = proof.spiCoverage;
  const completed = stamp(coverage?.snapshotCompletedUtcFileTime);
  if (before.scopeId !== after.scopeId || before.assignedAtFileTime !== after.assignedAtFileTime ||
    before.priorOuterJobPresent !== after.priorOuterJobPresent ||
    JSON.stringify([...before.memberPids].sort((a,b)=>a-b)) !== JSON.stringify([...after.memberPids].sort((a,b)=>a-b)) ||
    !keys(coverage, ["osBuild", "architecture", "layoutProfile", "queryStatus", "returnLength", "bufferCapacity", "inventoryComplete", "snapshotCompletedUtcFileTime", "clockSource"]) ||
    ![26100,26200].includes(coverage.osBuild) || coverage.architecture !== "AMD64" ||
    coverage.layoutProfile !== "SPI_X64_PREFIX256_THREAD80_CREATE32_IMAGE56_PID80_PARENT88" ||
    coverage.queryStatus !== 0 || coverage.bufferCapacity !== 8388608 || !Number.isSafeInteger(coverage.returnLength) ||
    coverage.returnLength < 256 || coverage.returnLength > coverage.bufferCapacity || coverage.inventoryComplete !== true ||
    coverage.clockSource !== "GET_SYSTEM_TIME_PRECISE_AS_FILE_TIME" || completed === null ||
    stamp(before.queryEndedFileTime) > completed || completed > stamp(after.queryStartedFileTime) ||
    !nativeRow(proof.nativeCollectorObservation) || proof.nativeCollectorObservation.pid !== collector.pid ||
    proof.nativeCollectorObservation.parentPid !== collector.parentPid ||
    proof.nativeCollectorObservation.name.toLowerCase() !== collector.name.toLowerCase() ||
    proof.nativeCollectorObservation.createdAt !== collector.createdAt || stamp(proof.nativeCollectorObservation.nativeBirthStamp) !== c) return fail();
  return { ...proof, status: "PASSED", ownershipGranted: false, terminationAuthorized: false };
}
export function collectorJobDisprovesParentEdge(proof, row, candidate, rawRows) {
  if (!proof || row.scopeReason !== "DIAGNOSTIC_COLLECTOR_DIRECT_CHILD_CANDIDATE" ||
    row.parentPid !== proof.before.pid || /^(?:node|chrome|chromium|headless_shell|chrome-headless-shell|electron|VERIDIA)\.exe$/iu.test(row.name) ||
    candidate?.sameSnapshotUniqueRow !== true || candidate.parentPid !== row.parentPid || candidate.name !== row.name || candidate.createdAt !== row.createdAt ||
    rawRows.filter(other => ["pid","parentPid","name","createdAt"].every(key=>other[key]===row[key])).length !== 1 ||
    proof.before.memberPids.includes(row.pid) || proof.after.memberPids.includes(row.pid)) return false;
  const observed = candidate.nativeSnapshotObservation;
  if (!nativeRow(observed) || ["pid","parentPid","name","createdAt"].some(key => observed[key] !== row[key])) return false;
  const birth = stamp(observed.nativeBirthStamp), rootBirth = stamp(proof.before.nativeBirthStamp);
  // Covers even pre-Job startup children: a child born at/after the collector
  // cannot use this narrow negative proof. Snapshot observation is not liveness.
  return birth !== null && rootBirth !== null && birth < rootBirth &&
    birth <= stamp(proof.spiCoverage.snapshotCompletedUtcFileTime);
}
