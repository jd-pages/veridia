export interface BuildLockDiagnosticIdentity { pid: number; nativeStartFileTime: string }
export const BUILD_LOCK_READY_STAGES: readonly string[];
export interface ReadyStageObservation { role: string; pid: number; stage: string; utc: string; qpcTicks: string; qpcFrequency: string; observedMonoMs: number; authority: string }
export function createBuildLockReadyObservation(options: { invocationId: string; nonce: string; supportIdentity: string; role: string; pid: number; now: () => number }): {
  push(chunk: unknown): void;
  snapshot(): { measurement: string; truncated: boolean; records: ReadyStageObservation[] };
};
export function projectBuildLockReadyStartupFailure(value: unknown): Record<string, unknown> | null;
export interface BuildLockDiagnosticSession {
  status: "READY" | "NOT_APPLICABLE";
  invocationId: string;
  receiptRelativePath: string;
  environment: NodeJS.ProcessEnv;
}
export interface BuildLockDiagnosticOutcome {
  buildStatus?: number | null;
  buildStartedAt?: string | null;
  buildEndedAt?: string | null;
  buildError?: { name?: string; code?: string } | Error | null;
  monitorIncomplete?: boolean;
}
export interface BuildLockDiagnosticEvidence {
  schemaVersion?: number;
  status: "PASSED" | "DIAGNOSTICS_INCOMPLETE" | "NOT_APPLICABLE";
  invocationId: string | null;
  receiptRelativePath?: string;
  receiptSha256?: string | null;
  diagnosticsFailures: Array<{ name: string; code: string | null; message: string | null }>;
  [key: string]: unknown;
}
export const BUILD_LOCK_DIAGNOSTICS_POLICY: Readonly<{ leaseMs: number; readyMs: number; graceMs: number; finalMs: number; intervalMs: number; maxObservationBytes: number; maxMonitorFiles: number; coverage: string; releaseRemoteExport: "NOT_IMPLEMENTED" }>;
export function redactBuildLockDiagnosticText(value: unknown): string | null;
export function beginBuildLockDiagnostics(options: { root?: string; head: string; sourceFingerprint: string; wrapperPath?: string; environment?: NodeJS.ProcessEnv }): Promise<BuildLockDiagnosticSession>;
export function endBuildLockDiagnostics(session: BuildLockDiagnosticSession, outcome?: BuildLockDiagnosticOutcome): Promise<BuildLockDiagnosticEvidence>;
export function readBuildLockDiagnosticsEvidence(relativeReceiptPath: string, context: { root?: string; head: string; sourceFingerprint: string; startedAt: string; now: string }): {
  evidence: BuildLockDiagnosticEvidence;
  failureMembers: Array<{ source: { relativePath: string; sha256: string; bytes: number }; kind: string; records: Array<Record<string, unknown>> }>;
  source: { relativePath: string; sha256: string; bytes: number };
};
export function createBuildLockDiagnosticsFixtureController(options: {
  platform?: string; io?: typeof import("node:fs"); spawnChild?: typeof import("node:child_process").spawn; monotonic?: () => number;
  fixture: { id: string; mode?: "NORMAL" | "IGNORE_STOP" | "STALL_GUARDIAN_AFTER_PROOF" | "INVALID_QUERY_SESSION"; bootstrapDeadlineMs?: number; policy?: Partial<typeof BUILD_LOCK_DIAGNOSTICS_POLICY> };
}): {
  begin(options: { head: string; sourceFingerprint: string; wrapperPath?: string; environment?: NodeJS.ProcessEnv }): Promise<BuildLockDiagnosticSession>;
  end(session: BuildLockDiagnosticSession, outcome?: BuildLockDiagnosticOutcome): Promise<BuildLockDiagnosticEvidence>;
  terminateOwnedSupervisor(session: BuildLockDiagnosticSession): boolean;
  closeOwnedControl(session: BuildLockDiagnosticSession): void;
};
