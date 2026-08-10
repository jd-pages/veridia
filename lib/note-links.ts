import {
  platformFromUrl,
  type AutomationPlatform,
} from "@/lib/automation/platform";

export type NoteLinkPlatform = AutomationPlatform | "UNKNOWN";
export type NoteLinkType = "LONG" | "SHORT";
export type XiaohongshuLinkType = NoteLinkType;

export interface ExtractedNoteLink {
  url: string;
  platform: AutomationPlatform;
  type: NoteLinkType;
}

export interface UnrecognizedNoteLinkSegment {
  input: string;
  reason: string;
}

export interface NoteLinkExtractionResult {
  rawInput: string;
  recognizedCount: number;
  duplicateCount: number;
  links: ExtractedNoteLink[];
  unrecognized: UnrecognizedNoteLinkSegment[];
}

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'“”‘’]+/giu;
const TRAILING_PUNCTUATION = /[，。；：！？、\]}>》”’]+$/u;

function hostnameMatches(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function cleanUrlCandidate(value: string) {
  let cleaned = value.trim();
  while (TRAILING_PUNCTUATION.test(cleaned)) {
    cleaned = cleaned.replace(TRAILING_PUNCTUATION, "");
  }
  return cleaned;
}

export function extractHttpUrlsFromText(input: string): string[] {
  return (input.match(HTTP_URL_PATTERN) || [])
    .map(cleanUrlCandidate)
    .filter((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
      } catch {
        return false;
      }
    });
}

function classifyDouyinUrl(url: URL) {
  const hostname = url.hostname.toLowerCase();
  if (
    process.env.NODE_ENV !== "production" &&
    ["localhost", "127.0.0.1"].includes(hostname) &&
    url.pathname.startsWith("/mock/douyin")
  ) {
    return { type: "LONG" as const, supported: true, reason: null };
  }
  if (hostnameMatches(hostname, "v.douyin.com")) {
    return {
      type: "SHORT" as const,
      supported: url.pathname !== "/",
      reason: url.pathname === "/" ? "抖音短链接缺少跳转路径" : null,
    };
  }
  if (
    hostnameMatches(hostname, "douyin.com") ||
    hostnameMatches(hostname, "iesdouyin.com")
  ) {
    const supported =
      /^\/(?:video|note)\/[^/?#]+/iu.test(url.pathname) ||
      /^\/share\/(?:video|note)\/[^/?#]+/iu.test(url.pathname);
    return {
      type: "LONG" as const,
      supported,
      reason: supported ? null : "不是抖音作品详情链接",
    };
  }
  return null;
}

export function classifyNoteUrl(input: string): {
  platform: NoteLinkPlatform;
  type: NoteLinkType | null;
  supported: boolean;
  reason: string | null;
} {
  try {
    const url = new URL(cleanUrlCandidate(input));
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { platform: "UNKNOWN", type: null, supported: false, reason: "链接协议不是 HTTP 或 HTTPS" };
    }
    const hostname = url.hostname.toLowerCase();
    const douyin = classifyDouyinUrl(url);
    if (douyin) return { platform: "DOUYIN", ...douyin };
    if (
      process.env.NODE_ENV !== "production" &&
      ["localhost", "127.0.0.1"].includes(hostname) &&
      url.pathname === "/mock/xhs"
    ) {
      return { platform: "XIAOHONGSHU", type: "LONG", supported: true, reason: null };
    }
    if (hostnameMatches(hostname, "xhslink.com") || hostnameMatches(hostname, "xhslink.cn")) {
      return {
        platform: "XIAOHONGSHU",
        type: "SHORT",
        supported: url.pathname !== "/",
        reason: url.pathname === "/" ? "小红书短链接缺少跳转路径" : null,
      };
    }
    if (hostnameMatches(hostname, "xiaohongshu.com")) {
      const supported =
        /^\/explore\/[^/?#]+/iu.test(url.pathname) ||
        /^\/discovery\/item\/[^/?#]+/iu.test(url.pathname);
      return {
        platform: "XIAOHONGSHU",
        type: "LONG",
        supported,
        reason: supported ? null : "不是小红书笔记详情链接",
      };
    }
    return { platform: "UNKNOWN", type: null, supported: false, reason: "未识别的平台链接" };
  } catch {
    return { platform: "UNKNOWN", type: null, supported: false, reason: "链接格式不正确" };
  }
}

export function isSupportedXiaohongshuNoteUrl(input: string) {
  const result = classifyNoteUrl(input);
  return result.platform === "XIAOHONGSHU" && result.supported;
}

export function isSupportedDouyinNoteUrl(input: string) {
  const result = classifyNoteUrl(input);
  return result.platform === "DOUYIN" && result.supported;
}

export function extractNoteLinksFromText(input: string | string[]): NoteLinkExtractionResult {
  const values = Array.isArray(input) ? input : [input];
  const rawInput = values.join("\n");
  const candidates = values.flatMap(extractHttpUrlsFromText);
  const recognized = candidates.flatMap<ExtractedNoteLink>((candidate) => {
    const classification = classifyNoteUrl(candidate);
    return classification.platform !== "UNKNOWN" && classification.supported && classification.type
      ? [{ url: candidate, platform: classification.platform, type: classification.type }]
      : [];
  });
  const links: ExtractedNoteLink[] = [];
  const seen = new Set<string>();
  for (const link of recognized) {
    const key = `${link.platform}:${new URL(link.url).toString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }
  const unrecognized: UnrecognizedNoteLinkSegment[] = [];
  for (const segment of values.flatMap((value) => value.split(/\r?\n/u))) {
    const text = segment.trim();
    if (!text) continue;
    const urls = extractHttpUrlsFromText(text);
    if (urls.some((url) => classifyNoteUrl(url).supported)) continue;
    const classifications = urls.map(classifyNoteUrl);
    unrecognized.push({
      input: text,
      reason:
        classifications.find((item) => item.reason)?.reason ||
        (urls.length ? "未识别的平台链接" : "未识别到链接"),
    });
  }
  return {
    rawInput,
    recognizedCount: recognized.length,
    duplicateCount: recognized.length - links.length,
    links,
    unrecognized,
  };
}

export function detectContentPlatform(input: string): NoteLinkPlatform {
  for (const url of extractHttpUrlsFromText(input)) {
    const platform = platformFromUrl(url);
    if (platform) return platform;
  }
  return "UNKNOWN";
}

export function resolveImportedNoteLink(input: {
  rawContent: string;
  hyperlinkTarget?: string;
  declaredChannel?: string;
}) {
  const rawContent = input.rawContent.trim();
  const hyperlinkTarget = input.hyperlinkTarget?.trim() || "";
  const declaredChannel = input.declaredChannel?.trim() || "";
  const declaredPlatform: NoteLinkPlatform = /抖音|douyin/iu.test(declaredChannel)
    ? "DOUYIN"
    : /小红书|xiaohongshu|xhs/iu.test(declaredChannel)
      ? "XIAOHONGSHU"
      : "UNKNOWN";
  const extraction = extractNoteLinksFromText(hyperlinkTarget ? [hyperlinkTarget, rawContent] : rawContent);
  const inferredPlatform = detectContentPlatform([hyperlinkTarget, rawContent].filter(Boolean).join("\n"));
  const platform = declaredPlatform === "UNKNOWN" ? inferredPlatform : declaredPlatform;
  if (!rawContent && !hyperlinkTarget) {
    return { originalContent: "", url: "", platform, status: "UNRECOGNIZED" as const, failureReason: "链接（必填）列为空", extraction };
  }
  const matchingLink = extraction.links.find((link) => platform === "UNKNOWN" || link.platform === platform);
  if (!matchingLink) {
    const mismatch = extraction.links[0] && declaredPlatform !== "UNKNOWN" && extraction.links[0].platform !== declaredPlatform;
    return {
      originalContent: rawContent || hyperlinkTarget,
      url: "",
      platform,
      status: "UNRECOGNIZED" as const,
      failureReason: mismatch
        ? `内容渠道与链接平台不一致：填写为${declaredPlatform === "DOUYIN" ? "抖音" : "小红书"}`
        : extraction.unrecognized[0]?.reason || "未识别到有效作品详情链接",
      extraction,
    };
  }
  return {
    originalContent: rawContent || hyperlinkTarget,
    url: matchingLink.url,
    platform: matchingLink.platform,
    status: "RECOGNIZED" as const,
    failureReason: "",
    extraction,
  };
}
