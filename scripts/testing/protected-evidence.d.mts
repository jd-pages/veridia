export type ProtectedCaseStatus = "PASSED" | "FAILED" | "NOT_RUN";
export interface ProtectedCaseEvidence {
  file: string;
  title: string;
  status: ProtectedCaseStatus;
}
export function protectedCaseKey(file: string, title: string, root?: string): string;
export function readVitestCaseEvidence(reportFile: string, root?: string): ProtectedCaseEvidence[];
export function readPlaywrightCaseEvidence(reportFile: string, root?: string): ProtectedCaseEvidence[];
export function aggregateProtectedBehaviorEvidence(input: {
  root?: string;
  behaviorKeys: string[];
  behaviors: readonly Array<{ key: string; unitCases?: readonly Omit<ProtectedCaseEvidence, "status">[]; e2eCases?: readonly Omit<ProtectedCaseEvidence, "status">[] }>;
  unitEvidence: ProtectedCaseEvidence[];
  e2eEvidence: ProtectedCaseEvidence[];
  registryPassed: boolean;
}): { status: "PASSED" | "FAILED" | "NOT_APPLICABLE"; behaviors: Array<{ key: string; status: "PASSED" | "FAILED"; cases: ProtectedCaseEvidence[] }> };
