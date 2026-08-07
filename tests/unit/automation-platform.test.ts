import { describe, expect, it } from "vitest";
import { automationSessionId, parseAutomationPlatform, platformFromUrl, resolveTaskAutomationPlatform } from "@/lib/automation/platform";

describe("自动审核平台注册", () => {
  it("优先使用任务渠道并为两个平台分配不同会话", () => {
    expect(resolveTaskAutomationPlatform({ channel: "DOUYIN", platform: "XIAOHONGSHU", url: "https://www.xiaohongshu.com/explore/1" })).toBe("DOUYIN");
    expect(automationSessionId("XIAOHONGSHU")).not.toBe(automationSessionId("DOUYIN"));
  });

  it("可从受支持域名推断平台", () => {
    expect(platformFromUrl("https://www.douyin.com/video/1")).toBe("DOUYIN");
    expect(platformFromUrl("https://www.xiaohongshu.com/explore/1")).toBe("XIAOHONGSHU");
    expect(parseAutomationPlatform("抖音")).toBe("DOUYIN");
  });
});
