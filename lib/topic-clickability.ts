import { classifyNoteUrl } from "@/lib/note-links";

export type TopicClickability = "CLICKABLE" | "NOT_CLICKABLE" | "UNKNOWN";

export interface TopicClickabilityEvidence {
  displayText?: string;
  isClickable?: boolean;
  isLinkElement?: boolean;
  hasHref?: boolean;
  href?: string | null;
  url?: string | null;
  link?: string | null;
  styleFeature?: boolean;
  domPath?: string | null;
  source?: string | null;
}

export interface TopicClickabilityContext {
  pageUrl?: string | null;
  isXiaohongshuPage?: boolean;
}

const XHS_TOPIC_LINK_PATTERN =
  /(?:search(?:_result)?|tag|topic|explore|hashtag|keyword|note)/iu;

export function hasTopicLinkSemantics(
  value: string | null | undefined,
) {
  return Boolean(value && XHS_TOPIC_LINK_PATTERN.test(value));
}

export function isStandardXiaohongshuTopic(
  value: string | null | undefined,
) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200d\u2060\ufeff]/gu, "")
    .trim();
  return /^#\s*[\p{L}\p{N}_+\-·]{1,60}$/u.test(normalized);
}

export function isVerifiedXiaohongshuPlatformTopic(
  evidence: TopicClickabilityEvidence,
) {
  if (evidence.source?.startsWith("STRUCTURED_PLATFORM_TOPIC")) return true;
  if (evidence.isClickable === true) return true;
  if (
    hasTopicLinkSemantics(evidence.href) ||
    hasTopicLinkSemantics(evidence.url) ||
    hasTopicLinkSemantics(evidence.link)
  ) {
    return true;
  }
  return (
    evidence.source === "DOM_LINK" &&
    evidence.isLinkElement === true
  );
}

function isXiaohongshuPage(context: TopicClickabilityContext) {
  if (context.isXiaohongshuPage !== undefined) {
    return context.isXiaohongshuPage;
  }
  return context.pageUrl
    ? classifyNoteUrl(context.pageUrl).platform === "XIAOHONGSHU"
    : false;
}

export function classifyTopicClickability(
  evidence: TopicClickabilityEvidence,
  context: TopicClickabilityContext = {},
): TopicClickability {
  if (
    evidence.isClickable === true ||
    evidence.isLinkElement === true ||
    evidence.hasHref === true ||
    hasTopicLinkSemantics(evidence.href) ||
    hasTopicLinkSemantics(evidence.url) ||
    hasTopicLinkSemantics(evidence.link)
  ) {
    return "CLICKABLE";
  }

  const explicitPlainDomText =
    Boolean(evidence.domPath) &&
    evidence.isLinkElement === false &&
    evidence.hasHref === false &&
    !evidence.href &&
    evidence.styleFeature === false;
  if (explicitPlainDomText) return "NOT_CLICKABLE";

  // A standard-looking #topic string on XHS is only text. It must not become
  // clickable without structured platform evidence or real link semantics.
  if (isXiaohongshuPage(context)) return "UNKNOWN";
  return "UNKNOWN";
}

export function classifyTopicCandidates(
  candidates: TopicClickabilityEvidence[],
  context: TopicClickabilityContext = {},
): TopicClickability {
  const states = candidates.map((candidate) =>
    classifyTopicClickability(candidate, context),
  );
  if (states.includes("CLICKABLE")) return "CLICKABLE";
  if (states.includes("UNKNOWN")) return "UNKNOWN";
  return states.length ? "NOT_CLICKABLE" : "UNKNOWN";
}
