import { describe, expect, it } from "vitest";
import {
  commercePlatformLabel,
  contentChannelLabel,
  formatAuditTime,
  parseCommercePlatform,
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
    expect(parseCommercePlatform("京东")).toBe("JD");
    expect(parseCommercePlatform("DOUYIN_ECOMMERCE")).toBe(
      "DOUYIN_ECOMMERCE",
    );
    expect(commercePlatformLabel("TMALL")).toBe("天猫");
    expect(contentChannelLabel("XIAOHONGSHU")).toBe("小红书");
  });

  it("实际审核时间固定按上海时区完整展示且无效值安全回退", () => {
    const value = "2026-08-05T08:42:19.000Z";
    expect(formatAuditTime(value)).toBe("2026-08-05 16:42:19");
    expect(formatAuditTime(null)).toBe("—");
    expect(formatAuditTime("not-a-date")).toBe("—");
  });
});
