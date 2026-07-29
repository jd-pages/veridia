export type AutomaticPageType =
  | "NOTE_DETAIL"
  | "LOGIN"
  | "SECURITY_CHECK"
  | "APP_LAUNCH"
  | "ERROR_PAGE"
  | "SHORT_LINK"
  | "UNKNOWN";

export interface PageClassificationInput {
  url: string;
  title: string;
  visibleText: string;
}

export function isShortXiaohongshuUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "xhslink.com" || hostname.endsWith(".xhslink.com");
  } catch {
    return false;
  }
}

export function isXiaohongshuNoteDetailUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.hostname.toLowerCase().endsWith("xiaohongshu.com") &&
      /^\/(?:explore|discovery\/item)\/[a-z0-9]+/iu.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function classifyAutomaticPage({
  url,
  title,
  visibleText,
}: PageClassificationInput): AutomaticPageType {
  const combined = `${title}\n${visibleText}`;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    return "UNKNOWN";
  }

  if (
    /验证码|安全验证|完成验证|滑块验证|访问验证|异常访问|网络环境存在风险/u.test(
      combined,
    ) ||
    /captcha|verification|security-check/iu.test(parsed.pathname)
  ) {
    return "SECURITY_CHECK";
  }
  if (
    /登录后查看|请先登录|登录已过期|登录以继续|扫码登录|手机号登录/u.test(
      combined,
    ) ||
    /\/login(?:\/|$)/iu.test(parsed.pathname)
  ) {
    return "LOGIN";
  }
  if (
    /打开小红书(?:App|APP)?|唤起小红书|前往App查看|在App内打开/u.test(
      combined,
    ) ||
    /openapp|app-launch|deeplink/iu.test(parsed.pathname)
  ) {
    return "APP_LAUNCH";
  }
  if (
    /笔记已删除|内容已删除|内容不存在|笔记不存在|页面不存在|访问的页面不见了/u.test(
      combined,
    )
  ) {
    return "ERROR_PAGE";
  }
  if (isXiaohongshuNoteDetailUrl(url)) return "NOTE_DETAIL";
  if (isShortXiaohongshuUrl(url)) return "SHORT_LINK";
  return "UNKNOWN";
}

export function safePageLogUrl(value: string) {
  try {
    const url = new URL(value);
    for (const key of ["xsec_token", "shareRedId", "share_id"]) {
      if (url.searchParams.has(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return value;
  }
}
