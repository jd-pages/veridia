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

export interface UnavailablePageEvidence {
  status: "NOT_FOUND" | "DELETED";
  matchedText: string;
  source: "TITLE" | "BODY" | "URL";
}

const DELETED_PAGE_PATTERN =
  /笔记已删除|内容已被删除|内容已删除|作者已删除/u;
const NOT_FOUND_PAGE_PATTERN =
  /错误页|你访问的页面不见了|访问的页面不见了|页面不存在|页面失效|内容不存在|笔记不存在|当前笔记无法浏览|该内容无法查看|链接失效/u;

function firstPatternMatch(value: string, pattern: RegExp) {
  return value.match(pattern)?.[0] || null;
}

export function detectUnavailableXhsPage({
  url,
  title,
  visibleText,
}: PageClassificationInput): UnavailablePageEvidence | null {
  const sources = [
    { source: "TITLE" as const, value: title },
    { source: "BODY" as const, value: visibleText },
  ];
  for (const item of sources) {
    const deleted = firstPatternMatch(item.value, DELETED_PAGE_PATTERN);
    if (deleted) {
      return { status: "DELETED", matchedText: deleted, source: item.source };
    }
    const notFound = firstPatternMatch(item.value, NOT_FOUND_PAGE_PATTERN);
    if (notFound) {
      return {
        status: "NOT_FOUND",
        matchedText: notFound,
        source: item.source,
      };
    }
  }

  try {
    const parsed = new URL(url);
    if (
      !/^\/website-login\/error(?:\/|$)/iu.test(parsed.pathname) &&
      /(?:^|\/)(?:404|not[-_]?found|error(?:-page)?)(?:\/|$)/iu.test(
        parsed.pathname,
      )
    ) {
      return {
        status: "NOT_FOUND",
        matchedText: parsed.pathname,
        source: "URL",
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function unavailablePageFailureMessage(
  evidence: UnavailablePageEvidence,
) {
  const description =
    evidence.status === "DELETED" ? "疑似笔记已删除或链接失效" : "疑似笔记不存在或链接失效";
  return `小红书页面提示“${evidence.matchedText}”，${description}`;
}

export function isShortXiaohongshuUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return ["xhslink.com", "xhslink.cn"].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
    );
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
    /安全限制|IP存在风险|安全验证|访问验证|完成验证/u.test(combined) ||
    /\/website-login\/error(?:\/|$)/iu.test(parsed.pathname)
  ) {
    return "SECURITY_CHECK";
  }
  if (
    /登录后推荐|请先登录|登录以继续|手机号登录|扫码登录/u.test(combined)
  ) {
    return "LOGIN";
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
  if (detectUnavailableXhsPage({ url, title, visibleText })) {
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
