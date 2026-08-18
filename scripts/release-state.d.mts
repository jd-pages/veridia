export type ReleaseStatusType =
  | "PUBLISHED_RELEASE"
  | "FAILED_RELEASE_TAG"
  | "IN_PROGRESS_RELEASE"
  | "TARGET_VERSION"
  | "UNPUBLISHED_SOURCE"
  | "UNKNOWN_ORPHAN_TAG"
  | "INVALID_RELEASE_STATE";

export type ReleaseCheckpoint =
  | "PLAN_READY"
  | "PREFLIGHT_PASS"
  | "FULL_PASS"
  | "LOCAL_PACKAGE_VERIFIED"
  | "RELEASE_COMMIT_CREATED"
  | "MAIN_PUSHED"
  | "LOCAL_TAG_CREATED"
  | "REMOTE_TAG_PUSHED"
  | "GITHUB_ACTIONS_SUCCESS"
  | "GITHUB_RELEASE_CREATED"
  | "REMOTE_ASSETS_VERIFIED"
  | "RELEASE_COMPLETE";

export declare const RELEASE_STATE_SCHEMA_VERSION: number;
export declare const RELEASE_STATUS_TYPES: readonly ReleaseStatusType[];
export declare const RELEASE_CHECKPOINTS: readonly ReleaseCheckpoint[];
export declare function checkpointLabel(checkpoint: ReleaseCheckpoint): string;
export declare function isCheckpointAtLeast(
  checkpoint: ReleaseCheckpoint,
  expected: ReleaseCheckpoint,
): boolean;
export declare function advanceReleaseCheckpoint<T extends Record<string, unknown>>(
  session: T,
  checkpoint: ReleaseCheckpoint,
  patch?: Record<string, unknown>,
): T & { checkpoint: ReleaseCheckpoint; schemaVersion: number; updatedAt: string };
export declare function classifyReleaseTagHistory(
  input: Record<string, unknown>,
): Record<string, unknown>;
export declare function createReleaseState(
  input: Record<string, unknown>,
): Record<string, unknown>;
export declare function determineReleaseRecovery(
  state: Record<string, unknown>,
  checkpoint?: ReleaseCheckpoint,
): { recoveryPoint: string; versionConsumed: boolean };
export declare function validateResumeSession(
  session: Record<string, unknown> | null,
  state: Record<string, unknown>,
  sourceFingerprint: string,
): { valid: boolean; reasons: string[] };
