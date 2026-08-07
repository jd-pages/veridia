import type { AuditTask } from "@prisma/client";

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
        url.pathname === "/mock/douyin")
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
