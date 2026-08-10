export type TestCategory =
  | "AUTH" | "ADMIN" | "XHS" | "DOUYIN" | "AUTOMATION" | "IMPORT"
  | "RESULTS" | "RECHECK" | "STORE_TOPIC" | "RULES" | "CAMPAIGN"
  | "MIXED_PLATFORM" | "UPDATE" | "RELEASE" | "DATABASE" | "UI_LAYOUT";

export interface E2eMetadata {
  categories: TestCategory[];
  isolationGroup: string;
  parallelSafe: boolean;
}

export interface TestSelection {
  changedFiles: string[];
  categories: TestCategory[];
  e2eFiles: string[];
  reasons: string[];
  infrastructureChanged: boolean;
  minimumMode: string;
  conservativeFallback: boolean;
  workers: number;
}

export const TEST_CATEGORIES: readonly TestCategory[];
export const E2E_MANIFEST: Readonly<Record<string, E2eMetadata>>;
export const CROSS_MODULE_E2E: readonly string[];
export function listFormalE2eFiles(root?: string): string[];
export function validateManifest(root?: string): string[];
export function selectTestScope(changedFiles: string[], mode?: string): TestSelection;
export function groupE2eFiles(files: string[]): Array<{ name: string; files: string[]; workers: number }>;
