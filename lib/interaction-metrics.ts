import type { Page } from "playwright";

export const BASIC_REWARD_MIN_INTERACTIONS = 10;

export type InteractionMetricKind = "LIKE" | "FAVORITE" | "COMMENT";

export interface InteractionMetricCandidate {
  kindHint?: InteractionMetricKind | null;
  valueText: string;
  contextText?: string;
  source?: string;
}

export interface InteractionMetrics {
  likeCount: number | null;
  favoriteCount: number | null;
  commentCount: number | null;
  totalCount: number | null;
  status: "SUCCESS" | "UNAVAILABLE";
  technicalMessage: string | null;
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
  const resolved: Partial<Record<InteractionMetricKind, number>> = {};
  for (const candidate of candidates) {
    const context = `${candidate.contextText || ""} ${candidate.valueText}`.trim();
    const kind = candidate.kindHint || inferMetricKind(context);
    if (!kind || resolved[kind] !== undefined) continue;
    const count =
      parseInteractionCount(candidate.valueText) ??
      parseInteractionCount(candidate.contextText);
    if (count !== null) resolved[kind] = count;
  }

  const likeCount = resolved.LIKE ?? null;
  const favoriteCount = resolved.FAVORITE ?? null;
  const commentCount = resolved.COMMENT ?? null;
  const readable = [likeCount, favoriteCount, commentCount].every(
    (count) => count !== null,
  );
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
    technicalMessage: readable
      ? null
      : `无法完整读取${missing.join("、")}`,
    candidates: [...candidates].slice(0, 50),
  };
}

export async function collectXhsInteractionMetrics(
  page: Page,
): Promise<InteractionMetrics> {
  const candidates = await page.evaluate(() => {
    type BrowserCandidate = InteractionMetricCandidate;
    const output: BrowserCandidate[] = [];
    const seen = new Set<Element>();
    const definitions: Array<{
      kind: InteractionMetricKind;
      selectors: string[];
    }> = [
      {
        kind: "LIKE",
        selectors: [
          "[data-testid*='like' i]",
          "[aria-label*='点赞']",
          "[title*='点赞']",
          "[class*='like-wrapper' i]",
          "[class*='like-button' i]",
          "[class*='like-action' i]",
        ],
      },
      {
        kind: "FAVORITE",
        selectors: [
          "[data-testid*='collect' i]",
          "[data-testid*='favorite' i]",
          "[aria-label*='收藏']",
          "[title*='收藏']",
          "[class*='collect-wrapper' i]",
          "[class*='collect-button' i]",
          "[class*='favorite-button' i]",
        ],
      },
      {
        kind: "COMMENT",
        selectors: [
          "[data-testid*='comment' i]",
          "[aria-label*='评论']",
          "[title*='评论']",
          "[class*='comment-wrapper' i]",
          "[class*='comment-button' i]",
          "[class*='comment-action' i]",
          "[class*='chat-wrapper' i]",
        ],
      },
    ];

    const add = (element: Element, kindHint?: InteractionMetricKind) => {
      if (seen.has(element) || output.length >= 100) return;
      seen.add(element);
      const html = element as HTMLElement;
      const valueText = (element.textContent || "").trim().slice(0, 120);
      const contextText = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("data-testid"),
        typeof html.className === "string" ? html.className : "",
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 240);
      output.push({
        kindHint: kindHint || null,
        valueText,
        contextText,
        source: "DOM_INTERACTION_CONTROL",
      });
    };

    for (const definition of definitions) {
      for (const selector of definition.selectors) {
        for (const element of document.querySelectorAll(selector)) {
          add(element, definition.kind);
        }
      }
    }
    for (const element of document.querySelectorAll(
      "button, [role='button'], [aria-label], [title]",
    )) {
      add(element);
    }

    const commentSummary = (document.body?.innerText || "").match(
      /共\s*\d+(?:\.\d+)?\s*(?:万|[wW])?\s*条评论/u,
    )?.[0];
    if (commentSummary) {
      output.unshift({
        kindHint: "COMMENT",
        valueText: commentSummary,
        contextText: "评论总数",
        source: "DOM_COMMENT_SUMMARY",
      });
    }
    return output;
  });
  return resolveInteractionMetrics(candidates);
}
