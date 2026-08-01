export const processingFailureTaskStatuses = [
  "FAILED",
  "READ_FAILED",
  "LOGIN_EXPIRED",
] as const;

export type ProcessingFailureStatus =
  (typeof processingFailureTaskStatuses)[number];

export function pageStatusForProcessingFailure(code: string | null) {
  if (code === "PAGE_NOT_FOUND") return "NOT_FOUND";
  if (code === "NOTE_DELETED") return "DELETED";
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
) {
  if (
    code === "STRUCTURE_MISMATCH" &&
    message &&
    /没有提取到标题或正文|未提取到标题或正文/u.test(message)
  ) {
    return "页面结构异常，未提取到标题或正文，请人工确认。";
  }
  const reasons: Record<string, string> = {
    PAGE_NOT_FOUND: "当前笔记无法浏览：页面不存在，需人工确认",
    NOTE_DELETED: "当前笔记无法浏览：笔记已删除，需人工确认",
    NO_PERMISSION: "当前笔记无法浏览：无权限访问，需人工确认",
    LOGIN_EXPIRED: "小红书登录状态失效，需重新登录后人工确认",
    LOGIN_REQUIRED: "小红书需要登录，需重新登录后人工确认",
    SECURITY_CHECK: "页面进入安全验证，需人工确认",
    SECURITY_VERIFICATION: "页面进入安全验证，需人工确认",
    REDIRECT_FAILED: "短链接未跳转到小红书笔记详情页，请人工复核。",
    LOAD_TIMEOUT: "小红书页面打开超时，需人工确认",
    STRUCTURE_MISMATCH: "页面主体结构异常，需人工确认",
    NETWORK_ERROR: "小红书页面打开失败，需人工确认",
    PAGE_READ_FAILED: "页面访问异常，需人工确认",
    BODY_NOT_RECOGNIZED: "笔记主体内容缺失，需人工复核",
    TOPICS_NOT_RECOGNIZED: "未识别到话题内容，需人工复核",
  };
  if (code && reasons[code]) return reasons[code];
  if (message?.trim()) return `${message.trim()}，需人工确认`;
  return "抓取过程异常，需人工确认";
}
