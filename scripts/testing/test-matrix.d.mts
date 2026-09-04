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
  unitFiles: string[];
  unitRelatedFiles: string[];
  infrastructureUnitFiles: string[];
  unitSelectionReasons: string[];
  reasons: string[];
  infrastructureChanged: boolean;
  minimumMode: string;
  conservativeFallback: boolean;
  workers: number;
  protectedBehaviorKeys: string[];
  protectedGroups: string[];
  protectedUnitTests: string[];
  protectedReasons: string[];
  risk: ChangeRisk;
}

export interface ChangeRisk {
  level: "TEST_ONLY" | "LOW" | "MEDIUM" | "HIGH";
  changedFiles: string[];
  highRiskKinds: string[];
  reasons: string[];
  productionChanged: boolean;
}

export const TEST_CATEGORIES: readonly TestCategory[];
export const CHANGE_RISK_LEVELS: Readonly<Record<string, ChangeRisk["level"]>>;
export const E2E_MANIFEST: Readonly<Record<string, E2eMetadata>>;
export const INFRASTRUCTURE_UNIT_ALLOWLIST: readonly string[];
export const AFFECTED_INFRASTRUCTURE_UNIT_LIMIT: number;
export function isTestOnlyChangePath(file: string): boolean;
export function classifyChangeRisk(changedFiles: string[]): ChangeRisk;
export function assertAffectedInfrastructureUnitSelection(
  unitFiles: string[],
  changedFiles: string[],
  limit?: number,
): string[];
export function listFormalE2eFiles(root?: string): string[];
export function validateManifest(root?: string): string[];
export function selectTestScope(changedFiles: string[], mode?: string): TestSelection;
export function e2eFilesForGroup(groupName: string): string[];
export function groupE2eFiles(files: string[]): Array<{ name: string; files: string[]; workers: number }>;
