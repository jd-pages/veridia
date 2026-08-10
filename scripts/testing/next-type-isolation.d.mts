export interface FileSnapshot {
  existed: boolean;
  content: Buffer | null;
}

export function captureFile(file: string): FileSnapshot;
export function restoreFile(file: string, snapshot: FileSnapshot): void;
export function cleanupTestNextGeneratedTypes(
  root: string,
  nextDistDir: string,
): string[];
export function cleanupKnownTestNextGeneratedTypes(root?: string): string[];
export function formalNextTypesNeedGeneration(root?: string): boolean;
export function e2eTsconfigPath(root?: string): string;
