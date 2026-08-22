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
export function writeLocalPackageAcceptance(options: {
  acceptancePath: string;
  acceptance: Record<string, unknown>;
  worktreeStatus: string;
}): void;
