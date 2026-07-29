(function registerXiaohongshu(global) {
  const namespace = global.XhsAdapters;

  // 页面结构变化时，优先维护这一组选择器，不要在其他文件复制选择器。
  const SELECTORS = {
    title: [
      "#detail-title",
      "[data-testid='note-title']",
      ".note-content .title",
      "[class*='note-content'] [class*='title']"
    ],
    body: [
      "#detail-desc",
      "[data-testid='note-content']",
      ".note-content .desc",
      "[class*='note-content'] [class*='desc']"
    ],
    author: [
      "[data-testid='author-name']",
      ".author-wrapper .username",
      "[class*='author'] [class*='name']"
    ],
    publishedAt: [
      "[data-testid='publish-time']",
      ".note-content .date",
      "[class*='publish'] [class*='time']"
    ],
    topics: [
      "a[href*='/search_result'][class*='topic']",
      "a[href*='keyword=']",
      "[data-testid='hashtag']"
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
      "video"
    ]
  };

  namespace.XiaohongshuExtractorAdapter = class XiaohongshuExtractorAdapter extends namespace.BaseExtractorAdapter {
    constructor() {
      super("xiaohongshu-visible-page", "1.2.0");
    }

    canHandle() {
      return location.hostname.endsWith("xiaohongshu.com");
    }

    firstText(selectors) {
      for (const selector of selectors) {
        const value = this.text(selector);
        if (value) return value;
      }
      return "";
    }

    all(selectors) {
      const seen = new Set();
      const elements = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (!seen.has(element)) {
            seen.add(element);
            elements.push(element);
          }
        }
      }
      return elements;
    }

    noteId() {
      const match = location.pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/);
      return match?.[1] || null;
    }

    imageSummary() {
      const excluded = [
        "header", "nav", "footer", "[class*='avatar']", "[class*='comment']",
        "[class*='recommend']", "[class*='related']", "[class*='icon']",
        "[class*='emoji']", "[class*='sticker']", "[class*='decoration']"
      ].join(",");
      const roots = this.all(SELECTORS.media).filter((element) => !element.closest(excluded));
      const hasVideo = roots.some((root) =>
        root.matches("video, [class*='video-player']") ||
        root.querySelector("video, [class*='video-player']")
      );
      if (hasVideo) {
        return {
          noteType: "VIDEO_NOTE",
          imageExtractionStatus: "VIDEO_NOTE"
        };
      }

      const normalizeUrl = (value) => {
        const candidate = String(value || "").trim().split(/\s+/)[0];
        if (
          !candidate ||
          candidate.startsWith("data:image/svg") ||
          /avatar|emoji|icon/i.test(candidate)
        ) return "";
        try {
          const url = new URL(candidate, location.href);
          url.hash = "";
          for (const key of [...url.searchParams.keys()]) {
            if (/^(x-oss|imageMogr|imageView|width|height|w|h|quality|q)$/i.test(key)) {
              url.searchParams.delete(key);
            }
          }
          return url.href;
        } catch {
          return candidate;
        }
      };
      const urlsFor = (element) => {
        const urls = new Set();
        for (const attribute of ["src", "data-src", "data-original", "data-lazy-src"]) {
          const value = element.getAttribute(attribute);
          if (value) urls.add(normalizeUrl(value));
        }
        for (const attribute of ["srcset", "data-srcset"]) {
          const value = element.getAttribute(attribute);
          if (value) {
            for (const item of value.split(",")) urls.add(normalizeUrl(item));
          }
        }
        if (element.currentSrc) urls.add(normalizeUrl(element.currentSrc));
        const background = getComputedStyle(element).backgroundImage;
        for (const match of background.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
          urls.add(normalizeUrl(match[2]));
        }
        urls.delete("");
        return [...urls];
      };
      const countInRoot = (root) => {
        const selector =
          "img, picture, source, [data-src], [data-original], [data-lazy-src], [srcset], [style*='background-image']";
        const nodes = [
          ...(root.matches(selector) ? [root] : []),
          ...root.querySelectorAll(selector)
        ].filter((element) =>
          !element.closest(excluded) &&
          !element.matches("[aria-hidden='true'], [role='presentation']")
        );
        const unique = new Set();
        const pictureIds = new Map();
        for (const element of nodes) {
          const urls = urlsFor(element);
          if (!urls.length) continue;
          const slide = element.closest(
            "[data-swiper-slide-index], [data-index], [class*='swiper-slide'], [class*='carousel-item'], [class*='slide-item']"
          );
          const index =
            slide?.getAttribute("data-swiper-slide-index") ||
            slide?.getAttribute("data-index");
          if (index != null) {
            unique.add(`slide:${index}`);
          } else {
            const picture = element.closest("picture");
            if (picture) {
              if (!pictureIds.has(picture)) pictureIds.set(picture, pictureIds.size);
              unique.add(`picture:${pictureIds.get(picture)}`);
            } else {
              unique.add(`url:${urls[0]}`);
            }
          }
        }
        return unique.size;
      };
      const count = roots.length ? Math.max(...roots.map(countInRoot)) : 0;
      return count > 0
        ? {
            noteType: "IMAGE_TEXT",
            imageExtractionStatus: "SUCCESS",
            imageCount: count
          }
        : {
            noteType: "UNKNOWN",
            imageExtractionStatus: "IMAGES_READ_FAILED"
          };
    }

    extract() {
      const pageStatus = this.pageStatus();
      const topics = this.all(SELECTORS.topics)
        .filter((element) => (element.textContent || "").trim().startsWith("#"))
        .map((element) => this.toTopic(element));
      return this.result({
        noteId: this.noteId(),
        title: this.firstText(SELECTORS.title),
        body: this.firstText(SELECTORS.body),
        topics,
        pageStatus,
        isPublic: pageStatus === "NORMAL",
        authorName: this.firstText(SELECTORS.author),
        publishedAt: this.firstText(SELECTORS.publishedAt) || null,
        ...this.imageSummary(),
      });
    }
  };

  namespace.XIAOHONGSHU_SELECTORS = SELECTORS;
})(globalThis);
