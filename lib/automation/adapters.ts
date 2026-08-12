import type { Page } from "playwright";
import type { ExtractedNote, PageStatus } from "@/lib/types";
import { collectXhsInteractionMetrics } from "@/lib/interaction-metrics";
import {
  collectDomPageSnapshot,
  createEmptyCandidates,
  mergeCandidates,
  noteIdCandidatesFromUrls,
  resolveXhsMediaDecision,
  safeEvidenceUrl,
  verifiedTopicsForCurrentNote,
  type XhsPageCandidates,
} from "./xhs-page-evidence";

export interface PlaywrightExtractionContext {
  redirectChain?: string[];
  responseCandidates?: XhsPageCandidates;
}

export interface PlaywrightExtractorAdapter {
  name: string;
  version: string;
  canHandle(url: string): boolean;
  extract(
    page: Page,
    originalUrl: string,
    context?: PlaywrightExtractionContext,
  ): Promise<ExtractedNote>;
}

function isLocalMockUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      url.pathname === "/mock/xhs"
    );
  } catch {
    return false;
  }
}

export class PlaywrightMockAdapter implements PlaywrightExtractorAdapter {
  name = "playwright-mock-xhs";
  version = "1.3.0";

  canHandle(url: string) {
    return isLocalMockUrl(url);
  }

  async extract(page: Page, originalUrl: string): Promise<ExtractedNote> {
    const payload = await page.locator("#mock-extraction-data").textContent();
    if (!payload) {
      throw new Error("模拟页面缺少提取数据");
    }
    const parsed = JSON.parse(payload) as ExtractedNote;
    const note = { ...parsed };
    delete note.imageUrls;
    return {
      ...note,
      noteType: note.noteType ?? "IMAGE_TEXT",
      imageExtractionStatus:
        note.imageExtractionStatus ??
        (Number.isInteger(note.imageCount) ? "SUCCESS" : "IMAGES_READ_FAILED"),
      url: originalUrl,
      finalUrl: page.url(),
      pageTitle: await page.title(),
      pageType: "NOTE_DETAIL",
      extractedAt: new Date().toISOString(),
      adapterName: this.name,
      adapterVersion: this.version,
    };
  }
}

export class PlaywrightXiaohongshuAdapter
  implements PlaywrightExtractorAdapter
{
  name = "playwright-xiaohongshu";
  version = "1.6.0";

  canHandle(url: string) {
    try {
      return new URL(url).hostname.endsWith("xiaohongshu.com");
    } catch {
      return false;
    }
  }

  async extract(
    page: Page,
    originalUrl: string,
    context: PlaywrightExtractionContext = {},
  ): Promise<ExtractedNote> {
    const domSnapshot = await collectDomPageSnapshot(page);
    const interactionMetrics = await collectXhsInteractionMetrics(page).catch(
      (error) => ({
        likeCount: null,
        favoriteCount: null,
        commentCount: null,
        totalCount: null,
        status: "UNAVAILABLE" as const,
        technicalMessage:
          error instanceof Error ? error.message : "互动区域读取失败",
        candidates: [],
      }),
    );
    const urlCandidates = createEmptyCandidates();
    urlCandidates.noteIdCandidates = noteIdCandidatesFromUrls([
      domSnapshot.finalUrl,
      originalUrl,
      ...(context.redirectChain || []),
    ]);
    const candidates = mergeCandidates(
      urlCandidates,
      domSnapshot,
      context.responseCandidates || createEmptyCandidates(),
    );
    const currentNoteId = candidates.noteIdCandidates[0]?.value || null;
    const textHashtagCandidates = candidates.textHashtagCandidates.map(
      (topic) => ({
        ...topic,
        contentId: topic.contentId || currentNoteId,
      }),
    );
    const verifiedPlatformTopics = verifiedTopicsForCurrentNote(
      candidates,
      currentNoteId,
    )
      .map((topic) => ({
        displayText: topic.displayText,
        isClickable: true,
        isLinkElement: topic.isLinkElement,
        hasHref: topic.hasHref,
        href: topic.href,
        textColor: topic.textColor,
        styleFeature: topic.styleFeature,
        domPath: topic.domPath,
        source: topic.source,
        contentId: topic.contentId || currentNoteId,
      }));
    const topics = verifiedPlatformTopics.map((topic) => ({
      displayText: topic.displayText,
      isClickable: true,
      isLinkElement: topic.isLinkElement,
      hasHref: topic.hasHref,
      href: topic.href,
      textColor: topic.textColor,
      styleFeature: topic.styleFeature,
      domPath: topic.domPath,
      source: topic.source,
      contentId: topic.contentId,
    }));
    const title =
      candidates.titleCandidates.find(
        (item) => item.value && !/^小红书\s*[-·]/u.test(item.value),
      )?.value || null;
    const body =
      candidates.bodyCandidates.find((item) => item.value.trim().length > 0)
        ?.value || null;
    const reliableImageCandidates = candidates.imageCandidates.filter(
      (candidate) => candidate.source === "DOM_MEDIA",
    );
    const mediaDecision = resolveXhsMediaDecision({
      domHasVideo: domSnapshot.domHasVideo,
      responseHasVideo: candidates.hasVideo,
      videoEvidence: domSnapshot.videoEvidence,
      videoCandidateCount: domSnapshot.videoCandidateCount,
      hasLivePhotoMarker: domSnapshot.hasLivePhotoMarker,
      hasCarouselStructure: domSnapshot.hasCarouselStructure,
      carouselPageIndicator: domSnapshot.carouselPageIndicator,
      carouselTotal: domSnapshot.carouselTotal,
      imageCandidateCount: reliableImageCandidates.length,
    });
    const { noteType, imageExtractionStatus, imageCount } = mediaDecision;
    const publishedAtCandidates = candidates.publishedAtCandidates.map(
      (candidate) =>
        candidate.source.startsWith("DOM_MAIN_NOTE") && !candidate.contentId
          ? { ...candidate, contentId: currentNoteId }
          : candidate,
    );
    const currentPublishedAtCandidates = publishedAtCandidates.filter(
      (candidate) => candidate.contentId === currentNoteId,
    );
    const structuredPublishedAt = currentPublishedAtCandidates.find(
      (candidate) =>
        candidate.source.startsWith("NETWORK_JSON") && candidate.value,
    ) || currentPublishedAtCandidates.find(
      (candidate) => candidate.source.startsWith("PAGE_JSON") && candidate.value,
    ) || null;
    const domPublishedAt = currentPublishedAtCandidates.find((candidate) =>
      candidate.source.startsWith("DOM_MAIN_NOTE"),
    ) || null;
    const publishedAtEvidence = domSnapshot.pageStatus === "NORMAL" && currentNoteId
      ? structuredPublishedAt
        ? {
            ...structuredPublishedAt,
            // The current-note DOM is the authority for what the platform
            // visibly showed (for example "07-27" or "昨天 19:05").
            raw: domPublishedAt?.raw || structuredPublishedAt.raw,
            source: domPublishedAt
              ? `${structuredPublishedAt.source}|${domPublishedAt.source}`
              : structuredPublishedAt.source,
          }
        : domPublishedAt
      : null;

    return {
      url: originalUrl,
      finalUrl: domSnapshot.finalUrl,
      pageTitle: domSnapshot.pageTitle,
      pageType: "NOTE_DETAIL",
      noteId: currentNoteId,
      title,
      body,
      topics,
      textHashtagCandidates,
      verifiedPlatformTopics,
      topicEvidenceCollected: true,
      pageStatus: domSnapshot.pageStatus,
      isPublic: domSnapshot.pageStatus === "NORMAL",
      authorName: null,
      noteType,
      imageExtractionStatus,
      imageCount,
      likeCount: interactionMetrics.likeCount,
      favoriteCount: interactionMetrics.favoriteCount,
      commentCount: interactionMetrics.commentCount,
      interactionExtractionStatus: interactionMetrics.status,
      interactionTechnicalMessage: interactionMetrics.technicalMessage,
      publishedAt: publishedAtEvidence?.value || null,
      publishedAtRaw: publishedAtEvidence?.raw || null,
      publishedAtSource: publishedAtEvidence?.source || null,
      extractedAt: new Date().toISOString(),
      adapterName: this.name,
      adapterVersion: this.version,
      pageEvidence: {
        originalUrl: safeEvidenceUrl(originalUrl),
        finalUrl: safeEvidenceUrl(domSnapshot.finalUrl),
        pageTitle: domSnapshot.pageTitle,
        visibleTextPreview: domSnapshot.visibleTextPreview,
        visibleTextLength: domSnapshot.visibleTextLength,
        htmlLength: domSnapshot.htmlLength,
        noteIdCandidates: candidates.noteIdCandidates.slice(0, 20),
        titleCandidates: candidates.titleCandidates.slice(0, 20),
        bodyCandidates: candidates.bodyCandidates.slice(0, 20).map((item) => ({
          ...item,
          value: item.value.slice(0, 2_000),
        })),
        textHashtagCandidates: textHashtagCandidates.slice(0, 100),
        verifiedPlatformTopics: verifiedPlatformTopics.slice(0, 100),
        imageCandidates: candidates.imageCandidates.slice(0, 100),
        publishedAtCandidate: publishedAtEvidence,
        mediaEvidence: {
          livePhotoMarker: domSnapshot.hasLivePhotoMarker,
          carouselPageIndicator: domSnapshot.carouselPageIndicator,
          carouselCurrent: domSnapshot.carouselCurrent,
          carouselTotal: domSnapshot.carouselTotal,
          carouselStructure: domSnapshot.hasCarouselStructure,
          domImageCandidateCount: reliableImageCandidates.length,
          mergedImageCandidateCount: candidates.imageCandidates.length,
          domHasVideo: domSnapshot.domHasVideo,
          responseHasVideo: candidates.hasVideo,
          videoEvidence: domSnapshot.videoEvidence,
          videoCandidateCount: domSnapshot.videoCandidateCount,
          noteTypeDecision: noteType,
          noteTypeReason: mediaDecision.reason,
          resolvedImageCount: imageCount ?? null,
        },
        interactionEvidence: interactionMetrics,
        loginEvidence: candidates.loginEvidence,
        responseSummaries: candidates.responseSummaries,
        keyElementCount: domSnapshot.keyElementCount,
        domSummary: domSnapshot.domSummary,
      },
    };
  }

  private async extractLegacy(
    page: Page,
    originalUrl: string,
  ): Promise<ExtractedNote> {
    const mediaSelector = [
      "[data-testid='note-media']",
      ".note-slider",
      ".slider-container",
      ".swiper-container",
      ".swiper",
      "[class*='note-slider']",
      "[class*='carousel']",
      "[class*='swiper']",
      "[class*='media-container']",
      "[class*='video-player']",
      "video",
    ].join(", ");
    const media = page.locator(mediaSelector).first();
    if ((await media.count()) > 0) {
      await media.scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(600);
    } else {
      await page
        .locator(mediaSelector)
        .first()
        .waitFor({ state: "attached", timeout: 2_500 })
        .catch(() => undefined);
    }

    const extracted = await page.evaluate(() => {
      const selectors = {
        title: [
          "#detail-title",
          "[data-testid='note-title']",
          ".note-content .title",
          "[class*='note-content'] [class*='title']",
        ],
        body: [
          "#detail-desc",
          "[data-testid='note-content']",
          ".note-content .desc",
          "[class*='note-content'] [class*='desc']",
        ],
        author: [
          "[data-testid='author-name']",
          ".author-wrapper .username",
          "[class*='author'] [class*='name']",
        ],
        topics: [
          "a#hash-tag",
          "a[href*='/search_result']",
          "a[href*='/search_result'][class*='topic']",
          "a[href*='keyword=']",
          "[data-testid='hashtag']",
        ],
        media: [
          "[data-testid='note-media']",
          ".note-slider",
          ".slider-container",
          ".swiper-container",
          ".swiper",
          "[class*='note-slider']",
          "[class*='carousel']",
          "[class*='swiper']",
          "[class*='media-container']",
          "[class*='video-player']",
          "video",
        ],
      };

      const firstText = (items: string[]) => {
        for (const selector of items) {
          const value = document.querySelector(selector)?.textContent?.trim();
          if (value) return value;
        }
        return "";
      };
      const all = (items: string[]) => {
        const seen = new Set<Element>();
        const elements: Element[] = [];
        for (const selector of items) {
          for (const element of document.querySelectorAll(selector)) {
            if (!seen.has(element)) {
              seen.add(element);
              elements.push(element);
            }
          }
        }
        return elements;
      };
      const domPath = (element: Element) => {
        if (element.id) return `#${CSS.escape(element.id)}`;
        const tag = element.tagName.toLowerCase();
        const classes = [...element.classList]
          .slice(0, 2)
          .map((item) => `.${CSS.escape(item)}`)
          .join("");
        return `${tag}${classes}`;
      };

      const visibleText = document.body?.innerText || "";
      let pageStatus: PageStatus = "NORMAL";
      if (/登录后查看|请先登录|登录已过期|登录以继续/.test(visibleText)) {
        pageStatus = "LOGIN_EXPIRED";
      } else if (/验证码|安全验证|完成验证|滑块验证/.test(visibleText)) {
        pageStatus = "SECURITY_VERIFICATION";
      } else if (/笔记已删除|内容已删除|作者已删除/.test(visibleText)) {
        pageStatus = "NOTE_NOT_FOUND";
      } else if (/内容不存在|笔记不存在|页面不存在/.test(visibleText)) {
        pageStatus = "NOTE_NOT_FOUND";
      } else if (/暂无权限|无权查看|仅作者可见/.test(visibleText)) {
        pageStatus = "NO_PERMISSION";
      }

      const topics = all(selectors.topics)
        .filter((element) => (element.textContent || "").trim().startsWith("#"))
        .map((element) => {
          const style = getComputedStyle(element);
          const href = element.getAttribute("href");
          const tag = element.tagName.toLowerCase();
          const role = element.getAttribute("role");
          return {
            displayText: (element.textContent || "").trim(),
            isLinkElement:
              tag === "a" ||
              tag === "button" ||
              role === "link" ||
              element.hasAttribute("onclick") ||
              (element as HTMLElement).tabIndex >= 0,
            hasHref: Boolean(href && !href.startsWith("javascript:")),
            href: href ? new URL(href, location.href).href : null,
            textColor: style.color,
            styleFeature:
              element.matches(".topic, [class*='topic'], [class*='hashtag']") ||
              style.cursor === "pointer",
            domPath: domPath(element),
          };
        });
      const noteId =
        location.pathname.match(
          /\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/,
        )?.[1] || null;

      const excludedSelector = [
        "header",
        "nav",
        "footer",
        "[class*='avatar']",
        "[class*='comment']",
        "[class*='recommend']",
        "[class*='related']",
        "[class*='icon']",
        "[class*='emoji']",
        "[class*='sticker']",
        "[class*='decoration']",
      ].join(",");
      const mediaRoots = all(selectors.media).filter(
        (element) => !element.closest(excludedSelector),
      );
      const hasVideo = mediaRoots.some((root) =>
        root.matches("video, [class*='video-player']")
          ? true
          : Boolean(root.querySelector("video, [class*='video-player']")),
      );

      const normalizeMediaUrl = (value: string) => {
        const candidate = value.trim().split(/\s+/)[0];
        if (
          !candidate ||
          candidate.startsWith("data:image/svg") ||
          candidate.includes("avatar") ||
          candidate.includes("emoji") ||
          candidate.includes("icon")
        ) {
          return "";
        }
        try {
          const parsed = new URL(candidate, location.href);
          parsed.hash = "";
          for (const key of [...parsed.searchParams.keys()]) {
            if (/^(x-oss|imageMogr|imageView|width|height|w|h|quality|q)$/i.test(key)) {
              parsed.searchParams.delete(key);
            }
          }
          return parsed.href;
        } catch {
          return candidate;
        }
      };
      const elementUrls = (element: Element) => {
        const values = new Set<string>();
        for (const attribute of [
          "src",
          "data-src",
          "data-original",
          "data-lazy-src",
        ]) {
          const value = element.getAttribute(attribute);
          if (value) values.add(normalizeMediaUrl(value));
        }
        for (const attribute of ["srcset", "data-srcset"]) {
          const value = element.getAttribute(attribute);
          if (value) {
            for (const item of value.split(",")) {
              values.add(normalizeMediaUrl(item));
            }
          }
        }
        if (element instanceof HTMLImageElement && element.currentSrc) {
          values.add(normalizeMediaUrl(element.currentSrc));
        }
        const background = getComputedStyle(element).backgroundImage;
        for (const match of background.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
          values.add(normalizeMediaUrl(match[2]));
        }
        values.delete("");
        return [...values];
      };
      const countImages = (root: Element) => {
        const nodes = [
          ...(root.matches(
            "img, picture, source, [data-src], [data-original], [data-lazy-src], [srcset], [style*='background-image']",
          )
            ? [root]
            : []),
          ...root.querySelectorAll(
            "img, picture, source, [data-src], [data-original], [data-lazy-src], [srcset], [style*='background-image']",
          ),
        ].filter(
          (element) =>
            !element.closest(excludedSelector) &&
            !element.matches("[aria-hidden='true'], [role='presentation']"),
        );
        const unique = new Set<string>();
        const pictureIds = new Map<Element, number>();
        for (const element of nodes) {
          const urls = elementUrls(element);
          if (!urls.length) continue;
          const slide = element.closest(
            "[data-swiper-slide-index], [data-index], [class*='swiper-slide'], [class*='carousel-item'], [class*='slide-item']",
          );
          const slideIndex =
            slide?.getAttribute("data-swiper-slide-index") ||
            slide?.getAttribute("data-index");
          if (slideIndex !== null && slideIndex !== undefined) {
            unique.add(`slide:${slideIndex}`);
          } else {
            const picture = element.closest("picture");
            if (picture) {
              if (!pictureIds.has(picture)) {
                pictureIds.set(picture, pictureIds.size);
              }
              unique.add(`picture:${pictureIds.get(picture)}`);
            } else {
              unique.add(`url:${urls[0]}`);
            }
          }
        }
        return unique.size;
      };

      let noteType: "IMAGE_TEXT" | "VIDEO_NOTE" | "UNKNOWN" = "UNKNOWN";
      let imageExtractionStatus:
        | "SUCCESS"
        | "VIDEO_NOTE"
        | "IMAGES_READ_FAILED" = "IMAGES_READ_FAILED";
      let imageCount: number | undefined;
      if (hasVideo) {
        noteType = "VIDEO_NOTE";
        imageExtractionStatus = "VIDEO_NOTE";
      } else {
        const counts = mediaRoots.map(countImages);
        const detectedCount = counts.length ? Math.max(...counts) : 0;
        if (detectedCount > 0) {
          noteType = "IMAGE_TEXT";
          imageExtractionStatus = "SUCCESS";
          imageCount = detectedCount;
        }
      }

      return {
        noteId,
        title: firstText(selectors.title) || null,
        body: firstText(selectors.body) || null,
        topics,
        pageStatus,
        isPublic: pageStatus === "NORMAL",
        authorName: firstText(selectors.author) || null,
        noteType,
        imageExtractionStatus,
        imageCount,
      };
    });

    return {
      url: originalUrl,
      finalUrl: page.url(),
      pageTitle: await page.title(),
      pageType: "NOTE_DETAIL",
      ...extracted,
      publishedAt: null,
      extractedAt: new Date().toISOString(),
      adapterName: this.name,
      adapterVersion: this.version,
    };
  }
}

export const playwrightAdapters: PlaywrightExtractorAdapter[] = [
  new PlaywrightMockAdapter(),
  new PlaywrightXiaohongshuAdapter(),
];
