import type { Page } from "playwright";

export type DouyinPageState =
  | "NORMAL"
  | "NOTE_NOT_FOUND"
  | "NOT_LOGGED_IN"
  | "SECURITY_RESTRICTED"
  | "NO_PERMISSION"
  | "APP_LAUNCH"
  | "NETWORK_ERROR"
  | "PAGE_LOAD_TIMEOUT"
  | "UNKNOWN";

export type DouyinPageType =
  | "VIDEO_DETAIL"
  | "IMAGE_TEXT_DETAIL"
  | "SHORT_LINK"
  | "LOGIN"
  | "SECURITY_CHECK"
  | "ERROR_PAGE"
  | "APP_LAUNCH"
  | "UNKNOWN";

const SECURITY_PATTERNS = [
  /安全验证/u,
  /访问频繁/u,
  /验证码/u,
  /verifycenter/iu,
  /captcha/iu,
  /risk.?control/iu,
];
const LOGIN_PATTERNS = [
  /登录后继续/u,
  /扫码登录/u,
  /手机号登录/u,
  /passport\.douyin/iu,
];
const NOT_FOUND_PATTERNS = [
  /作品不存在/u,
  /视频不见了/u,
  /内容不存在/u,
  /页面不存在/u,
  /作品已删除/u,
  /该作品无法查看/u,
  /你要观看的(?:图文|视频|作品|内容)不存在/u,
  /你要查看的(?:图文|视频|作品|内容)不存在/u,
];
const NO_PERMISSION_PATTERNS = [
  /仅作者好友可见/u,
  /私密作品/u,
  /暂无权限查看/u,
];
const APP_LAUNCH_PATTERNS = [/打开抖音/u, /前往抖音App/u, /唤起抖音/u];

function matchesAny(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(value));
}

export function isDouyinShortUrl(value: string) {
  try {
    const url = new URL(value);
    return url.hostname === "v.douyin.com" || url.hostname.endsWith(".v.douyin.com");
  } catch {
    return false;
  }
}

export function douyinContentIdentityFromUrl(value: string) {
  try {
    const url = new URL(value);
    const match = url.pathname.match(
      /^\/(?:share\/)?(video|note|slides)\/([^/?#]+)/iu,
    );
    if (!match) return null;
    const noteType = match[1].toLocaleLowerCase() === "video"
      ? ("VIDEO" as const)
      : ("IMAGE_TEXT" as const);
    return {
      contentId: match[2],
      noteType,
      canonicalUrl: `https://www.douyin.com/${
        noteType === "VIDEO" ? "video" : "note"
      }/${match[2]}`,
    };
  } catch {
    return null;
  }
}

export function isDouyinContentDetailUrl(value: string) {
  try {
    const url = new URL(value);
    if (["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname === "/mock/douyin") return true;
    return (
      (url.hostname === "douyin.com" || url.hostname.endsWith(".douyin.com") ||
        url.hostname === "iesdouyin.com" || url.hostname.endsWith(".iesdouyin.com")) &&
      Boolean(douyinContentIdentityFromUrl(value))
    );
  } catch {
    return false;
  }
}

export function safeDouyinDiagnosticUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.slice(0, 200);
  }
}

export function classifyDouyinPage(input: {
  url: string;
  title?: string | null;
  visibleText?: string | null;
  httpStatus?: number | null;
  timedOut?: boolean;
  networkError?: boolean;
}): { state: DouyinPageState; pageType: DouyinPageType; matchedCondition: string | null } {
  const combined = `${input.url}\n${input.title || ""}\n${input.visibleText || ""}`;
  if (input.timedOut) return { state: "PAGE_LOAD_TIMEOUT", pageType: "ERROR_PAGE", matchedCondition: "navigation-timeout" };
  if (input.networkError) return { state: "NETWORK_ERROR", pageType: "ERROR_PAGE", matchedCondition: "network-error" };
  if (matchesAny(combined, SECURITY_PATTERNS)) return { state: "SECURITY_RESTRICTED", pageType: "SECURITY_CHECK", matchedCondition: "security-marker" };
  if (matchesAny(combined, LOGIN_PATTERNS)) return { state: "NOT_LOGGED_IN", pageType: "LOGIN", matchedCondition: "login-marker" };
  if ([404, 410].includes(input.httpStatus || 0) || matchesAny(combined, NOT_FOUND_PATTERNS)) {
    return { state: "NOTE_NOT_FOUND", pageType: "ERROR_PAGE", matchedCondition: input.httpStatus ? `http-${input.httpStatus}` : "not-found-marker" };
  }
  if (matchesAny(combined, NO_PERMISSION_PATTERNS)) return { state: "NO_PERMISSION", pageType: "ERROR_PAGE", matchedCondition: "permission-marker" };
  if (matchesAny(combined, APP_LAUNCH_PATTERNS) && !isDouyinContentDetailUrl(input.url)) return { state: "APP_LAUNCH", pageType: "APP_LAUNCH", matchedCondition: "app-launch-marker" };
  if (isDouyinShortUrl(input.url)) return { state: "UNKNOWN", pageType: "SHORT_LINK", matchedCondition: null };
  if (isDouyinContentDetailUrl(input.url)) {
    const identity = douyinContentIdentityFromUrl(input.url);
    return {
      state: "NORMAL",
      pageType: identity?.noteType === "IMAGE_TEXT" ? "IMAGE_TEXT_DETAIL" : "VIDEO_DETAIL",
      matchedCondition: "content-detail-url",
    };
  }
  return { state: "UNKNOWN", pageType: "UNKNOWN", matchedCondition: null };
}

export async function readDouyinPageIdentity(
  page: Page,
  httpStatus?: number | null,
  canonicalUrl?: string | null,
) {
  const [title, visibleText] = await Promise.all([
    page.title().catch(() => ""),
    page.locator("body").innerText({ timeout: 3_000 }).catch(() => ""),
  ]);
  const finalUrl = canonicalUrl || page.url();
  const classified = classifyDouyinPage({ url: finalUrl, title, visibleText, httpStatus });
  return { finalUrl, title, visibleText: visibleText.slice(0, 10_000), httpStatus: httpStatus || null, ...classified };
}
