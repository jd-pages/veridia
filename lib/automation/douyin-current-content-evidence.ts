import type { Page } from "playwright";

export type DouyinCurrentContentScopeKind =
  | "DATA_E2E_NOTE_DETAIL"
  | "DATA_TESTID_NOTE_DETAIL"
  | "CURRENT_MEDIA_ANCESTOR"
  | "NONE";

export type DouyinCurrentContentEvidence = {
  scopeKind: DouyinCurrentContentScopeKind;
  scopeSelector: string | null;
  scopeIndex: number;
  hasExplicitRoot: boolean;
  carouselMarkerCount: number;
  imageCount: number;
  videoCount: number;
  descriptionLength: number;
  hasAuthor: boolean;
  actionBarControlCount: number;
  hasStructuredCurrentContent: boolean;
  contentIdInScope: boolean;
  contentIdInDocument: boolean;
  contentIdMatches: boolean;
  hasCurrentDomEvidence: boolean;
  hasContentEvidence: boolean;
  terminalMarker: "NOTE_NOT_FOUND" | "SECURITY_RESTRICTED" | "LOGIN_REQUIRED" | null;
};

const EMPTY_EVIDENCE: DouyinCurrentContentEvidence = {
  scopeKind: "NONE",
  scopeSelector: null,
  scopeIndex: -1,
  hasExplicitRoot: false,
  carouselMarkerCount: 0,
  imageCount: 0,
  videoCount: 0,
  descriptionLength: 0,
  hasAuthor: false,
  actionBarControlCount: 0,
  hasStructuredCurrentContent: false,
  contentIdInScope: false,
  contentIdInDocument: false,
  contentIdMatches: false,
  hasCurrentDomEvidence: false,
  hasContentEvidence: false,
  terminalMarker: null,
};

export async function readDouyinCurrentContentEvidence(
  page: Page,
  expectedContentId?: string | null,
): Promise<DouyinCurrentContentEvidence> {
  return page.evaluate((expectedId) => {
    const explicitRoots = [
      {
        selector: "[data-e2e='note-detail']",
        kind: "DATA_E2E_NOTE_DETAIL" as const,
      },
      {
        selector: "[data-testid='douyin-note-detail']",
        kind: "DATA_TESTID_NOTE_DETAIL" as const,
      },
    ];
    const excludedSelector = [
      "[class*='comment']",
      "[data-e2e*='comment']",
      "[data-testid*='comment']",
      "[class*='recommend']",
      "[data-e2e*='recommend']",
      "[data-testid*='recommend']",
      "[class*='related']",
      "[data-e2e*='related']",
      "[data-testid*='related']",
    ].join(", ");
    const carouselSelector = [
      "[class*='dySwiper']",
      "[data-testid='douyin-image-carousel']",
      "[data-testid='douyin-carousel']",
      "[data-e2e='slide']",
      "[data-testid='douyin-image']",
    ].join(", ");
    const currentPlayerVideoSelector = [
      "[data-e2e='player-container'] video",
      "[data-e2e='video-player'] video",
      "[data-testid='douyin-video-player'] video",
    ].join(", ");
    const descriptionSelector = [
      "[data-e2e='video-desc']",
      "[data-e2e='aweme-desc']",
      "[data-e2e='video-title']",
      "[data-e2e='detail-desc']",
      "[data-testid='douyin-description']",
      "[class~='video-playing-item'] h3",
      "[class*='video-info'] [class*='desc']",
      "[class*='note-detail'] [class*='desc']",
    ].join(", ");
    const authorSelector = [
      "[data-e2e='video-author-name']",
      "[data-e2e='user-info']",
      "[data-testid='douyin-author']",
    ].join(", ");
    const actionSelector = [
      "[data-e2e='video-player-digg']",
      "[data-e2e='video-player-collect']",
      "[data-e2e='feed-comment-icon']",
      "[data-e2e='video-player-share']",
      "[data-testid='douyin-action-bar']",
    ].join(", ");

    let scope: Element | null = null;
    let scopeKind: DouyinCurrentContentScopeKind = "NONE";
    let scopeSelector: string | null = null;
    for (const candidate of explicitRoots) {
      const root = document.querySelector(candidate.selector);
      if (!root) continue;
      scope = root;
      scopeKind = candidate.kind;
      scopeSelector = candidate.selector;
      break;
    }

    const eligibleCarouselMarkers = Array.from(
      document.querySelectorAll(carouselSelector),
    ).filter((element) => !element.closest(excludedSelector));
    const eligibleCurrentPlayerVideos = Array.from(
      document.querySelectorAll(currentPlayerVideoSelector),
    ).filter((element) => !element.closest(excludedSelector));
    const eligibleMediaMarkers = [
      ...eligibleCarouselMarkers,
      ...eligibleCurrentPlayerVideos,
    ];
    if (!scope && eligibleMediaMarkers.length) {
      const ancestors = [...new Set(
        eligibleMediaMarkers
          .map((element) => element.closest("main, article"))
          .filter((element): element is Element => Boolean(element)),
      )];
      if (ancestors.length === 1) {
        scope = ancestors[0];
        scopeSelector = scope.tagName.toLowerCase();
        scopeKind = "CURRENT_MEDIA_ANCESTOR";
      }
    }

    const scopeIndex = scope && scopeSelector
      ? Array.from(document.querySelectorAll(scopeSelector)).indexOf(scope)
      : -1;
    const scopedCarouselMarkers = scope
      ? eligibleCarouselMarkers.filter((element) => scope?.contains(element))
      : [];
    const images = scope
      ? Array.from(scope.querySelectorAll(
          "[class*='dySwiperSlide'] img, [data-e2e='slide'] img, [data-testid='douyin-image-carousel'] img, [data-testid='douyin-image']",
        )).filter((element) => !element.closest(excludedSelector))
      : [];
    const videos = scope
      ? Array.from(scope.querySelectorAll("video")).filter((element) => {
          if (element.closest(excludedSelector)) return false;
          if (scopeKind !== "CURRENT_MEDIA_ANCESTOR") return true;
          return Boolean(element.closest(
            "[data-e2e='player-container'], [data-e2e='video-player'], [data-testid='douyin-video-player']",
          ));
        })
      : [];
    const description = scope?.querySelector(descriptionSelector)?.textContent?.trim() || "";
    const hasAuthor = Boolean(scope?.querySelector(authorSelector));
    const actionBarControlCount = scope
      ? scope.querySelectorAll(actionSelector).length
      : 0;

    const scripts = Array.from(document.querySelectorAll(
      "script[type='application/json'], script[type='application/ld+json'], script#__RENDER_DATA__, script#RENDER_DATA, script:not([type])",
    ));
    const hasStructuredCurrentContent = Boolean(
      expectedId && scripts.some((script) =>
        (script.textContent || "").includes(expectedId)
      ),
    );
    const bodyHtml = document.body?.innerHTML || "";
    const contentIdInScope = Boolean(
      expectedId && scope?.innerHTML.includes(expectedId),
    );
    const contentIdInDocument = Boolean(
      expectedId && bodyHtml.includes(expectedId),
    );
    let locationContentId: string | null = null;
    try {
      locationContentId = location.pathname.match(
        /^\/(?:share\/)?(?:video|note|slides)\/([^/?#]+)/iu,
      )?.[1] || null;
    } catch {
      locationContentId = null;
    }
    const contentIdMatches = !expectedId ||
      locationContentId === expectedId ||
      contentIdInScope ||
      hasStructuredCurrentContent;

    const isImageTextUrl = /\/(?:note|slides)\//iu.test(location.pathname);
    const isVideoUrl = /\/video\//iu.test(location.pathname);
    const hasImageEvidence = scopedCarouselMarkers.length > 0 || images.length > 0;
    const metadataWitnessCount = [
      description.length > 0,
      hasAuthor,
      actionBarControlCount >= 2,
      hasStructuredCurrentContent,
    ].filter(Boolean).length;
    const mediaMatchesUrl = isImageTextUrl
      ? hasImageEvidence
      : isVideoUrl
        ? videos.length > 0
        : hasImageEvidence || videos.length > 0;
    const hasCurrentDomEvidence = Boolean(
      scope && (
        scopeKind === "CURRENT_MEDIA_ANCESTOR"
          ? mediaMatchesUrl && metadataWitnessCount >= 2
          : mediaMatchesUrl || description.length > 0
      ),
    );

    const visibleText = document.body?.innerText || "";
    const terminalMarker = /你要观看的(?:图文|视频|作品|内容)不存在|你要查看的(?:图文|视频|作品|内容)不存在|作品不存在|作品已删除/u.test(visibleText)
      ? "NOTE_NOT_FOUND" as const
      : /安全验证|访问频繁|验证码/u.test(visibleText)
        ? "SECURITY_RESTRICTED" as const
        : /登录后继续/u.test(visibleText)
          ? "LOGIN_REQUIRED" as const
          : null;

    return {
      scopeKind,
      scopeSelector,
      scopeIndex,
      hasExplicitRoot: scopeKind === "DATA_E2E_NOTE_DETAIL" ||
        scopeKind === "DATA_TESTID_NOTE_DETAIL",
      carouselMarkerCount: scopedCarouselMarkers.length,
      imageCount: images.length,
      videoCount: videos.length,
      descriptionLength: description.length,
      hasAuthor,
      actionBarControlCount,
      hasStructuredCurrentContent,
      contentIdInScope,
      contentIdInDocument,
      contentIdMatches,
      hasCurrentDomEvidence,
      hasContentEvidence: contentIdMatches && hasCurrentDomEvidence,
      terminalMarker,
    } satisfies DouyinCurrentContentEvidence;
  }, expectedContentId || null).catch(() => ({ ...EMPTY_EVIDENCE }));
}

export async function waitForDouyinCurrentContentEvidence(
  page: Page,
  expectedContentId: string | null,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await readDouyinCurrentContentEvidence(page, expectedContentId);
  while (
    !latest.hasContentEvidence &&
    !latest.terminalMarker &&
    Date.now() < deadline
  ) {
    await page.waitForTimeout(150);
    latest = await readDouyinCurrentContentEvidence(page, expectedContentId);
  }
  return latest;
}
