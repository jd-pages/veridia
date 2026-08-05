import { describe, expect, it } from "vitest";
import {
  formatAuditTime,
  parseResultPlatform,
  resultPlatformLabel,
} from "@/lib/result-source";

describe("审核结果来源信息", () => {
  it("使用可扩展的平台枚举和中文展示名称", () => {
    expect(parseResultPlatform("小红书")).toBe("XIAOHONGSHU");
    expect(parseResultPlatform("DOUYIN")).toBe("DOUYIN");
    expect(parseResultPlatform("unknown")).toBeNull();
    expect(resultPlatformLabel("XIAOHONGSHU")).toBe("小红书");
    expect(resultPlatformLabel("DOUYIN")).toBe("抖音");
    expect(resultPlatformLabel(null)).toBe("—");
  });

  it("实际审核时间按月日时分展示且无效值安全回退", () => {
    const value = new Date(2026, 7, 5, 16, 42).toISOString();
    expect(formatAuditTime(value)).toBe("08月05日 16:42");
    expect(formatAuditTime(null)).toBe("—");
    expect(formatAuditTime("not-a-date")).toBe("—");
  });
});
