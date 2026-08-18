export interface SoftwarePublishErrorOptions {
  cause?: unknown;
  stage?: string;
  classification?: string;
  command?: string;
  detailLog?: string;
  target?: string;
  failedItem?: string;
  attempt?: number;
  maxAttempts?: number;
  elapsedMs?: number;
  cacheStatus?: string;
  checkpoint?: string;
  recoveryPoint?: string;
  sideEffects?: boolean;
  versionConsumed?: boolean;
  recovery?: string;
}

export declare class SoftwarePublishError extends Error {
  constructor(code: string, message: string, options?: SoftwarePublishErrorOptions);
  code: string;
  stage?: string;
  classification?: string;
  command?: string;
  detailLog?: string;
  target?: string;
  failedItem?: string;
  attempt?: number;
  maxAttempts?: number;
  elapsedMs?: number;
  cacheStatus?: string;
  checkpoint?: string;
  recoveryPoint?: string;
  sideEffects?: boolean;
  versionConsumed?: boolean;
  recovery?: string;
}

export declare function compareReleaseVersions(left: string, right: string): number;
export declare function parseReleaseVersion(value: string): [number, number, number];
export declare function nextPatchVersion(value: string): string;

export interface ReleaseWorkflowRun {
  databaseId: number;
  headSha: string;
  headBranch: string;
  status: string;
  conclusion: string;
  event: string;
  url?: string;
}

export interface PublishedReleaseState {
  version: string;
  releaseExists: boolean;
  tagExists: boolean;
  tagCommit?: string | null;
  remoteTagCommit?: string | null;
  releaseCommit?: string | null;
}

export interface HistoricalReleaseTagState {
  version: string;
  tagCommit?: string | null;
  remoteTagCommit?: string | null;
  releaseExists: boolean;
  isMainAncestor: boolean;
  workflowRuns: ReleaseWorkflowRun[];
}

export interface FailedReleaseTag {
  version: string;
  tagCommit: string;
  workflowRunId: number;
  workflowConclusion: string;
  workflowUrl?: string;
}

export interface ReleaseHistoryClassification {
  latestPublishedReleaseVersion: string;
  latestHistoricalTagVersion: string;
  failedReleaseTags: FailedReleaseTag[];
}

export interface SoftwarePublishPlanInput {
  dirty: boolean;
  branch: string;
  ahead: number;
  behind: number;
  commitsToPush: string[];
  commitsSinceRelease: string[];
  sourceVersion: string;
  lockVersion: string;
  latestReleaseVersion: string;
  latestPublishedRelease: PublishedReleaseState;
  historicalTags: HistoricalReleaseTagState[];
  targetTagExists?: boolean;
  targetLocalTagExists?: boolean;
  targetRemoteTagExists?: boolean;
  targetTagCommit?: string | null;
  targetReleaseExists?: boolean;
  targetVersionOverride?: string;
  resume?: boolean;
  checkpoint?: string;
}

export interface SoftwarePublishPlan {
  kind: "none" | "release";
  currentVersion: string;
  sourceVersion: string;
  targetVersion?: string;
  versionChangeRequired?: boolean;
  latestPublishedReleaseVersion: string;
  latestHistoricalTagVersion: string;
  failedReleaseTags: FailedReleaseTag[];
  ahead: number;
  behind: number;
  commitsToPush: string[];
  commitsSinceRelease: string[];
  checkpoint?: string;
  buildTimestamp?: string;
  releaseState?: Record<string, unknown>;
}

export interface SoftwarePublishActionsResult {
  success: boolean;
  url?: string;
}

export interface SoftwarePublishOperations {
  preflight?: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  updateVersion: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  validate: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  package?: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  verifyLocalArtifact?: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  commitVersion: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  releaseCommit?: (plan: SoftwarePublishPlan) => string | Promise<string>;
  bindArtifact?: (plan: SoftwarePublishPlan, commit?: string) => unknown | Promise<unknown>;
  restoreVersion: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  pushMain: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  assertMainSynchronized: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  waitForMainCi?: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  assertTargetAvailable: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  createTag: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  pushTag: (plan: SoftwarePublishPlan) => unknown | Promise<unknown>;
  waitForActions: (
    plan: SoftwarePublishPlan,
  ) => SoftwarePublishActionsResult | Promise<SoftwarePublishActionsResult>;
  verifyRelease: (
    plan: SoftwarePublishPlan,
    actions: SoftwarePublishActionsResult,
  ) => unknown | Promise<unknown>;
}

export declare function createSoftwarePublishPlan(
  input: SoftwarePublishPlanInput,
): SoftwarePublishPlan;
export declare function classifyReleaseHistory(input: {
  latestPublishedRelease: PublishedReleaseState;
  historicalTags: HistoricalReleaseTagState[];
  targetVersion: string;
}): ReleaseHistoryClassification;
export declare function executeSoftwarePublishPlan(
  plan: SoftwarePublishPlan,
  options: {
    dryRun: boolean;
    operations: SoftwarePublishOperations;
    session?: Record<string, unknown>;
    onCheckpoint?: (session: Record<string, unknown>) => unknown | Promise<unknown>;
  },
): Promise<{
  dryRun: boolean;
  released: boolean;
  actions?: SoftwarePublishActionsResult;
  release?: unknown;
}>;
export declare function formatSoftwarePublishFailure(
  error: unknown,
  logPath: string,
): string[];
export declare function parseGitPorcelainPaths(value: string | Buffer): string[];
export declare function assertOnlyVersionFiles(
  files: string[],
  allowedFiles?: string[],
): void;
export declare function assertProjectRootConsistency(input: {
  scriptRoot: string;
  resolvedProjectRoot: string;
  gitRoot: string;
  workingDirectory: string;
}): string;
export declare function softwareReleaseSessionPath(root: string, version: string): string;
export declare function readSoftwareReleaseSession(
  root: string,
  version: string,
): Record<string, unknown> | null;
export declare function findActiveSoftwareReleaseSession(
  root: string,
): Record<string, unknown> | null;
export declare function writeSoftwareReleaseSession(
  root: string,
  version: string,
  session: Record<string, unknown>,
): Record<string, unknown>;
export declare function resolveSoftwareReleaseSession(
  root: string,
  plan: SoftwarePublishPlan,
  observed?: Record<string, unknown>,
): Record<string, unknown>;
