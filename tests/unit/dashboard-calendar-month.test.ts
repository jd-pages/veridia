import fs from "node:fs";
import path from "node:path";
import dayjs from "dayjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardLocalMonth } from "@/lib/dashboard-calendar-month";
import { buildLocalDateRange } from "@/lib/result-query";

afterEach(() => vi.unstubAllEnvs());

describe("Dashboard local calendar month", () => {
  it.each([
    ["Asia/Shanghai", "2026-09-30T18:36:06.814Z", "2026-10"],
    ["UTC", "2026-09-30T18:36:06.814Z", "2026-09"],
    ["America/Los_Angeles", "2026-10-01T04:00:00.000Z", "2026-09"],
    ["UTC", "2026-10-01T04:00:00.000Z", "2026-10"],
    ["Asia/Shanghai", "2025-12-31T16:00:00.000Z", "2026-01"],
  ])("uses %s calendar month for %s", (timezone, instant, expected) => {
    vi.stubEnv("TZ", timezone);
    expect(dashboardLocalMonth(new Date(instant))).toBe(expected);
  });

  it("includes the original audit instant in the existing local Results date range", () => {
    vi.stubEnv("TZ", "Asia/Shanghai");
    const auditedAt = new Date("2026-09-30T18:36:06.814Z");
    const month = dashboardLocalMonth(auditedAt);
    const startDate = `${month}-01`;
    const endDate = dayjs(startDate).endOf("month").format("YYYY-MM-DD");
    expect({ month, startDate, endDate }).toEqual({ month: "2026-10", startDate: "2026-10-01", endDate: "2026-10-31" });
    const range = buildLocalDateRange(startDate, endDate);
    expect(auditedAt.getTime()).toBeGreaterThanOrEqual((range.gte as Date).getTime());
    expect(auditedAt.getTime()).toBeLessThanOrEqual((range.lte as Date).getTime());
    const oldRange = buildLocalDateRange("2026-09-01", "2026-09-30");
    expect(auditedAt.getTime()).toBeGreaterThan((oldRange.lte as Date).getTime());
  });

  it("uses the shared local month in both real Dashboard initialization and its E2E probe", () => {
    const dashboard = fs.readFileSync(path.resolve("app/(admin)/dashboard/page.tsx"), "utf8");
    const probe = fs.readFileSync(path.resolve("tests/e2e/dashboard-risk-summary.spec.ts"), "utf8");
    expect(dashboard).toContain("useState(() => dashboardLocalMonth())");
    expect(probe).toContain("const month = dashboardLocalMonth()");
    for (const source of [dashboard, probe]) expect(source).not.toContain("toISOString().slice(0, 7)");
  });
});
