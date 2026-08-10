import type { AuditTask } from "@prisma/client";
import { AutomaticExtractionError } from "./failure";

export const automationPlatforms = ["XIAOHONGSHU", "DOUYIN"] as const;
export type AutomationPlatform = (typeof automationPlatforms)[number];

export const automationPlatformLabels: Record<AutomationPlatform, string> = {
  XIAOHONGSHU: "小红书",
  DOUYIN: "抖音",
};

export function parseAutomationPlatform(value: unknown): AutomationPlatform | null {
  const normalized = String(value || "").trim().toUpperCase();
  if (["XIAOHONGSHU", "XHS", "小红书"].includes(normalized)) {
    return "XIAOHONGSHU";
  }
  if (["DOUYIN", "抖音"].includes(normalized)) return "DOUYIN";
  return null;
}

export function platformFromUrl(value: string): AutomationPlatform | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      host === "douyin.com" ||
      host.endsWith(".douyin.com") ||
      host === "iesdouyin.com" ||
      host.endsWith(".iesdouyin.com") ||
      (["localhost", "127.0.0.1"].includes(host) &&
        url.pathname.startsWith("/mock/douyin"))
    ) {
      return "DOUYIN";
    }
    if (
      host === "xiaohongshu.com" ||
      host.endsWith(".xiaohongshu.com") ||
      host === "xhslink.com" ||
      host.endsWith(".xhslink.com") ||
      host === "xhslink.cn" ||
      host.endsWith(".xhslink.cn") ||
      (["localhost", "127.0.0.1"].includes(host) && url.pathname === "/mock/xhs")
    ) {
      return "XIAOHONGSHU";
    }
  } catch {
    // Invalid URLs are handled by the link parser.
  }
  return null;
}

export function resolveTaskAutomationPlatform(
  task: Pick<AuditTask, "channel" | "platform" | "url">,
): AutomationPlatform | null {
  return (
    parseAutomationPlatform(task.channel) ||
    parseAutomationPlatform(task.platform) ||
    platformFromUrl(task.url)
  );
}

export function automationSessionId(platform: AutomationPlatform) {
  return platform === "XIAOHONGSHU" ? "xiaohongshu" : "douyin";
}

export function automationProfileEnvironmentKey(platform: AutomationPlatform) {
  return platform === "XIAOHONGSHU" ? "XHS_PROFILE_PATH" : "DOUYIN_PROFILE_PATH";
}

export type PlatformRoutingDescriptor = {
  taskPlatform: AutomationPlatform | null;
  activePlatform: AutomationPlatform;
  browserPlatform: AutomationPlatform;
  adapterPlatform: AutomationPlatform;
  classifierPlatform: AutomationPlatform;
};

export function assertPlatformRouting(
  descriptor: PlatformRoutingDescriptor,
) {
  const values = [
    descriptor.taskPlatform,
    descriptor.activePlatform,
    descriptor.browserPlatform,
    descriptor.adapterPlatform,
    descriptor.classifierPlatform,
  ];
  if (values.every((value) => value === descriptor.activePlatform)) return;
  throw new AutomaticExtractionError(
    "PLATFORM_ROUTING_MISMATCH",
    "自动审核平台路由不一致，任务已停止，未执行页面读取。",
    {
      taskPlatform: descriptor.taskPlatform,
      activePlatform: descriptor.activePlatform,
      browserPlatform: descriptor.browserPlatform,
      adapterPlatform: descriptor.adapterPlatform,
      classifierPlatform: descriptor.classifierPlatform,
    },
  );
}
