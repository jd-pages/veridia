import { describe, expect, it } from "vitest";
import {
  createTestOnlyRecoveryEvidence,
  validateBaseFullForRecovery,
  validateTestOnlyRecoveryEvidence,
} from "../../scripts/testing/test-only-recovery.mjs";
import { e2eFilesForGroup } from "../../scripts/testing/test-matrix.mjs";

const BASE_HEAD = "a".repeat(40);
const RECOVERY_HEAD = "b".repeat(40);

function baseSummary(overrides: Record<string, unknown> = {}) {
  return {
    mode: "FULL",
    passed: false,
    failures: ["E2E RESULTS_UI"],
    timings: [{ name: "E2E RESULTS_UI", passed: false }],
    lint: "PASSED",
    typecheck: "PASSED",
    protectedRegression: "PASSED",
    unitTests: { passed: 1097, total: 1097 },
    e2eTotal: 76,
    e2ePassed: 74,
    productionBuild: "PASSED",
    standaloneRuntime: "PASSED",
    sqliteFreshMigration: "PASSED",
    sqliteLegacyUpgrade: "PASSED",
    postgresValidate: "PASSED",
    sensitiveScan: "PASSED",
    gitDiffCheck: "PASSED",
    ...overrides,
  };
}

function recoverySummary(overrides: Record<string, unknown> = {}) {
  const files = e2eFilesForGroup("RESULTS_UI");
  return {
    mode: "AFFECTED",
    passed: true,
    lint: "PASSED",
    typecheck: "PASSED",
    gitDiffCheck: "PASSED",
    recoveryGroup: "RESULTS_UI",
    selectedE2eFiles: files,
    e2eGroups: [{ name: "RESULTS_UI", files, total: 20, passed: 20, status: "PASSED" }],
    ...overrides,
  };
}

function evidence() {
  return createTestOnlyRecoveryEvidence({
    baseFullRun: 33470209932,
    baseFullHead: BASE_HEAD,
    baseFullSummary: baseSummary(),
    recoveryCommit: RECOVERY_HEAD,
    changedFiles: ["tests/e2e/results-workbench.spec.ts"],
    recoverySummary: recoverySummary(),
    createdAt: "2026-09-04T00:00:00.000Z",
  });
}

describe("TEST_ONLY_RECOVERY 证据链", () => {
  it("仅一个 E2E group 失败且其余 FULL 门禁通过时允许建立恢复证据", () => {
    expect(validateBaseFullForRecovery(baseSummary())).toMatchObject({ group: "RESULTS_UI" });
    const value = evidence();
    expect(value).toMatchObject({
      FINAL_CLASSIFICATION: "TEST_ONLY_RECOVERY_PASS",
      BASE_FULL_RUN: 33470209932,
      BASE_FULL_HEAD: BASE_HEAD,
      RECOVERY_COMMIT: RECOVERY_HEAD,
      RECOVERY_SCOPE: ["tests/e2e/results-workbench.spec.ts"],
      RECOVERY_GROUP_RESULT: { group: "RESULTS_UI", total: 20, passed: 20, status: "PASSED" },
    });
    expect(validateTestOnlyRecoveryEvidence(value, {
      currentHead: RECOVERY_HEAD,
      changedFiles: ["tests/e2e/results-workbench.spec.ts"],
    }).valid).toBe(true);
  });

  it("存在生产文件变化时 recovery 自动失效", () => {
    expect(validateTestOnlyRecoveryEvidence(evidence(), {
      currentHead: RECOVERY_HEAD,
      changedFiles: ["tests/e2e/results-workbench.spec.ts", "lib/audit-service.ts"],
    }).valid).toBe(false);
  });

  it("Base FULL 有额外失败门禁时拒绝恢复", () => {
    expect(() => validateBaseFullForRecovery(baseSummary({
      failures: ["E2E RESULTS_UI", "Production build"],
    }))).toThrow("只有一个失败门禁");
  });

  it("失败 E2E group 未完整重跑时拒绝生成 PASS", () => {
    expect(() => createTestOnlyRecoveryEvidence({
      baseFullRun: 33470209932,
      baseFullHead: BASE_HEAD,
      baseFullSummary: baseSummary(),
      recoveryCommit: RECOVERY_HEAD,
      changedFiles: ["tests/e2e/results-workbench.spec.ts"],
      recoverySummary: recoverySummary({ selectedE2eFiles: ["tests/e2e/results-workbench.spec.ts"] }),
    })).toThrow("未完整重跑失败组");
  });
});
