export interface TestOnlyRecoveryEvidence {
  schemaVersion: number;
  FINAL_CLASSIFICATION: "TEST_ONLY_RECOVERY_PASS";
  createdAt: string;
  BASE_FULL_RUN: number;
  BASE_FULL_HEAD: string;
  BASE_FULL_FAILURE: string;
  BASE_FULL_SUMMARY_SHA256: string;
  RECOVERY_COMMIT: string;
  RECOVERY_SCOPE: string[];
  RECOVERY_GROUP_RESULT: {
    group: string;
    total: number;
    passed: number;
    status: "PASSED";
  };
}

export const TEST_ONLY_RECOVERY_SCHEMA_VERSION: number;
export const TEST_ONLY_RECOVERY_ARTIFACT: string;
export const TEST_ONLY_RECOVERY_RELATIVE_PATH: string;
export function parseVerifyResult(text: string): Record<string, unknown>;
export function validateBaseFullForRecovery(summary: Record<string, unknown>): {
  group: string;
  files: string[];
};
export function createTestOnlyRecoveryEvidence(input: Record<string, unknown>): TestOnlyRecoveryEvidence;
export function validateTestOnlyRecoveryEvidence(
  evidence: TestOnlyRecoveryEvidence,
  current: { currentHead: string; changedFiles: string[] },
): { valid: boolean; reasons: string[]; evidence: TestOnlyRecoveryEvidence };
