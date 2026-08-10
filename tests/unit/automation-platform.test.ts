import { describe, expect, it } from "vitest";
import {
  assertPlatformRouting,
  automationSessionId,
  parseAutomationPlatform,
  platformFromUrl,
  resolveTaskAutomationPlatform,
} from "@/lib/automation/platform";

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

  it.each(["DOUYIN", "XIAOHONGSHU"] as const)(
    "%s 的 Browser、Adapter 与 Classifier 必须全部同平台",
    (platform) => {
      expect(() => assertPlatformRouting({
        taskPlatform: platform,
        activePlatform: platform,
        browserPlatform: platform,
        adapterPlatform: platform,
        classifierPlatform: platform,
      })).not.toThrow();
    },
  );

  it.each([
    ["browserPlatform", "XIAOHONGSHU"],
    ["adapterPlatform", "XIAOHONGSHU"],
    ["classifierPlatform", "XIAOHONGSHU"],
    ["taskPlatform", "XIAOHONGSHU"],
  ] as const)("抖音任务混用 %s 时立即拒绝", (key, value) => {
    const descriptor = {
      taskPlatform: "DOUYIN",
      activePlatform: "DOUYIN",
      browserPlatform: "DOUYIN",
      adapterPlatform: "DOUYIN",
      classifierPlatform: "DOUYIN",
      [key]: value,
    } as const;
    expect(() => assertPlatformRouting(descriptor)).toThrowError(
      expect.objectContaining({ code: "PLATFORM_ROUTING_MISMATCH" }),
    );
  });
});
