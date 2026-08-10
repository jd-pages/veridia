export class SoftwarePublishError extends Error {
  constructor(
    code: string,
    message: string,
    options?: { cause?: unknown; stage?: string },
  );
  code: string;
  stage?: string;
}

export function formatSoftwarePublishFailure(
  error: unknown,
  logPath: string,
): string[];

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
  latestTagVersion: string;
  targetTagExists: boolean;
  targetReleaseExists: boolean;
}

export interface SoftwarePublishPlan {
  kind: "none" | "release";
  currentVersion: string;
  sourceVersion: string;
  targetVersion?: string;
  versionChangeRequired?: boolean;
  ahead: number;
  behind: number;
  commitsToPush: string[];
  commitsSinceRelease: string[];
}

export function parseReleaseVersion(value: string): number[];
export function compareReleaseVersions(left: string, right: string): number;
export function nextPatchVersion(value: string): string;
export function createSoftwarePublishPlan(
  input: SoftwarePublishPlanInput,
): SoftwarePublishPlan;
export function executeSoftwarePublishPlan(
  plan: SoftwarePublishPlan,
  options: {
    dryRun: boolean;
    operations: {
      updateVersion(plan: SoftwarePublishPlan): unknown;
      validate(plan: SoftwarePublishPlan): unknown;
      commitVersion(plan: SoftwarePublishPlan): unknown;
      restoreVersion(plan: SoftwarePublishPlan): unknown;
      pushMain(plan: SoftwarePublishPlan): unknown;
      assertMainSynchronized(plan: SoftwarePublishPlan): unknown;
      assertTargetAvailable(plan: SoftwarePublishPlan): unknown;
      createTag(plan: SoftwarePublishPlan): unknown;
      pushTag(plan: SoftwarePublishPlan): unknown;
      waitForActions(plan: SoftwarePublishPlan): unknown;
      verifyRelease(plan: SoftwarePublishPlan, actions: unknown): unknown;
    };
  },
): Promise<Record<string, unknown>>;
