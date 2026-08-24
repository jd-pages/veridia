import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateProtectedBehaviorEvidence,
  readPlaywrightCaseEvidence,
} from "../../scripts/testing/protected-evidence.mjs";

describe("Protected behavior case evidence", () => {
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
