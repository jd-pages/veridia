import type { Page } from "playwright";

export const BASIC_REWARD_MIN_INTERACTIONS = 10;

export type InteractionMetricKind = "LIKE" | "FAVORITE" | "COMMENT";

export interface InteractionMetricCandidate {
  kindHint?: InteractionMetricKind | null;
  valueText: string;
  contextText?: string;
  source?: string;
  controlClass?: string | null;
  iconHref?: string | null;
  slot?: number | null;
}

export interface InteractionMetrics {
  likeCount: number | null;
  favoriteCount: number | null;
  commentCount: number | null;
  totalCount: number | null;
  status: "SUCCESS" | "UNAVAILABLE";
  technicalMessage: string | null;
  conflictCode: "INTERACTION_COUNT_CONFLICT" | null;
  candidates: InteractionMetricCandidate[];
}

export function parseInteractionCount(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  }
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[，,]/gu, "")
    .replace(/([０-９])/gu, (digit) =>
      String.fromCharCode(digit.charCodeAt(0) - 0xfee0),
    );
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(万|[wW])?/u);
  if (!match) return null;
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  const multiplier = match[2] ? 10_000 : 1;
  return Math.round(numeric * multiplier);
}

function inferMetricKind(value: string): InteractionMetricKind | null {
  if (/点赞|获赞|\blike(?:s|d)?\b/iu.test(value)) return "LIKE";
  if (/收藏|收集|\bcollect(?:ed|ion)?\b|\bfavou?rite(?:s|d)?\b/iu.test(value)) {
    return "FAVORITE";
  }
  if (/评论|条评论|\bcomment(?:s|ed)?\b|\bchat\b/iu.test(value)) {
    return "COMMENT";
  }
  return null;
}

export function resolveInteractionMetrics(
  candidates: readonly InteractionMetricCandidate[],
): InteractionMetrics {
  const resolvedCandidates: Record<
    InteractionMetricKind,
    Array<{ value: number; candidate: InteractionMetricCandidate }>
  > = {
    LIKE: [],
    FAVORITE: [],
    COMMENT: [],
  };
  for (const candidate of candidates) {
    const context = `${candidate.contextText || ""} ${candidate.valueText}`.trim();
    const kind = candidate.kindHint || inferMetricKind(context);
    if (!kind) continue;
    const count =
      parseInteractionCount(candidate.valueText) ??
      (candidate.source?.startsWith("DOM_CURRENT_NOTE_ACTION_BAR")
        ? null
        : parseInteractionCount(candidate.contextText));
    if (count !== null) {
      resolvedCandidates[kind].push({ value: count, candidate });
    }
  }

  const currentActionCandidates = (kind: InteractionMetricKind) =>
    resolvedCandidates[kind].filter(({ candidate }) =>
      candidate.source?.startsWith("DOM_CURRENT_NOTE_ACTION_BAR"),
    );
  const selectedValue = (kind: InteractionMetricKind) =>
    currentActionCandidates(kind)[0]?.value ??
    resolvedCandidates[kind][0]?.value ??
    null;
  const actionConflicts = (Object.keys(resolvedCandidates) as InteractionMetricKind[])
    .filter((kind) => new Set(currentActionCandidates(kind).map(({ value }) => value)).size > 1);
  const commentActionValues = new Set(
    currentActionCandidates("COMMENT").map(({ value }) => value),
  );
  const commentSummaryValues = new Set(
    resolvedCandidates.COMMENT
      .filter(({ candidate }) => candidate.source === "DOM_COMMENT_SUMMARY")
      .map(({ value }) => value),
  );
  const commentSummaryConflict =
    commentActionValues.size > 0 &&
    commentSummaryValues.size > 0 &&
    [...commentActionValues].some((value) => !commentSummaryValues.has(value));
  const hasConflict = actionConflicts.length > 0 || commentSummaryConflict;

  const likeCount = selectedValue("LIKE");
  const favoriteCount = selectedValue("FAVORITE");
  const commentCount = selectedValue("COMMENT");
  const readable = [likeCount, favoriteCount, commentCount].every(
    (count) => count !== null,
  ) && !hasConflict;
  const missing = [
    likeCount === null ? "点赞数" : null,
    favoriteCount === null ? "收藏数" : null,
    commentCount === null ? "评论数" : null,
  ].filter(Boolean);

  return {
    likeCount,
    favoriteCount,
    commentCount,
    totalCount: readable
      ? Number(likeCount) + Number(favoriteCount) + Number(commentCount)
      : null,
    status: readable ? "SUCCESS" : "UNAVAILABLE",
    technicalMessage: hasConflict
      ? "INTERACTION_COUNT_CONFLICT：当前作品互动控件与独立评论总数证据不一致"
      : readable
        ? null
        : `无法完整读取${missing.join("、")}`,
    conflictCode: hasConflict ? "INTERACTION_COUNT_CONFLICT" : null,
    candidates: [...candidates].slice(0, 50),
  };
}

export async function collectXhsInteractionMetrics(
  page: Page,
): Promise<InteractionMetrics> {
  const candidates = await page.evaluate(() => {
    type BrowserCandidate = InteractionMetricCandidate;
    const output: BrowserCandidate[] = [];
    const excluded = "[class*='comment'],[class*='recommend'],[class*='related']";
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const className = (element: Element | null) =>
      element && typeof (element as HTMLElement).className === "string"
        ? String((element as HTMLElement).className).slice(0, 160)
        : "";
    const uniqueVisibleElements = (selectors: string[]) => {
      const seen = new Set<Element>();
      const elements: Element[] = [];
      for (const selector of selectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (!seen.has(element) && visible(element)) {
            seen.add(element);
            elements.push(element);
          }
        }
      }
      return elements;
    };
    const roots = uniqueVisibleElements([
      "#noteContainer",
      "[data-testid='note-detail']",
      ".note-detail-mask",
      "[class*='note-detail']",
      "article",
      ".note-content",
      "[class*='note-content']",
    ]);
    const actionBarSelectors = [
      "[data-testid='note-action-bar']",
      ".interaction-container .interactions.engage-bar .buttons.engage-bar-style",
      ".interactions.engage-bar .buttons.engage-bar-style",
      ".buttons.engage-bar-style",
    ];
    const findActionBar = (root: Element) => {
      for (const selector of actionBarSelectors) {
        const element = root.matches(selector)
          ? root
          : root.querySelector(selector);
        if (
          element &&
          visible(element) &&
          !element.closest(excluded)
        ) {
          return element;
        }
      }
      return null;
    };
    const mainNoteRoot = roots.find((root) => findActionBar(root)) || roots[0] || null;
    const actionBar = mainNoteRoot ? findActionBar(mainNoteRoot) : null;

    if (actionBar) {
      const actionGroup =
        actionBar.querySelector(":scope > .left") ||
        actionBar.querySelector(".left") ||
        actionBar;
      const controls = [...actionGroup.children].filter(
        (element) => visible(element) && !element.closest(excluded),
      );
      const allowSlotFallback = controls.length === 3;
      const slotKinds: InteractionMetricKind[] = ["LIKE", "FAVORITE", "COMMENT"];

      controls.forEach((element, slot) => {
        const svg = element.querySelector("svg");
        const use = svg?.querySelector("use");
        const iconHref =
          use?.getAttribute("href") || use?.getAttribute("xlink:href") || "";
        const attributeEvidence = [
          element.getAttribute("aria-label"),
          element.getAttribute("title"),
          element.getAttribute("data-testid"),
        ]
          .filter(Boolean)
          .join(" ");
        const classEvidence = `${className(element)} ${className(svg)}`.trim();
        const metricKind = (value: string): InteractionMetricKind | null => {
          if (/点赞|\blike(?:s|d)?\b|#like\b/iu.test(value)) return "LIKE";
          if (/收藏|\bcollect(?:ed|ion)?\b|\bfavou?rite(?:s|d)?\b|#collect\b|#star\b/iu.test(value)) {
            return "FAVORITE";
          }
          if (/评论|\bcomment(?:s|ed)?\b|\bchat\b|#chat\b|#comment\b/iu.test(value)) {
            return "COMMENT";
          }
          return null;
        };
        const attributeKind = metricKind(attributeEvidence);
        const classKind = metricKind(classEvidence);
        const iconKind = metricKind(iconHref);
        const kindHint =
          attributeKind ||
          classKind ||
          iconKind ||
          (allowSlotFallback ? slotKinds[slot] || null : null);
        if (!kindHint) return;
        const evidenceKind = attributeKind
          ? "SEMANTIC_ATTRIBUTE"
          : classKind
            ? "SEMANTIC_CLASS"
            : iconKind
              ? "SVG_ICON"
              : "VERIFIED_SLOT";
        const countElement =
          element.querySelector(":scope > .count") ||
          element.querySelector(":scope > [class*='count']");
        const valueText = (
          countElement?.textContent || element.textContent || ""
        )
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 120);
        output.push({
          kindHint,
          valueText,
          contextText: [attributeEvidence, classEvidence, iconHref]
            .filter(Boolean)
            .join(" ")
            .slice(0, 240),
          source: `DOM_CURRENT_NOTE_ACTION_BAR:${evidenceKind}`,
          controlClass: className(element) || null,
          iconHref: iconHref || null,
          slot,
        });
      });
    }

    if (mainNoteRoot) {
      const summaryPattern = /^共\s*\d+(?:\.\d+)?\s*(?:万|[wW])?\s*条评论$/u;
      const commentSummary = [
        ...mainNoteRoot.querySelectorAll(
          ".comments-container .total,[data-testid='comment-summary'],[class*='comment'] [class~='total']",
        ),
      ]
        .filter(visible)
        .map((element) => (element.textContent || "").replace(/\s+/gu, " ").trim())
        .find((value) => summaryPattern.test(value));
      if (commentSummary) {
        output.push({
          kindHint: "COMMENT",
          valueText: commentSummary,
          contextText: "当前作品评论总数",
          source: "DOM_COMMENT_SUMMARY",
        });
      }
    }
    return output;
  });
  return resolveInteractionMetrics(candidates);
}
