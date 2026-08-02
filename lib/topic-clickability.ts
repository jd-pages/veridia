export type TopicClickability = "CLICKABLE" | "NOT_CLICKABLE" | "UNKNOWN";

export interface TopicClickabilityEvidence {
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

const XHS_TOPIC_LINK_PATTERN =
  /(?:search(?:_result)?|tag|topic|explore|hashtag|keyword|note)/iu;

export function hasTopicLinkSemantics(
  value: string | null | undefined,
) {
  return Boolean(value && XHS_TOPIC_LINK_PATTERN.test(value));
}

export function classifyTopicClickability(
  evidence: TopicClickabilityEvidence,
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
  return explicitPlainDomText ? "NOT_CLICKABLE" : "UNKNOWN";
}

export function classifyTopicCandidates(
  candidates: TopicClickabilityEvidence[],
): TopicClickability {
  const states = candidates.map(classifyTopicClickability);
  if (states.includes("CLICKABLE")) return "CLICKABLE";
  if (states.includes("UNKNOWN")) return "UNKNOWN";
  return states.length ? "NOT_CLICKABLE" : "UNKNOWN";
}
