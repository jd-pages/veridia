import type { Page } from "playwright";
import type { ExtractedNote, ExtractedTopic } from "@/lib/types";
import {
  douyinContentIdentityFromUrl,
  safeDouyinDiagnosticUrl,
} from "./douyin-page-classification";

type JsonRecord = Record<string, unknown>;

export interface DouyinStructuredEvidence {
  item: JsonRecord;
  responseUrl: string;
}

export interface DouyinExtractionOptions {
  canonicalUrl?: string | null;
  contentId?: string | null;
  structured?: DouyinStructuredEvidence | null;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function normalizeTopicText(value: string) {
  const text = value.trim();
  return text ? (text.startsWith("#") ? text : `#${text}`) : "";
}

export function findDouyinAwemeItem(payload: unknown, contentId: string) {
  const queue: unknown[] = [payload];
  let inspected = 0;
  while (queue.length && inspected < 20_000) {
    inspected += 1;
    const current = queue.shift();
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const record = asRecord(current);
    if (!record) continue;
    if (String(record.aweme_id || record.awemeId || record.id || "") === contentId) {
      return record;
    }
    queue.push(...Object.values(record));
  }
  return null;
}

function structuredTopics(item: JsonRecord) {
  const topics: ExtractedTopic[] = [];
  for (const value of asArray(item.text_extra || item.textExtra)) {
    const entry = asRecord(value);
    if (!entry || Number(entry.type) !== 1) continue;
    const name = asString(entry.hashtag_name || entry.hashtagName).trim();
    if (!name) continue;
    topics.push({
      displayText: normalizeTopicText(name),
      isLinkElement: true,
      hasHref: true,
      href: `https://www.douyin.com/search/${encodeURIComponent(name)}`,
      textColor: null,
      styleFeature: true,
      domPath: "structured:text_extra",
      source: "NETWORK_STRUCTURED_DATA",
    });
  }
  return topics;
}

function structuredImageCount(item: JsonRecord) {
  for (const key of ["images", "image_infos", "image_list", "imageInfos"]) {
    const value = item[key];
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

function structuredPublishedAt(item: JsonRecord) {
  const raw = Number(item.create_time || item.createTime || 0);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const millis = raw < 10_000_000_000 ? raw * 1_000 : raw;
  return new Date(millis).toISOString();
}

export async function collectDouyinEvidence(page: Page) {
  return page.evaluate(() => {
    const scope = document.querySelector("[data-e2e='note-detail']") || document;
    const selectors = [
      "[data-e2e='video-desc']",
      "[data-e2e='aweme-desc']",
      "[data-testid='douyin-description']",
      "article",
    ];
    const description = selectors
      .map((selector) => scope.querySelector(selector)?.textContent?.trim() || "")
      .find(Boolean) || "";
    const topicNodes = Array.from(scope.querySelectorAll(
      "a[href*='/search/'], a[href*='keyword'], [data-douyin-topic]",
    ));
    const topics = topicNodes.map((node) => {
      const element = node as HTMLElement;
      const anchor = element.closest("a") as HTMLAnchorElement | null;
      return {
        displayText: element.textContent?.trim() || "",
        isLinkElement: Boolean(anchor || element.tagName.toLowerCase() === "a"),
        hasHref: Boolean(anchor?.href || (element as HTMLAnchorElement).href),
        href: anchor?.href || (element as HTMLAnchorElement).href || null,
        textColor: getComputedStyle(element).color || null,
        styleFeature: /topic|hashtag/iu.test(`${element.className} ${element.getAttribute("data-e2e") || ""}`),
        domPath: element.tagName.toLowerCase(),
        source: "DOM",
      };
    });
    const scripts = Array.from(document.querySelectorAll(
      "script[type='application/json'], script#__RENDER_DATA__, script#RENDER_DATA",
    ))
      .map((script) => script.textContent || "")
      .filter(Boolean)
      .slice(0, 10);
    const imageSources = new Set(
      Array.from(scope.querySelectorAll(
        "[class*='dySwiperSlide'] img, [data-e2e='slide'] img, [data-testid='douyin-image']",
      ))
        .map((image) => (image as HTMLImageElement).currentSrc || (image as HTMLImageElement).src)
        .filter((src) => src && !src.includes("avatar")),
    );
    return {
      title: scope.querySelector("h1")?.textContent?.trim() || document.title,
      description,
      topics,
      hasVideo: Boolean(scope.querySelector("video")),
      imageCount: imageSources.size,
      authorName: scope.querySelector(
        "[data-e2e='video-author-name'], [data-e2e='user-info'], [data-testid='douyin-author']",
      )?.textContent?.trim() || null,
      publishedAt: scope.querySelector("time")?.getAttribute("datetime") || null,
      structuredPayloads: scripts,
      visibleText: document.body?.innerText?.slice(0, 20_000) || "",
    };
  });
}

export class PlaywrightDouyinAdapter {
  readonly platform = "DOUYIN" as const;
  readonly name = "playwright-douyin";
  readonly version = "1.1.0";

  canHandle(value: string) {
    try {
      const url = new URL(value);
      return url.hostname.endsWith("douyin.com") || url.hostname.endsWith("iesdouyin.com") ||
        (["localhost", "127.0.0.1"].includes(url.hostname) && url.pathname === "/mock/douyin");
    } catch { return false; }
  }

  async extract(
    page: Page,
    originalUrl: string,
    options: DouyinExtractionOptions = {},
  ): Promise<ExtractedNote> {
    const mockPayload = await page.locator("#mock-douyin-extraction-data").textContent({ timeout: 300 }).catch(() => null);
    if (mockPayload) {
      const parsed = JSON.parse(mockPayload) as ExtractedNote;
      return {
        ...parsed,
        url: originalUrl,
        finalUrl: options.canonicalUrl || page.url(),
        pageTitle: await page.title(),
        adapterName: this.name,
        adapterVersion: this.version,
        extractedAt: new Date().toISOString(),
      };
    }

    const evidence = await collectDouyinEvidence(page);
    const finalUrl = options.canonicalUrl || page.url();
    const urlIdentity = douyinContentIdentityFromUrl(finalUrl) ||
      douyinContentIdentityFromUrl(originalUrl);
    const structuredItem = options.structured?.item || null;
    const structuredTopicValues = structuredItem ? structuredTopics(structuredItem) : [];
    const topicCandidates = structuredTopicValues.length
      ? structuredTopicValues
      : evidence.topics;
    const uniqueTopics = new Map<string, ExtractedTopic>();
    for (const candidate of topicCandidates) {
      const displayText = normalizeTopicText(candidate.displayText);
      if (!displayText) continue;
      const key = displayText.toLocaleLowerCase("zh-CN");
      const existing = uniqueTopics.get(key);
      if (!existing || (!existing.isLinkElement && candidate.isLinkElement)) {
        uniqueTopics.set(key, { ...candidate, displayText });
      }
    }

    const structuredImages = structuredItem ? structuredImageCount(structuredItem) : 0;
    const noteType = urlIdentity?.noteType ||
      (structuredImages > 0 ? "IMAGE_TEXT" as const : evidence.hasVideo ? "VIDEO" as const : "UNKNOWN" as const);
    const imageCount = noteType === "IMAGE_TEXT"
      ? structuredImages || evidence.imageCount
      : 0;
    const body = structuredItem
      ? asString(structuredItem.desc || structuredItem.description)
      : evidence.description;
    const author = structuredItem ? asRecord(structuredItem.author) : null;
    const authorName = asString(author?.nickname || author?.name) || evidence.authorName;
    const publishedAt = structuredItem
      ? structuredPublishedAt(structuredItem) || evidence.publishedAt
      : evidence.publishedAt;

    return {
      url: originalUrl,
      finalUrl,
      pageTitle: await page.title(),
      pageType: noteType === "VIDEO" ? "VIDEO_DETAIL" : "IMAGE_TEXT_DETAIL",
      noteId: options.contentId || urlIdentity?.contentId || null,
      title: evidence.title || body || null,
      body: body || null,
      noteType,
      imageExtractionStatus: noteType === "VIDEO"
        ? "VIDEO_NOTE"
        : imageCount > 0 ? "SUCCESS" : "IMAGES_READ_FAILED",
      imageCount,
      topics: [...uniqueTopics.values()],
      pageStatus: "NORMAL",
      authorName: authorName || null,
      publishedAt: publishedAt || null,
      isPublic: null,
      extractedAt: new Date().toISOString(),
      adapterName: this.name,
      adapterVersion: this.version,
      technicalWarnings: [
        ...(!body ? ["BODY_NOT_RECOGNIZED"] : []),
        ...(!uniqueTopics.size ? ["TOPICS_NOT_RECOGNIZED"] : []),
      ],
      pageEvidence: {
        source: structuredItem ? "NETWORK_STRUCTURED_DATA" : "DOM",
        structuredResponseUrl: options.structured?.responseUrl
          ? safeDouyinDiagnosticUrl(options.structured.responseUrl)
          : null,
        hasVideoElement: evidence.hasVideo,
        domImageCount: evidence.imageCount,
        structuredImageCount: structuredImages,
        structuredPayloadCount: evidence.structuredPayloads.length,
      },
    };
  }
}

export const playwrightDouyinAdapter = new PlaywrightDouyinAdapter();
