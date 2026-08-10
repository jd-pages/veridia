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

export function toWellFormedBrowserText(value: string) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] + value[index + 1];
        index += 1;
      } else {
        result += "\uFFFD";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\uFFFD";
    } else {
      result += value[index];
    }
  }
  return result;
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
    if (
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      url.pathname.startsWith("/mock/douyin")
    ) return true;
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
  hasContentEvidence?: boolean;
}): { state: DouyinPageState; pageType: DouyinPageType; matchedCondition: string | null } {
  const combined = `${input.url}\n${input.title || ""}\n${input.visibleText || ""}`;
  const contentRendered = input.hasContentEvidence === true;
  if (input.timedOut && !contentRendered) return { state: "PAGE_LOAD_TIMEOUT", pageType: "ERROR_PAGE", matchedCondition: "navigation-timeout" };
  if (input.networkError && !contentRendered) return { state: "NETWORK_ERROR", pageType: "ERROR_PAGE", matchedCondition: "network-error" };
  if (matchesAny(combined, SECURITY_PATTERNS) && !contentRendered) return { state: "SECURITY_RESTRICTED", pageType: "SECURITY_CHECK", matchedCondition: "security-marker" };
  if ([404, 410].includes(input.httpStatus || 0) || matchesAny(combined, NOT_FOUND_PATTERNS)) {
    return { state: "NOTE_NOT_FOUND", pageType: "ERROR_PAGE", matchedCondition: input.httpStatus ? `http-${input.httpStatus}` : "not-found-marker" };
  }
  if (matchesAny(combined, LOGIN_PATTERNS) && !contentRendered) return { state: "NOT_LOGGED_IN", pageType: "LOGIN", matchedCondition: "login-wall" };
  if (matchesAny(combined, NO_PERMISSION_PATTERNS)) return { state: "NO_PERMISSION", pageType: "ERROR_PAGE", matchedCondition: "permission-marker" };
  if (matchesAny(combined, APP_LAUNCH_PATTERNS) && !isDouyinContentDetailUrl(input.url)) return { state: "APP_LAUNCH", pageType: "APP_LAUNCH", matchedCondition: "app-launch-marker" };
  if (isDouyinShortUrl(input.url)) return { state: "UNKNOWN", pageType: "SHORT_LINK", matchedCondition: null };
  if (
    isDouyinContentDetailUrl(input.url) &&
    input.hasContentEvidence !== false
  ) {
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
  expectedContentId?: string | null,
) {
  const currentUrl = page.url();
  const snapshot = await page.evaluate((contentId) => {
    const body = document.body;
    const visibleText = body?.innerText || "";
    const html = body?.innerHTML || "";
    const detailRoot = document.querySelector("[data-e2e='note-detail']");
    const detailScope = detailRoot || document;
    const description = detailScope.querySelector(
      [
        "[data-e2e='video-desc']",
        "[data-e2e='aweme-desc']",
        "[data-e2e='video-title']",
        "[data-e2e='detail-desc']",
        "[data-testid='douyin-description']",
      ].join(", "),
    )?.textContent?.trim() || "";
    const mediaCount = detailScope.querySelectorAll(
      "video, [class*='dySwiperSlide'] img, [data-e2e='slide'] img, [data-testid='douyin-image']",
    ).length;
    const structuredScripts = Array.from(document.querySelectorAll(
      "script[type='application/json'], script#__RENDER_DATA__, script#RENDER_DATA",
    )).map((script) => script.textContent || "");
    const hasStructuredCurrentContent = Boolean(
      contentId && structuredScripts.some((value) => value.includes(contentId)),
    );
    return {
      title: document.title,
      readyState: document.readyState,
      visibleText,
      visibleTextLength: visibleText.length,
      bodyLength: html.length,
      hasDetailRoot: Boolean(detailRoot),
      descriptionLength: description.length,
      mediaCount,
      hasStructuredCurrentContent,
      contentIdInDocument: Boolean(contentId && html.includes(contentId)),
    };
  }, expectedContentId || null).catch(() => ({
    title: "",
    readyState: "unknown",
    visibleText: "",
    visibleTextLength: 0,
    bodyLength: 0,
    hasDetailRoot: false,
    descriptionLength: 0,
    mediaCount: 0,
    hasStructuredCurrentContent: false,
    contentIdInDocument: false,
  }));
  const currentIdentity = douyinContentIdentityFromUrl(currentUrl);
  const contentIdMatches = !expectedContentId ||
    currentIdentity?.contentId === expectedContentId ||
    snapshot.contentIdInDocument ||
    snapshot.hasStructuredCurrentContent;
  const hasContentEvidence = Boolean(
    contentIdMatches &&
      (
        snapshot.hasStructuredCurrentContent ||
        (snapshot.hasDetailRoot &&
          (snapshot.descriptionLength > 0 || snapshot.mediaCount > 0))
      ),
  );
  const title = toWellFormedBrowserText(snapshot.title);
  const visibleText = toWellFormedBrowserText(snapshot.visibleText);
  const finalUrl = canonicalUrl || currentUrl;
  const classified = classifyDouyinPage({
    url: currentUrl,
    title,
    visibleText,
    httpStatus,
    hasContentEvidence,
  });
  return {
    finalUrl,
    currentUrl,
    title,
    visibleText: visibleText.slice(0, 10_000),
    visibleTextLength: visibleText.length,
    bodyLength: snapshot.bodyLength,
    documentReadyState: snapshot.readyState,
    hasDetailRoot: snapshot.hasDetailRoot,
    descriptionLength: snapshot.descriptionLength,
    mediaCount: snapshot.mediaCount,
    hasStructuredCurrentContent: snapshot.hasStructuredCurrentContent,
    contentIdInDocument: snapshot.contentIdInDocument,
    contentIdMatches,
    hasContentEvidence,
    httpStatus: httpStatus || null,
    ...classified,
  };
}
