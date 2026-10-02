export interface RuntimeProcess { pid: number; parentPid: number; name: string; createdAt: string; workingSetBytes?: number; nativeBirthStamp?: string; }
export interface RuntimeSnapshot { processes: RuntimeProcess[]; ports: { port: number; pid: number; state: string }[]; }
export function redactE2eDiagnosticText(value: unknown, secrets?: string[]): string;
export function redactE2eDiagnosticValue(value: unknown, secrets?: string[]): unknown;
export function parseRepeatEach(args: string[]): number;
export function normalizeUniqueFormalCaseEvidence(cases: { file: string; title: string; status: "PASSED" | "FAILED" | "NOT_RUN" }[]): { file: string; title: string; status: "PASSED" | "FAILED" | "NOT_RUN" }[];
export function summarizeRepeatedExecutions(report: unknown, selectedTotal: number): {
  total: number; executed: number; passed: number; failed: number; notRun: number; retryCount: number;
  cases: { file: string; title: string; project?: string; reportSpecId: string | null; reportExecutionOrdinal: number;
    repeatEachIndex: number | null; repeatIndexSource: "REPORT_FIELD" | "NOT_SERIALIZED" | "INVALID_REPORT_FIELD";
    timeoutMs: number | null; status: string; durationMs: number; retryCount: number;
    attempts: { status: string; durationMs: number | null; retry: number | null; startTime: string | null; workerIndex: number | null; parallelIndex: number | null }[] }[];
};
export function selectOwnedProcessTree(processes: RuntimeProcess[], rootPid: number): RuntimeProcess[];
export function extendOwnedProcessIdentities(processes: (RuntimeProcess | import("./runtime-observation-provider-client.mjs").NativeRuntimeProcess)[], captured: RuntimeProcess[]): RuntimeProcess[];
export interface RuntimeObservation { status: "PASSED" | "FAILED" | "NOT_RUN"; sampleCount: number; intervalMs: number; maxGapMs: number; elapsedMs: number; coverage: "SAMPLED_NOT_EXHAUSTIVE"; error?: string; }
export function startRuntimeObservation(input: { capture: () => RuntimeSnapshot; record: (runtime: RuntimeSnapshot) => void; intervalMs?: number; now?: () => number }): { stop(): RuntimeObservation };
export interface WorkerRuntimeObservation extends RuntimeObservation {
  state: string; runId: string; observerId: string; coalescedTicks: number;
  workerJoined: boolean; workerExitCode: number | null; stopDeadlineMs: number | null; stopAcknowledged: boolean;
  nativeProviderJoin: import("./runtime-observation-provider-client.mjs").ProviderObservation | null; receipts: Record<string, unknown>[];
  firstOwnershipFailureDiagnostic?: { runId: string; observerId: string; sequence: number; workerThreadId: number;
    queryStartedAt: string; queryEndedAt: string; receivedMs: number; diagnostic: OwnershipFailureDiagnostic };
}
export interface OwnershipDiagnosticIdentity { pid: number | null; parentPid: number | null; name: string; createdAt: string | null;
  createdAtMeasurement: "VALID" | "NULL" | "INVALID_OR_MISSING"; nativeBirthStamp: string | null;
  nativeIdentityStatus: string; parentIdentityProof: string; liveAtCaptureEnd: boolean | null;
  nativeIdentityFailure: { code: string; operation: string; win32Error: number | null; ntStatus: number | null } | null; }
export interface OwnershipFailureDiagnostic { schemaVersion: 1;
  kind: "CAPTURED_PID_IDENTITY_UNAVAILABLE" | "LIVE_PARENT_CHILD_IDENTITY_UNAVAILABLE"; ownershipGranted: false;
  parentSelection: "CURRENT_SNAPSHOT_CANDIDATE_PARENT" | "SNAPSHOT_BIRTH_MATCHED_OBSERVED_PARENT";
  capturedRootIdentity: OwnershipDiagnosticIdentity | null;
  candidate: OwnershipDiagnosticIdentity; parent: OwnershipDiagnosticIdentity | null;
  capturedCandidateIdentityCount: number | null; capturedCandidateIdentities: OwnershipDiagnosticIdentity[];
  capturedParentIdentityCount: number | null; capturedParentIdentities: OwnershipDiagnosticIdentity[]; identityHistoryTruncated: boolean; }
export type WorkerRuntimeSnapshot = import("./runtime-observation-provider-client.mjs").NativeRuntimeSnapshot;
export function startWindowsRuntimeObservation(input: { port: number; runId: string; wrapperIdentity: RuntimeProcess; record: (runtime: WorkerRuntimeSnapshot) => void },
  dependencies?: { createWorker?: (data: Record<string, unknown>) => import("node:worker_threads").Worker; now?: () => number; timeOrigin?: number }): {
    ready: Promise<void>; snapshot(): WorkerRuntimeObservation; stop(deadlineMs: number): Promise<WorkerRuntimeObservation>;
  };
export function waitForOwnedProcessQuiescence(input: { identities: RuntimeProcess[]; capture: (remainingMs: number) => RuntimeSnapshot | Promise<RuntimeSnapshot>;
  requirePortClosed?: boolean; deadlineMs?: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<{
    status: "PASSED"; runtime: RuntimeSnapshot; observations: number; elapsedMs: number; deadlineMs: number; ownedProcessCount: 0;
  }>;
export function validateInitialOwnedRoot(actual: RuntimeProcess | undefined, fence: { pid: number; parentPid: number; name: string; expectedCreatedAt?: string; earliestCreationMs?: number; latestCreationMs?: number } | undefined): boolean;
export function selectNewOwnedBrowserRoot(before: RuntimeProcess[], after: RuntimeProcess[], parentPid: number): RuntimeProcess;
export function closeWithinDeadline(close: () => Promise<unknown>, timeoutMs?: number): Promise<void>;
export function evaluateGenerationIdleSnapshot(runtime: unknown, sessions: unknown, health: unknown): {
  idle: boolean; counts: Record<string, number>; physicalCloseState: string | null; physicalCloseFencePresent: boolean;
  platformBrowserManagers: Record<string, unknown>; activeBrowserOwnerGenerations: number[]; ownerState: string;
  isolatedDatabaseResponsive: boolean; health: unknown;
  prismaTransactionCheck: { status: "PASSED" | "PENDING"; measurement: "AVAILABLE";
    coverageScope: "APP_LIB_SINGLETON_EXPLICIT_TRANSACTIONS"; pendingTransactionCount: number;
    observedTransactionCount: number; settledTransactionCount: number; observedBatchTransactionCount: number;
    observedInteractiveTransactionCount: number; observedOtherTransactionCount: number; singletonRegistered: true; wrapperIntact: true };
};
export function captureWindowsRuntime(port: number, execute?: (...args: unknown[]) => unknown, timeoutMs?: number): RuntimeSnapshot;
export interface UnknownRuntimeProcess { pid: number; parentPid: number; name: string; createdAt: string | null;
  scopeReason: "UNSCOPED_OPAQUE_NAMED_CANDIDATE" | "UNVERIFIED_HISTORICAL_PARENT_CANDIDATE" | "PROJECT_OR_RUN_PROFILE_MATCH" | "DIAGNOSTIC_COLLECTOR_DIRECT_CHILD_CANDIDATE" | "RUN_PORT_LISTENER" | "CURRENT_CAPTURED_ANCESTRY_MATCH"; }
export interface DiagnosticCollectorIdentity extends RuntimeProcess {
  nativeCreationFileTime: string; callerIdentity: RuntimeProcess; callerNativeCreationFileTime: string;
  identityVerified: true; directCallerVerified: true; queryStartedAt: string; queryEndedAt: string;
  queryStartedFileTime: string; queryEndedFileTime: string;
  birthPrecision: "CIM_MICROSECOND_MATCH_NATIVE_FILETIME_FLOOR10";
  ownershipGranted: false; terminationAuthorized: false;
}
export function validRuntimeObservationQueryDeadline(sentMs: number, deadlineMs: number): boolean;
export interface DiagnosticCollectorCandidate extends Omit<RuntimeProcess, "createdAt"> {
  createdAt: string | null;
  nativeCreationFileTime: string | null; nativeBirthVerified: boolean; scopeKnownNonProjectProfile: boolean;
}
export interface HistoricalParentDiagnosticIdentity {
  pid: number; parentPid: number; name: string; createdAt: string | null; nativeBirthStamp: string | null;
}
export interface HistoricalParentFailureDiagnostics {
  schemaVersion: 1; status: "RECORDED" | "NOT_MEASURED" | "NOT_APPLICABLE";
  reason: "VALIDATED_SAME_SNAPSHOT_OBSERVATION_ONLY" | "MALFORMED_OR_UNBOUND_DIAGNOSTIC_NOT_TRUSTED" | "NO_REMAINING_HISTORICAL_PARENT_UNKNOWN";
  scope: "SAME_CIM_SNAPSHOT_HISTORICAL_PARENT_OBSERVATION_ONLY"; candidateLimit: 16;
  boundScope: "RAW_PRE_EXCLUSION_CANDIDATES"; remainingUnknownCandidateCount: number;
  unobservedRemainingUnknownCandidateCount: number; queryStartedAt?: string; queryEndedAt?: string;
  rawCandidateCount?: number; rawCandidatesTruncated?: boolean;
  rejection?: { code: "ENVELOPE_CONTRACT" | "RECORD_KEYS_CANDIDATE_IDENTITY_OR_BINDING" | "PARENT_ARRAY_COUNT_OR_OBSERVATION" |
    "PARENT_IDENTITY_BINDING_OR_ORDER" | "CAPTURED_PARENT_IDENTITY"; recordIndex: number | null };
  observationCapture?: { status: "UNVALIDATED_SAME_SNAPSHOT_CAPTURE"; candidateLimit: 16; parentRowLimit: 4;
    candidateTotal: number | null; candidateTruncated: boolean | null; queryStartedAt: string | null; queryEndedAt: string | null;
    recordCount: number; recordsTruncated: boolean; records: { candidate: { pid: number | null; parentPid: number | null;
      name: string | null; createdAt: string | null; unexpectedKeys: boolean }; currentParentRowCount: number | null;
      currentParentRowsTruncated: boolean | null; parentObservation: string | null;
      currentParentRows: { pid: number | null; parentPid: number | null; name: string | null; createdAt: string | null; unexpectedKeys: boolean }[];
      unexpectedKeys: boolean }[]; ownershipGranted: false; terminationAuthorized: false };
  ownershipGranted: false; terminationAuthorized: false; originalUnknownClassificationChanged: false;
  records: { candidate: HistoricalParentDiagnosticIdentity;
    parentObservation: "ABSENT_IN_THIS_SNAPSHOT" | "ONE_ROW_IN_THIS_SNAPSHOT" | "MULTIPLE_ROWS_IN_THIS_SNAPSHOT";
    currentParentRowCount: number; currentParentRowsTruncated: boolean; currentParentRows: HistoricalParentDiagnosticIdentity[];
    capturedParentIdentityCount: number; capturedParentIdentitiesTruncated: boolean; capturedParentIdentities: HistoricalParentDiagnosticIdentity[];
    ownershipGranted: false; terminationAuthorized: false; originalUnknownClassificationChanged: false }[];
}
export function captureWindowsScopedResiduals(input: { projectRoot: string; profilePaths: string[]; identities: RuntimeProcess[]; wrapperIdentity: RuntimeProcess; timeoutMs?: number; identityForensics?: boolean; ports?: number[]; portListeners?: { pid: number; port: number }[] }, execute?: (...args: unknown[]) => unknown): {
  ownedProcesses: RuntimeProcess[]; unknownProcesses: UnknownRuntimeProcess[]; opaqueUnscopedCandidates: UnknownRuntimeProcess[];
  rawUnknownProcesses: UnknownRuntimeProcess[];
  historicalParentReferences: (RuntimeProcess & { classification: "HISTORICAL_PARENT_REFERENCE_WITHOUT_PROJECT_AFFINITY"; ownershipGranted: false; terminationAuthorized: false })[];
  diagnosticCollector: DiagnosticCollectorIdentity; diagnosticCollectorCandidates: DiagnosticCollectorCandidate[];
  diagnosticCollectorObservation: "OBSERVED" | "NOT_OBSERVED";
  historicalParentFailureDiagnostics: HistoricalParentFailureDiagnostics;
  excludedReusedHistoricalParentCandidates: (UnknownRuntimeProcess & { exclusion: "CURRENT_NATIVE_PARENT_INCARNATION_PRECEDES_CHILD_BIRTH";
    evidence: unknown; capturedParentIdentities: unknown[];
    timeOrderingAssumption: "UTC_PROCESS_CREATION_ORDER_SAME_AS_EXISTING_CHILD_BEFORE_PARENT_GUARD";
    ownershipGranted: false; terminationAuthorized: false })[];
  excludedDiagnosticCollectorCandidates: (UnknownRuntimeProcess & { exclusion: "DIAGNOSTIC_COLLECTOR_DIRECT_CHILD_OBSERVATION_ONLY";
    collectorIdentity: DiagnosticCollectorIdentity; nativeCreationFileTime: string; ownershipGranted: false; terminationAuthorized: false })[];
  excludedHistoricalParentCandidates: (UnknownRuntimeProcess & { exclusion: "CHILD_BIRTH_PRECEDES_ALL_CAPTURED_PARENT_INCARNATIONS";
    capturedParentIdentities: Pick<RuntimeProcess, "pid" | "parentPid" | "createdAt">[]; ownershipGranted: false; terminationAuthorized: false })[];
  opaqueUnscopedCandidateCount: number; wrapperIdentityVerified: true; scope: string; scopeLimitations: string[];
};
export function matchingOwnedProcesses(processes: RuntimeProcess[], identities: RuntimeProcess[]): RuntimeProcess[];
export function planWindowsTreeTermination(processes: RuntimeProcess[], identities: RuntimeProcess[], rootPid: number): number[];
export function orderOwnedProcessesLeafFirst(identities: RuntimeProcess[], wrapperPid?: number): RuntimeProcess[];
export function terminateWindowsOwnedProcesses(identities: RuntimeProcess[], execute?: (...args: unknown[]) => unknown, timeoutMs?: number): { terminatedPids: number[]; exitedPids: number[] };
export function readServerSnapshots(directory: string): unknown[];
export function exportFailureDiagnostics(input: { runDirectory: string; outputDirectory: string; metadata: Record<string, unknown>; runtime: unknown; secrets?: string[] }): void;
