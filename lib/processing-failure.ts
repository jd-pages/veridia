export const processingFailureTaskStatuses = [
  "FAILED",
  "READ_FAILED",
  "LOGIN_EXPIRED",
] as const;

export type ProcessingFailureStatus =
  (typeof processingFailureTaskStatuses)[number];

// Configuration failures are terminal task diagnostics, not page-reading
// outcomes. They must never be backfilled into formal audit results.
export const processingFailureResultExcludedCodes = ["CONFIG_ERROR"] as const;

export function pageStatusForProcessingFailure(code: string | null) {
  if (["NOTE_NOT_FOUND", "PAGE_NOT_FOUND", "NOTE_DELETED"].includes(code || "")) {
    return "NOTE_NOT_FOUND";
  }
  if (code === "NO_PERMISSION") return "NO_PERMISSION";
  if (code === "LOGIN_EXPIRED" || code === "LOGIN_REQUIRED") {
    return "LOGIN_EXPIRED";
  }
  if (code === "SECURITY_CHECK" || code === "SECURITY_VERIFICATION") {
    return "SECURITY_VERIFICATION";
  }
  return "READ_FAILED";
}

export function processingFailureReason(
  code: string | null,
  message: string | null,
  platform: "XIAOHONGSHU" | "DOUYIN" = "XIAOHONGSHU",
) {
  if (
    ["NOTE_NOT_FOUND", "PAGE_NOT_FOUND", "NOTE_DELETED"].includes(code || "") &&
    message?.trim()
  ) {
    return message.trim();
  }
  if (
    code === "STRUCTURE_MISMATCH" &&
    message &&
    /没有提取到标题或正文|未提取到标题或正文/u.test(message)
  ) {
    return "页面结构异常，未提取到标题或正文，请人工确认。";
  }
  const platformName = platform === "DOUYIN" ? "抖音" : "小红书";
  const contentName = platform === "DOUYIN" ? "作品" : "笔记";
  const pageName = platform === "DOUYIN" ? "抖音作品页面" : "小红书页面";
  const reasons: Record<string, string> = {
    NOTE_NOT_FOUND: "笔记不存在",
    PAGE_NOT_FOUND: "当前笔记无法浏览：页面不存在，需人工确认",
    NOTE_DELETED: "当前笔记无法浏览：笔记已删除，需人工确认",
    NO_PERMISSION: "当前笔记无法浏览：无权限访问，需人工确认",
    LOGIN_EXPIRED: `${platformName}登录状态失效，需重新登录后人工确认`,
    LOGIN_REQUIRED: `${platformName}需要登录，需重新登录后人工确认`,
    SECURITY_CHECK: "页面进入安全验证，需人工确认",
    SECURITY_VERIFICATION: "页面进入安全验证，需人工确认",
    REDIRECT_FAILED: `短链接未跳转到${platformName}${contentName}详情页，请人工复核。`,
    LOAD_TIMEOUT: `${pageName}打开超时，需人工确认`,
    STRUCTURE_MISMATCH: "页面主体结构异常，需人工确认",
    NETWORK_ERROR: `${pageName}打开失败，需人工确认`,
    PLATFORM_ROUTING_MISMATCH: "自动审核平台路由不一致，任务已停止，需检查系统配置",
    PAGE_READ_FAILED: "页面访问异常，需人工确认",
    BODY_NOT_RECOGNIZED: "笔记主体内容缺失，需人工复核",
    TOPICS_NOT_RECOGNIZED: "未识别到话题内容，需人工复核",
  };
  if (code && reasons[code]) return reasons[code];
  if (message?.trim()) return `${message.trim()}，需人工确认`;
  return "抓取过程异常，需人工确认";
}
