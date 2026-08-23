export const PACKAGE_FULL_GATE_SOURCES: Readonly<{
  LOCAL_ATTESTATION: "LOCAL_ATTESTATION";
  GITHUB_MAIN_CI: "GITHUB_MAIN_CI";
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
    steps?: Array<{
      name?: string;
      status?: string;
      conclusion?: string;
    }>;
  }>;
}

export interface PackageFullGateCredential {
  source: "LOCAL_ATTESTATION" | "GITHUB_MAIN_CI";
  commitSha: string;
  sourceFingerprint: string;
  attestationGeneratedAt?: string;
  mainCiRunId?: number;
  mainCiCommitSha?: string;
  mainCiConclusion?: string;
  mainCiUrl?: string;
}

export function collectPackageRepositoryState(
  root: string,
  git?: (root: string, args: string[]) => string,
): PackageRepositoryState;
export function assertPackageRepositoryState(
  state: PackageRepositoryState,
): void;
export function selectExactHeadMainCiRun(
  runs: MainCiRun[],
  head: string,
): MainCiRun;
export function validateExactHeadMainCiDetails(
  run: MainCiRun,
  head: string,
): MainCiRun;
export function resolvePackageFullGate(options?: {
  root?: string;
  git?: (root: string, args: string[]) => string;
  validateLocalAttestation?: (root: string) => {
    valid: boolean;
    reasons?: string[];
    attestation?: { generatedAt?: string };
  };
  collectCurrentState?: (root: string) => { sourceFingerprint: string };
  listMainCiRuns?: (root: string) => MainCiRun[];
  viewMainCiRun?: (root: string, runId: number) => MainCiRun;
}): PackageFullGateCredential;
