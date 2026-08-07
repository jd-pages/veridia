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
  source?: "NETWORK_RESPONSE" | "PAGE_SCRIPT";
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

function normalizedTopicKey(value: string) {
  return normalizeTopicText(value)
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN");
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
    if (
      String(
        record.aweme_id ||
          record.awemeId ||
          record.item_id ||
          record.itemId ||
          record.group_id ||
          record.groupId ||
          "",
      ) === contentId
    ) {
      return record;
    }
    queue.push(...Object.values(record));
  }
  return null;
}

function parseSerializedPayload(value: string) {
  const candidates = [value.trim()];
  if (/%(?:[0-9a-f]{2})/iu.test(value)) {
    try {
      candidates.push(decodeURIComponent(value));
    } catch {
      // Ignore malformed URL-encoded script data and continue with raw JSON.
    }
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      let parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "string") parsed = JSON.parse(parsed);
      return parsed;
    } catch {
      // A page can contain unrelated application/json scripts.
    }
  }
  return null;
}

export function findDouyinAwemeItemFromSerializedPayloads(
  payloads: readonly string[],
  contentId: string,
) {
  for (const serialized of payloads) {
    const parsed = parseSerializedPayload(serialized);
    if (!parsed) continue;
    const item = findDouyinAwemeItem(parsed, contentId);
    if (item) return item;
  }
  return null;
}

function structuredCaption(item: JsonRecord) {
  const candidates: Array<[unknown, string]> = [
    [item.desc, "STRUCTURED_DESC"],
    [item.caption, "STRUCTURED_CAPTION"],
    [item.description, "STRUCTURED_DESCRIPTION"],
  ];
  const shareInfo = asRecord(item.share_info || item.shareInfo);
  if (shareInfo) {
    candidates.push([
      shareInfo.share_desc || shareInfo.shareDesc,
      "STRUCTURED_SHARE_DESCRIPTION",
    ]);
  }
  for (const [value, source] of candidates) {
    const body = asString(value).trim();
    if (body) return { body, source };
  }
  return { body: "", source: null };
}

function hasStructuredCaptionField(item: JsonRecord) {
  if (["desc", "caption", "description"].some((key) =>
    Object.prototype.hasOwnProperty.call(item, key)
  )) return true;
  const shareInfo = asRecord(item.share_info || item.shareInfo);
  return Boolean(
    shareInfo &&
      ["share_desc", "shareDesc"].some((key) =>
        Object.prototype.hasOwnProperty.call(shareInfo, key)
      ),
  );
}

export function extractDouyinStructuredTopics(item: JsonRecord) {
  const topics: ExtractedTopic[] = [];
  const append = (
    nameValue: unknown,
    entitySource: string,
    entityId?: unknown,
    entityUrl?: unknown,
  ) => {
    const name = asString(nameValue).trim();
    if (!name) return;
    const id = asString(entityId).trim();
    const suppliedUrl = asString(entityUrl).trim();
    const href = suppliedUrl ||
      (id
        ? `https://www.douyin.com/search/${encodeURIComponent(name)}?aid=${encodeURIComponent(id)}`
        : `https://www.douyin.com/search/${encodeURIComponent(name)}`);
    topics.push({
      displayText: normalizeTopicText(name),
      isClickable: true,
      isLinkElement: false,
      hasHref: Boolean(href),
      href,
      textColor: null,
      styleFeature: true,
      domPath: `structured:${entitySource}`,
      source: "STRUCTURED_RESPONSE",
    });
  };

  for (const value of asArray(item.text_extra || item.textExtra)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const name = entry.hashtag_name || entry.hashtagName;
    if (!asString(name).trim()) continue;
    append(
      name,
      "text_extra",
      entry.hashtag_id || entry.hashtagId,
      entry.schema || entry.schema_url || entry.schemaUrl,
    );
  }

  for (const value of asArray(item.cha_list || item.chaList)) {
    const entry = asRecord(value);
    if (!entry) continue;
    append(
      entry.cha_name || entry.chaName || entry.hashtag_name,
      "cha_list",
      entry.cid || entry.cha_id || entry.chaId,
      entry.schema || entry.schema_url || entry.schemaUrl,
    );
  }

  for (const key of ["hashtags", "hashtag_list", "hashtagList", "challenges"]) {
    for (const value of asArray(item[key])) {
      const entry = asRecord(value);
      if (!entry) continue;
      append(
        entry.hashtag_name ||
          entry.hashtagName ||
          entry.cha_name ||
          entry.chaName ||
          entry.name,
        key,
        entry.hashtag_id || entry.hashtagId || entry.cid || entry.id,
        entry.schema || entry.schema_url || entry.schemaUrl || entry.url,
      );
    }
  }

  const unique = new Map<string, ExtractedTopic>();
  for (const topic of topics) {
    const key = normalizedTopicKey(topic.displayText);
    if (key && !unique.has(key)) unique.set(key, topic);
  }
  return [...unique.values()];
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
      "[data-e2e='video-title']",
      "[data-e2e='detail-desc']",
      "[data-testid='douyin-description']",
      "[class*='video-info'] [class*='desc']",
      "[class*='video-info'] [class*='title']",
      "[class*='note-detail'] [class*='desc']",
    ];
    let description = "";
    let descriptionSource: string | null = null;
    for (const selector of selectors) {
      const value = scope.querySelector(selector)?.textContent?.trim() || "";
      if (!value) continue;
      description = value;
      descriptionSource = `DOM:${selector}`;
      break;
    }
    const topicNodes = Array.from(scope.querySelectorAll(
      [
        "a[href*='/search/']",
        "a[href*='/hashtag/']",
        "a[href*='/challenge/']",
        "a[href*='keyword']",
        "[data-douyin-topic]",
        "[data-e2e*='hashtag']",
        "[data-e2e*='topic']",
        "[role='link'][class*='hash']",
        "[role='link'][class*='topic']",
      ].join(", "),
    ));
    if (!description && topicNodes.length) {
      const topicTexts = topicNodes
        .map((node) => node.textContent?.trim() || "")
        .filter(Boolean);
      let current = topicNodes[0].parentElement;
      for (let depth = 0; current && depth < 10; depth += 1) {
        const text = current.innerText?.trim() || current.textContent?.trim() || "";
        const containsEveryTopic = topicTexts.every((topic) => text.includes(topic));
        const nonTopicText = topicTexts.reduce(
          (value, topic) => value.replace(topic, " "),
          text,
        ).replace(/(?:展开|收起)\s*$/u, "").trim();
        if (
          containsEveryTopic &&
          nonTopicText &&
          text.length <= 2_000
        ) {
          description = text.replace(/(?:展开|收起)\s*$/u, "").trim();
          descriptionSource = "DOM_TOPIC_CONTAINER";
          break;
        }
        current = current.parentElement;
      }
    }
    if (!description) {
      const metaDescription = (
        document.querySelector("meta[property='og:description']") ||
        document.querySelector("meta[name='description']")
      )?.getAttribute("content")?.trim() || "";
      if (metaDescription && !/抖音，记录美好生活/u.test(metaDescription)) {
        description = metaDescription;
        descriptionSource = "META_DESCRIPTION";
      }
    }
    const topics = topicNodes.map((node) => {
      const element = node as HTMLElement;
      const anchor = element.closest("a") as HTMLAnchorElement | null;
      const role = element.getAttribute("role") || anchor?.getAttribute("role");
      const cursor = getComputedStyle(element).cursor;
      const hasInteraction = Boolean(
        anchor ||
          role === "link" ||
          role === "button" ||
          element.onclick ||
          element.tabIndex >= 0 ||
          cursor === "pointer",
      );
      return {
        displayText: element.textContent?.trim() || "",
        isClickable: hasInteraction,
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
      titleSource: scope.querySelector("h1") ? "DOM_H1" : "DOCUMENT_TITLE",
      description,
      descriptionSource,
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
  readonly version = "1.2.0";

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
    const embeddedStructuredItem = options.contentId
      ? findDouyinAwemeItemFromSerializedPayloads(
          evidence.structuredPayloads,
          options.contentId,
        )
      : null;
    const structuredEvidence = options.structured ||
      (embeddedStructuredItem
        ? {
            item: embeddedStructuredItem,
            responseUrl: finalUrl,
            source: "PAGE_SCRIPT" as const,
          }
        : null);
    const structuredItem = structuredEvidence?.item || null;
    const structuredTopicValues = structuredItem
      ? extractDouyinStructuredTopics(structuredItem)
      : [];
    const topicCandidates = [...structuredTopicValues, ...evidence.topics];
    const uniqueTopics = new Map<string, ExtractedTopic>();
    for (const candidate of topicCandidates) {
      const displayText = normalizeTopicText(candidate.displayText);
      if (!displayText) continue;
      const key = normalizedTopicKey(displayText);
      const existing = uniqueTopics.get(key);
      if (
        !existing ||
        (!existing.isClickable && candidate.isClickable) ||
        (!existing.hasHref && candidate.hasHref)
      ) {
        uniqueTopics.set(key, { ...candidate, displayText });
      }
    }

    const structuredImages = structuredItem ? structuredImageCount(structuredItem) : 0;
    const noteType = urlIdentity?.noteType ||
      (structuredImages > 0 || evidence.imageCount > 0
        ? "IMAGE_TEXT" as const
        : evidence.hasVideo
          ? "VIDEO" as const
          : "UNKNOWN" as const);
    const imageCount = noteType === "IMAGE_TEXT"
      ? structuredImages || evidence.imageCount
      : 0;
    const structuredBody = structuredItem
      ? structuredCaption(structuredItem)
      : { body: "", source: null };
    const structuredBodyReadable = structuredItem
      ? hasStructuredCaptionField(structuredItem)
      : false;
    const body = structuredBody.body || evidence.description;
    const bodySource = structuredBody.body
      ? structuredBody.source
      : evidence.description
        ? evidence.descriptionSource
        : null;
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
        ...(!body && !structuredBodyReadable ? ["BODY_NOT_RECOGNIZED"] : []),
        ...(!uniqueTopics.size ? ["TOPICS_NOT_RECOGNIZED"] : []),
      ],
      pageEvidence: {
        source: structuredEvidence
          ? structuredEvidence.source === "PAGE_SCRIPT"
            ? "PAGE_STRUCTURED_DATA"
            : "NETWORK_STRUCTURED_DATA"
          : "DOM",
        bodySource,
        titleSource: evidence.titleSource,
        structuredEvidenceSource: structuredEvidence?.source || null,
        structuredResponseUrl: structuredEvidence?.responseUrl
          ? safeDouyinDiagnosticUrl(structuredEvidence.responseUrl)
          : null,
        hasVideoElement: evidence.hasVideo,
        domImageCount: evidence.imageCount,
        structuredImageCount: structuredImages,
        structuredPayloadCount: evidence.structuredPayloads.length,
        structuredHashtagCount: structuredTopicValues.length,
        domHashtagCount: evidence.topics.length,
        finalTopicCount: uniqueTopics.size,
        topicEvidence: [...uniqueTopics.values()].map((topic) => ({
          displayText: topic.displayText,
          source: topic.source || null,
          isClickable: topic.isClickable ?? null,
          isLinkElement: topic.isLinkElement,
          hasHref: topic.hasHref,
        })),
      },
    };
  }
}

export const playwrightDouyinAdapter = new PlaywrightDouyinAdapter();
