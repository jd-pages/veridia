export const NEXT_TRACE_SINGLE_FLIGHT_PATCH: Readonly<{
  nextVersion: "16.3.4";
  originalSha256: string;
  initializationOnlySha256: string;
  queueSnapshotDrainOnlySha256: string;
  patchedSha256: string;
  relativeTarget: string;
  sourceMapPolicy: "UNMODIFIED_UPSTREAM_MAP_MAY_HAVE_STALE_LINE_MAPPINGS";
}>;
export interface NextTraceTransformResult {
  state: "PATCH_REQUIRED" | "ALREADY_PATCHED";
  changed: boolean;
  version: string;
  inputSha256: string;
  outputSha256: string;
  source: Buffer;
}
export interface NextTracePatchStatus {
  state: "PATCH_REQUIRED" | "ALREADY_PATCHED";
  changed: boolean;
  version: string;
  targetPath: string;
  inputSha256: string;
  outputSha256: string;
  sourceMapPolicy: typeof NEXT_TRACE_SINGLE_FLIGHT_PATCH.sourceMapPolicy;
}
export interface NextTraceApplicationResult {
  state: "APPLIED" | "ALREADY_PATCHED";
  changed: boolean;
  version: string;
  targetPath: string;
  inputSha256: string;
  outputSha256: string;
  backupPath: string | null;
  auditPath?: string;
  sourceMapPolicy: typeof NEXT_TRACE_SINGLE_FLIGHT_PATCH.sourceMapPolicy;
}
export function transformNextTraceSingleFlight(options: { version: string; source: Buffer | Uint8Array | string }): NextTraceTransformResult;
export function readNextTraceSingleFlightStatus(): Promise<NextTracePatchStatus>;
export function assertNextTraceSingleFlight(): Promise<NextTracePatchStatus>;
export function applyNextTraceSingleFlight(): Promise<NextTraceApplicationResult>;
