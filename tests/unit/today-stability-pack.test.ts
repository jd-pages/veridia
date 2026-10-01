import { describe, expect, it } from "vitest";
import { actualE2eSummary, sanitizeStabilityOutput, stabilityPackSelection, TODAY_STABILITY_REGRESSION_PACK } from "../../scripts/testing/today-stability-pack.mjs";
import { E2E_MANIFEST } from "../../scripts/testing/test-matrix.mjs";

describe("Today stability regression pack", () => {
  it("preserves failure evidence without leaking bearer values or session cookies", () => {
    const safe = sanitizeStabilityOutput("read ECONNRESET\n  - authorization: Bearer private-bearer\n  - cookie: veridia_local_session=private-session\n  - set-cookie: session=private-response\nfixture-env-secret", ["fixture-env-secret"]);
    for (const secret of ["private-bearer", "private-session", "private-response", "fixture-env-secret"]) expect(safe).not.toContain(secret);
    expect(safe).toContain("read ECONNRESET");
  });
  it("keeps incident categories, frozen business sentinels and the four build handoff protections", () => {
    expect(TODAY_STABILITY_REGRESSION_PACK.map((entry) => entry.key)).toEqual(expect.arrayContaining([
      "BATCH_CREATION", "IMPORT_PREVIEW_TABLE_SCOPE", "RULE_MONTH_SELECTION", "DASHBOARD_LOCAL_MONTH_SCOPE", "PRISMA_TRANSACTION_QUIESCENCE", "PAUSE_CONTINUE_RUNNER_HANDOFF", "QUEUE_PAUSED_A07", "HISTORICAL_EXTRACTION_IMMUTABLE",
      "PERSISTENT_CONTEXT_CLOSE", "BROWSER_CLEANUP_DEADLINE", "GENERATION_LIFECYCLE", "SERVER_HEALTH_BATCH_POST",
      "CRLF_PORTABILITY", "VITEST_HIGH_DURATION", "FROZEN_KABRITA_OCTOBER_CONTRACT", "FROZEN_PRODUCT_CAMPAIGN_MEMBERSHIP",
      "FORMAL_BUILD_FILE_LOCK_STABILITY", "POST_E2E_PROCESS_QUIESCENCE", "NEXT_DIST_ISOLATION", "NEXT_TYPEGEN_PROCESS_CLEANUP",
    ]));
    expect(TODAY_STABILITY_REGRESSION_PACK).toHaveLength(22);
    expect(new Set(TODAY_STABILITY_REGRESSION_PACK.map(entry => entry.key)).size).toBe(22);
    expect(TODAY_STABILITY_REGRESSION_PACK.find(entry => entry.key === "FORMAL_BUILD_FILE_LOCK_STABILITY")?.unit)
      .toEqual(["tests/unit/next-trace-single-flight.test.ts", "tests/unit/build-lock-diagnostics.test.ts"]);
    for (const key of ["FORMAL_BUILD_FILE_LOCK_STABILITY", "POST_E2E_PROCESS_QUIESCENCE", "NEXT_DIST_ISOLATION", "NEXT_TYPEGEN_PROCESS_CLEANUP"]) {
      const entry = TODAY_STABILITY_REGRESSION_PACK.find(item => item.key === key);
      expect(entry?.unit.length).toBeGreaterThan(0);
    }
    expect(TODAY_STABILITY_REGRESSION_PACK.find((entry) => entry.key === "IMPORT_PREVIEW_TABLE_SCOPE")?.e2e).toEqual([
      "tests/e2e/audit-flow.spec.ts",
      "tests/e2e/import-preflight-layout.spec.ts",
    ]);
    expect(TODAY_STABILITY_REGRESSION_PACK.find((entry) => entry.key === "RULE_MONTH_SELECTION")?.e2e).toEqual([
      "tests/e2e/product-stage-topic.spec.ts",
      "tests/e2e/rule-brand-navigation.spec.ts",
    ]);
    expect(TODAY_STABILITY_REGRESSION_PACK.find((entry) => entry.key === "PRISMA_TRANSACTION_QUIESCENCE")?.unit).toEqual([
      "tests/unit/prisma-transaction-diagnostics.test.ts",
    ]);
    expect(TODAY_STABILITY_REGRESSION_PACK.find((entry) => entry.key === "DASHBOARD_LOCAL_MONTH_SCOPE")).toMatchObject({
      unit: ["tests/unit/dashboard-calendar-month.test.ts", "tests/unit/dashboard-risk-summary-ui.test.ts"],
      e2e: ["tests/e2e/dashboard-risk-summary.spec.ts"],
    });
  });
  it("uses real existing files and official singleton worker contracts without retry", () => {
    const selection = stabilityPackSelection();
    expect(selection.retries).toBe(0);
    expect(selection.e2eGroups.length).toBeGreaterThan(0);
    for (const group of selection.e2eGroups) {
      const parallel = group.files.every((file) => E2E_MANIFEST[file].parallelSafe);
      expect(group.workers).toBe(parallel ? 2 : 1);
    }
  });
  it("rejects missing or incomplete fail-fast machine evidence even when process is green", () => {
    expect(actualE2eSummary("process exited zero")).toBeNull();
    expect(actualE2eSummary('VERIDIA_E2E_RESULT={"total":42,"executed":22,"passed":21,"failed":1,"notRun":20}')?.passedAll).toBe(false);
    expect(actualE2eSummary('VERIDIA_E2E_RESULT={"total":42,"executed":41,"passed":41,"failed":0,"notRun":1}')?.passedAll).toBe(false);
    expect(actualE2eSummary('VERIDIA_E2E_RESULT={"total":42,"executed":42,"passed":42,"failed":0,"notRun":0}')?.passedAll).toBe(false);
    expect(actualE2eSummary('VERIDIA_E2E_RESULT={"total":1,"executed":1,"passed":1,"failed":0,"notRun":0,"executionSummary":{"total":2,"passed":2,"failed":0,"notRun":0,"retryCount":1}}')?.passedAll).toBe(false);
    expect(actualE2eSummary('VERIDIA_E2E_RESULT={"total":1,"executed":1,"passed":1,"failed":0,"notRun":0,"executionSummary":{"total":2,"passed":1,"failed":0,"notRun":1,"retryCount":0}}')?.passedAll).toBe(false);
    const formal = { total: 1, executed: 1, passed: 1, failed: 0, notRun: 0 };
    const complete = { total: 2, executed: 2, passed: 2, failed: 0, notRun: 0, retryCount: 0 };
    const accepted = (executionSummary: unknown) => actualE2eSummary(`VERIDIA_E2E_RESULT=${JSON.stringify({ ...formal, executionSummary })}`)?.passedAll;
    expect(accepted(complete)).toBe(true);
    for (const missing of [undefined, null, {}]) expect(accepted(missing)).toBe(false);
    for (const key of Object.keys(complete)) {
      const incomplete: Record<string, unknown> = { ...complete };
      delete incomplete[key];
      expect(accepted(incomplete)).toBe(false);
      for (const invalid of ["2", true, 1.5, -1, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN]) {
        expect(accepted({ ...complete, [key]: invalid })).toBe(false);
      }
    }
    for (const value of ["2", true, 1.5]) {
      expect(accepted({ ...complete, total: value, executed: value, passed: value })).toBe(false);
    }
    expect(accepted({ ...complete, total: 0, executed: 0, passed: 0 })).toBe(false);
    expect(accepted({ ...complete, executed: 1 })).toBe(false);
    expect(accepted({ ...complete, passed: 1 })).toBe(false);
    for (const key of ["failed", "notRun", "retryCount"]) expect(accepted({ ...complete, [key]: 1 })).toBe(false);
  });
});
