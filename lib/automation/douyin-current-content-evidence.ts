import type { Page } from "playwright";

export type DouyinCurrentContentScopeKind =
  | "DATA_E2E_NOTE_DETAIL"
  | "DATA_TESTID_NOTE_DETAIL"
  | "DATA_E2E_VIDEO_DETAIL"
  | "DATA_TESTID_VIDEO_DETAIL"
  | "CURRENT_MEDIA_ANCESTOR"
  | "NONE";

export type DouyinStructuredTargetEvidence = {
  contentId: string;
  hasPayload: boolean;
  source?: "NETWORK_RESPONSE" | "PAGE_SCRIPT" | null;
};

export type DouyinCurrentContentEvidence = {
  scopeKind: DouyinCurrentContentScopeKind;
  scopeSelector: string | null;
  scopeIndex: number;
  scopeToken?: string | null;
  scopeContentId?: string | null;
  hasExplicitRoot: boolean;
  carouselMarkerCount: number;
  imageCount: number;
  videoCount: number;
  descriptionLength: number;
  hasAuthor: boolean;
  actionBarControlCount: number;
  hasStructuredCurrentContent: boolean;
  structuredTargetContentId: string | null;
  hasStructuredTargetPayload: boolean;
  hasBoundPageMetadata: boolean;
  currentVideoCandidateCount: number;
  conflictingVisibleContentIds: string[];
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
  structuredTargetContentId: null,
  hasStructuredTargetPayload: false,
  hasBoundPageMetadata: false,
  currentVideoCandidateCount: 0,
  conflictingVisibleContentIds: [],
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
  structuredTargetEvidence?: DouyinStructuredTargetEvidence | null,
): Promise<DouyinCurrentContentEvidence> {
  return page.evaluate((input) => {
    const expectedId = input.expectedContentId;
    const structuredTarget = input.structuredTargetEvidence;
    const explicitRoots = [
      {
        selector: "[data-e2e='note-detail']",
        kind: "DATA_E2E_NOTE_DETAIL" as const,
      },
      {
        selector: "[data-testid='douyin-note-detail']",
        kind: "DATA_TESTID_NOTE_DETAIL" as const,
      },
      {
        selector: "[data-e2e='video-detail']",
        kind: "DATA_E2E_VIDEO_DETAIL" as const,
      },
      {
        selector: "[data-testid='douyin-video-detail']",
        kind: "DATA_TESTID_VIDEO_DETAIL" as const,
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
      "[data-clone='true']",
      "[data-preload='true']",
      "[data-testid*='preload']",
      "[class*='preload']",
      "[class*='clone']",
      "[class*='swiper-slide-duplicate']",
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

    const identityAttributes = [
      "data-content-id", "data-aweme-id", "data-item-id", "data-note-id",
      "data-video-id", "data-awemeid", "data-contentid", "data-itemid",
    ];
    const identitySelector = identityAttributes.map((key) => `[${key}]`).join(", ");
    const isVisible = (element: Element) => {
      for (let current: Element | null = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (current.hasAttribute("hidden") || current.hasAttribute("inert") ||
            current.getAttribute("aria-hidden") === "true" ||
            style.display === "none" || style.visibility === "hidden" ||
            style.visibility === "collapse" || style.opacity === "0" ||
            style.contentVisibility === "hidden") return false;
      }
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
        rect.top < innerHeight && rect.left < innerWidth;
    };
    const idsForScope = (root: Element) => {
      const ids = new Set<string>();
      const nodes = [root, ...Array.from(root.querySelectorAll(identitySelector))];
      // Detail markup may put identity on its surrounding current-item wrapper.
      const owner = root.parentElement?.closest(identitySelector);
      if (owner && !owner.closest(excludedSelector)) nodes.push(owner);
      for (const node of nodes) {
        if (node.closest(excludedSelector) ||
            (node !== root && !isVisible(node))) continue;
        for (const attribute of identityAttributes) {
          const value = node.getAttribute(attribute)?.trim();
          if (value) ids.add(value);
        }
      }
      return ids;
    };
    const locationContentId = location.pathname.match(
      /^\/(?:share\/)?(?:video|note|slides)\/([^/?#]+)/iu,
    )?.[1] || new URL(location.href).searchParams.get("modal_id") || null;
    const targetId = expectedId || locationContentId;
    const locationMatches = !expectedId || !locationContentId || locationContentId === expectedId;
    const structuredTargetMatches = Boolean(
      targetId && structuredTarget?.hasPayload &&
      structuredTarget.contentId === targetId && locationMatches,
    );
    const pageMetadataUrls = [
      document.querySelector("link[rel='canonical']")?.getAttribute("href"),
      document.querySelector("meta[property='og:url']")?.getAttribute("content"),
    ].filter((value): value is string => Boolean(value));
    const pageMetadataIds = pageMetadataUrls.map((value) => {
      try {
        return new URL(value, location.href).pathname.match(
          /^\/(?:share\/)?(?:video|note|slides)\/([^/?#]+)/iu,
        )?.[1] || null;
      } catch {
        return null;
      }
    }).filter((value): value is string => Boolean(value));
    const metadataIdentityMatches = Boolean(
      targetId && pageMetadataIds.length > 0 &&
      pageMetadataIds.every((value) => value === targetId),
    );
    const metadataDescription = (
      document.querySelector("meta[property='og:description']") ||
      document.querySelector("meta[name='description']")
    )?.getAttribute("content")?.trim() || "";
    const meaningfulTitle = document.title.trim() &&
      !/^抖音(?:，记录美好生活)?$/u.test(document.title.trim());
    const hasBoundPageMetadata = Boolean(
      metadataIdentityMatches && (meaningfulTitle || metadataDescription),
    );
    const candidates = explicitRoots.flatMap((candidate) =>
      Array.from(document.querySelectorAll(candidate.selector)).filter((root) =>
        !root.closest(excludedSelector) && isVisible(root),
      ).map((root) => ({ ...candidate, root, ids: idsForScope(root) })),
    ).filter((candidate, index, all) => all.findIndex((item) => item.root === candidate.root) === index);
    const matching = candidates.filter((candidate) =>
      candidate.ids.size === 1 && Boolean(targetId && candidate.ids.has(targetId)),
    );
    const unknown = candidates.filter((candidate) => candidate.ids.size === 0);
    // Do not let a broad wrapper compete with a more specific matching detail.
    const mostSpecific = matching.filter((candidate) =>
      !matching.some((other) => other.root !== candidate.root && candidate.root.contains(other.root)),
    );
    const chosen = locationMatches && mostSpecific.length === 1
      ? mostSpecific[0]
      : locationMatches && !matching.length && unknown.length === 1 &&
          candidates.length === 1 && (!targetId || locationContentId === targetId)
        ? unknown[0]
        : null;
    let scope: Element | null = chosen?.root ?? null;
    let scopeKind: DouyinCurrentContentScopeKind = "NONE";
    let scopeSelector: string | null = null;
    if (chosen) {
      scopeKind = chosen.kind;
      scopeSelector = chosen.selector;
    }

    const eligibleCarouselMarkers = Array.from(
      document.querySelectorAll(carouselSelector),
    ).filter((element) => !element.closest(excludedSelector) && isVisible(element));
    const eligibleCurrentPlayerVideos = Array.from(
      document.querySelectorAll(
        structuredTargetMatches && hasBoundPageMetadata
          ? `video, ${currentPlayerVideoSelector}`
          : currentPlayerVideoSelector,
      ),
    ).filter((element) => !element.closest(excludedSelector) && isVisible(element));
    const eligibleMediaMarkers = [
      ...eligibleCarouselMarkers,
      ...eligibleCurrentPlayerVideos,
    ];
    if (!scope && !candidates.length && locationMatches && eligibleMediaMarkers.length) {
      const ancestors = [...new Set(
        eligibleMediaMarkers
          .map((element) => element.closest("main, article"))
          .filter((element): element is Element => Boolean(element && isVisible(element))),
      )];
      const eligibleAncestors = ancestors.filter((element) => {
        const ids = idsForScope(element);
        return ids.size === 0 ? !targetId || locationContentId === targetId
          : ids.size === 1 && Boolean(targetId && ids.has(targetId));
      });
      if (eligibleAncestors.length === 1) {
        scope = eligibleAncestors[0];
        scopeSelector = scope.tagName.toLowerCase();
        scopeKind = "CURRENT_MEDIA_ANCESTOR";
      } else if (
        eligibleAncestors.length === 0 && structuredTargetMatches &&
        hasBoundPageMetadata && eligibleCurrentPlayerVideos.length === 1
      ) {
        const mediaContainer = eligibleCurrentPlayerVideos[0].parentElement;
        if (
          mediaContainer && isVisible(mediaContainer) &&
          !mediaContainer.closest(excludedSelector)
        ) {
          const ids = idsForScope(mediaContainer);
          if (
            ids.size === 0 ||
            ids.size === 1 && Boolean(targetId && ids.has(targetId))
          ) {
            scope = mediaContainer;
            // A generated scope-token selector below binds collection to this
            // exact node without depending on the drift-prone class name.
            scopeKind = "CURRENT_MEDIA_ANCESTOR";
          }
        }
      }
    }

    const currentNode = (element: Element) => {
      const detail = element.closest("[data-e2e='note-detail'], [data-testid='douyin-note-detail']");
      return !element.closest(excludedSelector) && (!detail || detail === scope) && isVisible(element);
    };
    const scopedCarouselMarkers = scope
      ? eligibleCarouselMarkers.filter((element) => scope?.contains(element) && currentNode(element))
      : [];
    const images = scope
      ? Array.from(scope.querySelectorAll(
          "[class*='dySwiperSlide'] img, [data-e2e='slide'] img, [data-testid='douyin-image-carousel'] img, [data-testid='douyin-image']",
        )).filter(currentNode)
      : [];
    const videos = scope
      ? Array.from(scope.querySelectorAll("video")).filter((element) => {
          if (!currentNode(element)) return false;
          if (scopeKind !== "CURRENT_MEDIA_ANCESTOR") return true;
          return structuredTargetMatches && hasBoundPageMetadata || Boolean(element.closest(
            "[data-e2e='player-container'], [data-e2e='video-player'], [data-testid='douyin-video-player']",
          ));
        })
      : [];
    const description = scope ? Array.from(scope.querySelectorAll(descriptionSelector)).find(currentNode)?.textContent?.trim() || "" : "";
    const hasAuthor = Boolean(scope && Array.from(scope.querySelectorAll(authorSelector)).some(currentNode));
    const actionBarControlCount = scope
      ? Array.from(scope.querySelectorAll(actionSelector)).filter(currentNode).length
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
    const scopeIds = scope ? idsForScope(scope) : new Set<string>();
    const contentIdInScope = Boolean(targetId && scopeIds.has(targetId));
    const contentIdInDocument = Boolean(
      expectedId && bodyHtml.includes(expectedId),
    );
    const contentIdMatches = Boolean(scope && locationMatches &&
      (scopeIds.size ? scopeIds.size === 1 && contentIdInScope
        : !targetId || locationContentId === targetId));

    const isImageTextUrl = /\/(?:note|slides)\//iu.test(location.pathname);
    const isVideoUrl = /\/video\//iu.test(location.pathname);
    const hasImageEvidence = scopedCarouselMarkers.length > 0 || images.length > 0;
    const metadataWitnessCount = [
      description.length > 0,
      hasAuthor,
      actionBarControlCount >= 2,
    ].filter(Boolean).length;
    const mediaMatchesUrl = isImageTextUrl
      ? hasImageEvidence
      : isVideoUrl
        ? videos.length > 0
        : hasImageEvidence || videos.length > 0;
    const scopeVisibleIds = scope ? idsForScope(scope) : new Set<string>();
    const conflictingVisibleContentIds = [...scopeVisibleIds].filter((value) =>
      Boolean(targetId && value !== targetId),
    );
    const structuredVideoWitness = Boolean(
      scopeKind === "CURRENT_MEDIA_ANCESTOR" && isVideoUrl &&
      structuredTargetMatches && hasBoundPageMetadata &&
      videos.length === 1 && conflictingVisibleContentIds.length === 0,
    );
    const hasCurrentDomEvidence = Boolean(
      scope && (
        scopeKind === "CURRENT_MEDIA_ANCESTOR"
          ? mediaMatchesUrl && (metadataWitnessCount >= 2 || structuredVideoWitness)
          : mediaMatchesUrl || description.length > 0
      ),
    );
    // The adapter validates this exact selected node again. A recycled selector
    // index after SPA navigation must not silently identify another detail.
    const scopeToken = scope ? `${Date.now()}-${Math.random().toString(36).slice(2)}` : null;
    if (scope && scopeToken) scope.setAttribute("data-veridia-douyin-scope", scopeToken);
    if (scope && scopeToken && !scopeSelector) {
      scopeSelector = `[data-veridia-douyin-scope='${scopeToken}']`;
    }
    const scopeIndex = scope && scopeSelector
      ? Array.from(document.querySelectorAll(scopeSelector)).indexOf(scope)
      : -1;

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
      scopeToken,
      scopeContentId: scopeIds.size === 1 ? [...scopeIds][0] : null,
      hasExplicitRoot: scopeKind === "DATA_E2E_NOTE_DETAIL" ||
        scopeKind === "DATA_TESTID_NOTE_DETAIL" ||
        scopeKind === "DATA_E2E_VIDEO_DETAIL" ||
        scopeKind === "DATA_TESTID_VIDEO_DETAIL",
      carouselMarkerCount: scopedCarouselMarkers.length,
      imageCount: images.length,
      videoCount: videos.length,
      descriptionLength: description.length,
      hasAuthor,
      actionBarControlCount,
      hasStructuredCurrentContent,
      structuredTargetContentId: structuredTarget?.contentId || null,
      hasStructuredTargetPayload: structuredTargetMatches,
      hasBoundPageMetadata,
      currentVideoCandidateCount: eligibleCurrentPlayerVideos.length,
      conflictingVisibleContentIds,
      contentIdInScope,
      contentIdInDocument,
      contentIdMatches,
      hasCurrentDomEvidence,
      hasContentEvidence: contentIdMatches && hasCurrentDomEvidence,
      terminalMarker,
    } satisfies DouyinCurrentContentEvidence;
  }, {
    expectedContentId: expectedContentId || null,
    structuredTargetEvidence: structuredTargetEvidence || null,
  }).catch(() => ({ ...EMPTY_EVIDENCE }));
}

export async function waitForDouyinCurrentContentEvidence(
  page: Page,
  expectedContentId: string | null,
  timeoutMs: number,
  structuredTargetEvidence?: DouyinStructuredTargetEvidence | null,
) {
  const deadline = Date.now() + timeoutMs;
  let latest = await readDouyinCurrentContentEvidence(
    page,
    expectedContentId,
    structuredTargetEvidence,
  );
  while (
    !latest.hasContentEvidence &&
    !latest.terminalMarker &&
    Date.now() < deadline
  ) {
    await page.waitForTimeout(150);
    latest = await readDouyinCurrentContentEvidence(
      page,
      expectedContentId,
      structuredTargetEvidence,
    );
  }
  return latest;
}
