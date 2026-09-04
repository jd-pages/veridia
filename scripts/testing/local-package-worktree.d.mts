import type { FileSnapshot } from "./next-type-isolation.mjs";

export const LOCAL_PACKAGE_RESTORE_FILES: readonly string[];

export function captureLocalPackageFiles(
  root: string,
): Map<string, FileSnapshot>;
export function restoreLocalPackageFiles(
  snapshots: ReadonlyMap<string, FileSnapshot>,
): void;
export function withLocalPackageFileRestore<T>(
  root: string,
  action: () => T | Promise<T>,
): Promise<T>;
export function createLocalPackageAcceptance(options: {
  version: string;
  acceptedAt: string;
  commitSha: string;
  sourceFingerprint: string;
  fullGate: {
    source: "LOCAL_ATTESTATION" | "GITHUB_RELEASE_FULL" | "TEST_ONLY_RECOVERY";
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
  };
  artifacts: Array<{
    name: string;
    size: number;
    sha256: string;
    sha512: string;
  }>;
}): Record<string, unknown>;
export function writeLocalPackageAcceptance(options: {
  acceptancePath: string;
  acceptance: Record<string, unknown>;
  worktreeStatus: string;
}): void;
