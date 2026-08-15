import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withHeavyAuditReadSlot } from "@/lib/audit-read-concurrency";
import { summarizeDashboardStatusGroups } from "@/lib/dashboard-summary";
import { summarizeResultStatusGroups } from "@/lib/result-summary";

afterEach(() => vi.unstubAllEnvs());

describe("Dashboard / Results 聚合语义", () => {
  it("一次 Dashboard 状态分组保留全部既有计数口径", () => {
    expect(summarizeDashboardStatusGroups([
      {
        autoStatus: "PASSED",
        topicsCompliant: true,
        clickableCompliant: false,
        _count: { _all: 4 },
      },
      {
        autoStatus: "FAILED",
        topicsCompliant: false,
        clickableCompliant: true,
        _count: { _all: 3 },
      },
      {
        autoStatus: "NEEDS_REVIEW",
        topicsCompliant: true,
        clickableCompliant: true,
        _count: { _all: 2 },
      },
      {
        autoStatus: "READ_FAILED",
        topicsCompliant: false,
        clickableCompliant: false,
        _count: { _all: 1 },
      },
    ])).toEqual({
      total: 10,
      passed: 4,
      failed: 3,
      needsReview: 2,
      readFailed: 1,
      topicMissing: 4,
      clickableAbnormal: 5,
    });
  });

  it("Results summary 排除存储态 not-found 并保留 task fallback 重叠语义", () => {
    expect(summarizeResultStatusGroups([
      { autoStatus: "PASSED", pageStatus: "NORMAL", _count: { _all: 7 } },
      { autoStatus: "PASSED", pageStatus: "DELETED", _count: { _all: 2 } },
      { autoStatus: "FAILED", pageStatus: "NORMAL", _count: { _all: 5 } },
      { autoStatus: "NOTE_NOT_FOUND", pageStatus: "NORMAL", _count: { _all: 3 } },
      { autoStatus: "NEEDS_REVIEW", pageStatus: "NORMAL", _count: { _all: 4 } },
      { autoStatus: "READ_FAILED", pageStatus: "NORMAL", _count: { _all: 1 } },
    ], 2)).toEqual({
      total: 22,
      passed: 7,
      failed: 5,
      notFound: 7,
      review: 4,
      statusCounts: {
        ALL: 22,
        PASSED: 7,
        FAILED: 5,
        NOTE_NOT_FOUND: 7,
        NEEDS_REVIEW: 4,
        READ_FAILED: 1,
      },
    });
  });
});

describe("SQLite 重读取背压", () => {
  it("SQLite 串行执行 Dashboard / Results 重读取", async () => {
    vi.stubEnv("DATABASE_URL", "file:performance.db");
    let active = 0;
    let maximum = 0;
    await Promise.all(Array.from({ length: 4 }, () =>
      withHeavyAuditReadSlot(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    ));
    expect(maximum).toBe(1);
  });

  it("PostgreSQL 不套用 SQLite 串行限制", async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://localhost/veridia");
    let active = 0;
    let maximum = 0;
    await Promise.all(Array.from({ length: 3 }, () =>
      withHeavyAuditReadSlot(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      }),
    ));
    expect(maximum).toBe(3);
  });
});

describe("Results 请求合并与竞态保护", () => {
  const page = fs.readFileSync(
    path.resolve(process.cwd(), "app/(admin)/results/page.tsx"),
    "utf8",
  );

  it("只使用主 Results response 的 summary", () => {
    expect(page).toContain("setSummary(resultData.summary)");
    expect(page).not.toContain("loadSummary");
    expect(page).not.toContain("Promise.all([\n      apiFetch<ResultPageData>");
  });

  it("旧筛选请求不能覆盖最后一次请求", () => {
    expect(page).toContain("const loadRequestRef = useRef(0)");
    expect(page).toContain("const requestId = ++loadRequestRef.current");
    expect(page).toContain("if (requestId !== loadRequestRef.current) return");
  });
});
