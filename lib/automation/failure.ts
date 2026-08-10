export type AutomaticFailureCode =
  | "NOTE_NOT_FOUND"
  | "NO_PERMISSION"
  | "LOGIN_EXPIRED"
  | "LOGIN_REQUIRED"
  | "LOAD_TIMEOUT"
  | "STRUCTURE_MISMATCH"
  | "SECURITY_VERIFICATION"
  | "SECURITY_CHECK"
  | "REDIRECT_FAILED"
  | "NETWORK_ERROR"
  | "PAGE_READ_FAILED"
  | "BODY_NOT_RECOGNIZED"
  | "TOPICS_NOT_RECOGNIZED"
  | "BROWSER_CONTROL_ERROR"
  | "PLATFORM_ROUTING_MISMATCH"
  | "CANCELLED";

export const automaticFailureLabels: Record<AutomaticFailureCode, string> = {
  NOTE_NOT_FOUND: "笔记不存在",
  NO_PERMISSION: "无权限访问",
  LOGIN_EXPIRED: "小红书登录失效",
  LOGIN_REQUIRED: "需要重新登录小红书",
  LOAD_TIMEOUT: "页面加载超时",
  STRUCTURE_MISMATCH: "页面结构不匹配",
  SECURITY_VERIFICATION: "遇到验证码或安全验证",
  SECURITY_CHECK: "遇到安全验证",
  REDIRECT_FAILED: "短链接未跳转到笔记详情页",
  NETWORK_ERROR: "网络错误",
  PAGE_READ_FAILED: "页面读取失败",
  BODY_NOT_RECOGNIZED: "未识别到正文",
  TOPICS_NOT_RECOGNIZED: "未识别到话题",
  BROWSER_CONTROL_ERROR: "审核浏览器控制连接异常",
  PLATFORM_ROUTING_MISMATCH: "自动审核平台路由不一致",
  CANCELLED: "任务已取消",
};

export class AutomaticExtractionError extends Error {
  constructor(
    public readonly code: AutomaticFailureCode,
    message = automaticFailureLabels[code],
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AutomaticExtractionError";
  }

  attachDetails(details: Record<string, unknown>) {
    this.details = { ...(this.details || {}), ...details };
    return this;
  }
}

export function toAutomaticExtractionError(error: unknown) {
  if (error instanceof AutomaticExtractionError) return error;
  const message = error instanceof Error ? error.message : "自动提取失败";
  if (isBrowserControlInfrastructureError(error)) {
    return new AutomaticExtractionError(
      "BROWSER_CONTROL_ERROR",
      "审核浏览器连接异常，当前批次已暂停。请点击“重新启动专用浏览器”后继续。",
      { technicalMessage: message.slice(0, 500) },
    );
  }
  return new AutomaticExtractionError("NETWORK_ERROR", message);
}

export function isBrowserControlInfrastructureError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /Target\.createTarget|cdpSession\.send|Protocol error|browser has been closed|context or browser has been closed|Target page, context or browser has been closed|BrowserContext.*closed|Browser.*disconnected|remote debugging|DevToolsActivePort|专用 Chromium 尚未连接|审核浏览器连接异常/iu.test(
    message,
  );
}
