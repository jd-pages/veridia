import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateProtectedBehaviorEvidence,
  readPlaywrightCaseEvidence,
  summarizePlaywrightCaseEvidence,
} from "../../scripts/testing/protected-evidence.mjs";

describe("Protected behavior case evidence", () => {
  it("fail-fast 31 selected、1 failed、30 未执行，绝不信任 spec.ok", () => {
    const cases = readPlaywrightCaseEvidence(path.resolve("tests/fixtures/playwright/fail-fast.json"));
    expect(summarizePlaywrightCaseEvidence(cases)).toEqual({ total: 31, executed: 1, passed: 0, failed: 1, notRun: 30 });
    expect(cases[1].status).toBe("NOT_RUN");
    const protectedResult = aggregateProtectedBehaviorEvidence({
      behaviorKeys: ["UNSTARTED"], registryPassed: true, unitEvidence: [], e2eEvidence: cases,
      behaviors: [{ key: "UNSTARTED", unitCases: [], e2eCases: [{ file: cases[1].file, title: cases[1].title }] }],
    });
    expect(protectedResult.status).toBe("FAILED");
    expect(protectedResult.behaviors[0].cases[0].status).toBe("NOT_RUN");
  });

  it("真实 passed、重试终态、skipped、timedOut、interrupted 和多项目未执行均如实判定", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-evidence-status-"));
    try {
      const report = path.join(root, "report.json");
      const attempts = [["passed"], ["failed", "passed"], ["passed", "failed"], ["skipped"], ["timedOut"], ["interrupted"], []];
      fs.writeFileSync(report, JSON.stringify({ suites: [{ specs: [
        ...attempts.map((statuses, index) => ({ file: "status.spec.ts", title: String(index), ok: true, tests: [{ results: statuses.map((status) => ({ status })) }] })),
        { file: "status.spec.ts", title: "mixed", ok: true, tests: [{ results: [{ status: "passed" }] }, { results: [] }] },
      ] }] }));
      const cases = readPlaywrightCaseEvidence(report, root);
      expect(cases.map((item) => item.status)).toEqual(["PASSED", "PASSED", "FAILED", "NOT_RUN", "FAILED", "FAILED", "NOT_RUN", "NOT_RUN"]);
      expect(summarizePlaywrightCaseEvidence([cases[0]])).toEqual({ total: 1, executed: 1, passed: 1, failed: 0, notRun: 0 });
      expect(summarizePlaywrightCaseEvidence([], 31)).toEqual({ total: 31, executed: 0, passed: 0, failed: 0, notRun: 31 });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("同一 spec 的一个 case 失败时只标记绑定该 case 的 behavior", () => {
    const behaviors = [
      {
        key: "PASSED_BEHAVIOR",
        unitCases: [{ file: "tests/unit/shared.test.ts", title: "自己的 Unit" }],
        e2eCases: [{ file: "tests/e2e/shared.spec.ts", title: "已通过场景" }],
      },
      {
        key: "FAILED_BEHAVIOR",
        unitCases: [{ file: "tests/unit/shared.test.ts", title: "自己的 Unit" }],
        e2eCases: [{ file: "tests/e2e/shared.spec.ts", title: "失败场景" }],
      },
    ];
    const result = aggregateProtectedBehaviorEvidence({
      behaviorKeys: behaviors.map((item) => item.key),
      behaviors,
      registryPassed: true,
      unitEvidence: [
        { file: "tests/unit/shared.test.ts", title: "自己的 Unit", status: "PASSED" },
      ],
      e2eEvidence: [
        { file: "tests/e2e/shared.spec.ts", title: "已通过场景", status: "PASSED" },
        { file: "tests/e2e/shared.spec.ts", title: "失败场景", status: "FAILED" },
      ],
    });

    expect(result.status).toBe("FAILED");
    expect(result.behaviors).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "PASSED_BEHAVIOR", status: "PASSED" }),
      expect.objectContaining({ key: "FAILED_BEHAVIOR", status: "FAILED" }),
    ]));
  });

  it("缺失 case evidence 必须失败而不能借用整个测试组结果", () => {
    const result = aggregateProtectedBehaviorEvidence({
      behaviorKeys: ["MISSING"],
      behaviors: [{
        key: "MISSING",
        unitCases: [{ file: "tests/unit/missing.test.ts", title: "必须执行" }],
        e2eCases: [],
      }],
      registryPassed: true,
      unitEvidence: [],
      e2eEvidence: [],
    });
    expect(result.status).toBe("FAILED");
    expect(result.behaviors[0].cases[0].status).toBe("NOT_RUN");
  });

  it("Playwright 相对 testDir 文件名规范化为 tests/e2e case key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "veridia-protected-evidence-"));
    const report = path.join(root, "playwright.json");
    fs.writeFileSync(report, JSON.stringify({
      suites: [{
        file: "runner.spec.ts",
        specs: [{
          file: "runner.spec.ts",
          title: "精确场景",
          ok: true,
          tests: [{ results: [{ status: "passed" }] }],
        }],
      }],
    }));
    expect(readPlaywrightCaseEvidence(report, root)).toEqual([{
      file: "tests/e2e/runner.spec.ts",
      title: "精确场景",
      status: "PASSED",
    }]);
  });
});
