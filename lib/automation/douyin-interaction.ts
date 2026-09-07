import { resolveInteractionMetrics, type InteractionMetricCandidate } from "@/lib/interaction-metrics";

export function extractDouyinPublicStatus(item: Record<string, unknown> | null, contentId: string | null): boolean | null {
  if (!contentId || String(item?.aweme_id ?? item?.awemeId ?? item?.item_id ?? "") !== contentId) return null;
  const status = item?.status as Record<string, unknown> | undefined;
  if (status?.private_status === 1 || status?.is_private === true) return false;
  if (status?.private_status === 0 || status?.is_private === false) return true;
  return null;
}

export function extractDouyinInteraction(item: Record<string, unknown> | null, contentId: string | null) {
  const identity = item?.aweme_id ?? item?.awemeId ?? item?.item_id;
  const matched = Boolean(contentId && String(identity ?? "") === contentId);
  const raw = matched ? item?.statistics : null;
  const statistics = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const candidates: InteractionMetricCandidate[] = [];
  for (const [kindHint, key] of [["LIKE", "digg_count"], ["COMMENT", "comment_count"], ["FAVORITE", "collect_count"]] as const) {
    const rawValue = statistics[key];
    const value = typeof rawValue === "number" ? rawValue
      : typeof rawValue === "string" && /^\d+$/u.test(rawValue) ? Number(rawValue) : null;
    if (value !== null && Number.isSafeInteger(value) && value >= 0) {
      candidates.push({ kindHint, valueText: String(value), source: "DOUYIN_CURRENT_CONTENT_STATISTICS", evidenceStatus: value === 0 ? "CONFIRMED_ZERO" : "VALUE" });
    }
  }
  return resolveInteractionMetrics(candidates);
}
