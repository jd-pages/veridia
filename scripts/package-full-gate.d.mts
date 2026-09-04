export const PACKAGE_FULL_GATE_SOURCES: Readonly<{
  LOCAL_ATTESTATION: "LOCAL_ATTESTATION";
  GITHUB_RELEASE_FULL: "GITHUB_RELEASE_FULL";
  TEST_ONLY_RECOVERY: "TEST_ONLY_RECOVERY";
}>;

export class PackageFullGateError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
}

export interface PackageRepositoryState {
  branch: string;
  worktreeStatus: string;
  head: string;
  originMain: string;
}

export interface MainCiRun {
  databaseId?: number;
  headSha?: string;
  status?: string;
  conclusion?: string;
  event?: string;
  workflowName?: string;
  createdAt?: string;
  url?: string;
  jobs?: Array<{
    name?: string;
    status?: string;
    conclusion?: string;
    steps?: Array<{ name?: string; status?: string; conclusion?: string }>;
  }>;
}

export interface PackageFullGateCredential {
  source: "LOCAL_ATTESTATION" | "GITHUB_RELEASE_FULL" | "TEST_ONLY_RECOVERY";
  commitSha: string;
  sourceFingerprint: string;
  attestationGeneratedAt?: string;
  releaseFullRunId?: number;
  releaseFullCommitSha?: string;
  releaseFullConclusion?: string;
  releaseFullUrl?: string;
  baseFullRunId?: number;
  baseFullHead?: string;
  recoveryCommit?: string;
  recoveryScope?: string[];
  recoveryGroupResult?: Record<string, unknown>;
  recoveryCiRunId?: number;
  recoveryCiUrl?: string;
}

export function collectPackageRepositoryState(root: string, git?: (root: string, args: string[]) => string): PackageRepositoryState;
export function assertPackageRepositoryState(state: PackageRepositoryState): void;
export function selectExactHeadMainCiRun(runs: MainCiRun[], head: string): MainCiRun;
export function validateExactHeadReleaseFullDetails(run: MainCiRun, head: string): MainCiRun;
export function resolvePackageFullGate(options?: Record<string, unknown>): PackageFullGateCredential;
