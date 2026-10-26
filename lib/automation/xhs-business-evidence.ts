import {
  resolveInteractionMetrics,
  parseInteractionCount,
  type InteractionMetrics,
  type InteractionMetricCandidate,
  type InteractionMetricKind,
} from "@/lib/interaction-metrics";
import type { PlatformPublishedAtEvidence } from "@/lib/platform-published-at";
import type { XhsPageCandidates } from "./xhs-page-evidence";

const kinds: InteractionMetricKind[] = ["LIKE", "COMMENT", "FAVORITE"];
const priority = (source: string) => source.startsWith("NETWORK_JSON") ? 0
  : source.startsWith("PAGE_JSON") ? 1 : 2;

/** Select only identity-bound current-note fields; never manufacture zero or a year. */
export function resolveXhsBusinessEvidence(input: {
  noteId: string | null;
  candidates: XhsPageCandidates;
  domMetrics: InteractionMetrics;
  normal: boolean;
  collectedAt: string;
}) {
  const { noteId, candidates, domMetrics } = input;
  const selected: InteractionMetricCandidate[] = [];
  const conflicts: InteractionMetricKind[] = [];
  for (const kind of kinds) {
    const bound = input.normal && noteId ? candidates.interactionCandidates.filter((candidate) =>
      candidate.contentId === noteId && candidate.kindHint === kind) : [];
    const best = bound.length ? Math.min(...bound.map((candidate) => priority(candidate.source))) : 2;
    const matching = bound.filter((candidate) => priority(candidate.source) === best);
    if (new Set(matching.map((candidate) => Number(candidate.valueText))).size > 1) conflicts.push(kind);
    if (matching.length) selected.push(...matching);
    else if (input.normal && noteId) {
      selected.push(...domMetrics.candidates.filter((candidate) => candidate.kindHint === kind));
      if (domMetrics.metricStatus[kind] === "CONFLICT") conflicts.push(kind);
    }
  }
  const metrics = resolveInteractionMetrics(selected);
  if (conflicts.length) {
    metrics.status = "UNAVAILABLE";
    metrics.totalCount = null;
    metrics.conflictCode = "INTERACTION_COUNT_CONFLICT";
    metrics.technicalMessage = "INTERACTION_COUNT_CONFLICT：当前笔记同级结构化互动数据不一致";
    for (const kind of conflicts) metrics.metricStatus[kind] = "CONFLICT";
  }

  const boundTimes = input.normal && noteId ? candidates.publishedAtCandidates.filter((candidate) =>
    candidate.contentId === noteId) : [];
  const absolute = boundTimes.filter((candidate) => candidate.timeKind !== "EDITED" && candidate.value &&
    !Number.isNaN(Date.parse(candidate.value)) && Date.parse(candidate.value) <= Date.parse(input.collectedAt));
  const bestPriority = absolute.length ? Math.min(...absolute.map((candidate) => priority(candidate.source))) : null;
  const bestTimes = absolute.filter((candidate) => priority(candidate.source) === bestPriority);
  // Date-only DOM displays can corroborate a timestamp, but cannot override it.
  const structuredTimes = absolute.filter((candidate) => priority(candidate.source) < 2);
  const day = (value: string) => new Date(Date.parse(value) + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  const timeConflict = new Set(bestTimes.map((candidate) => candidate.value)).size > 1 ||
    new Set(structuredTimes.map((candidate) => candidate.value)).size > 1 ||
    new Set(absolute.map((candidate) => day(candidate.value!))).size > 1;
  const publication: PlatformPublishedAtEvidence | null = timeConflict ? null : bestTimes[0] ||
    boundTimes.find((candidate) => candidate.source.startsWith("DOM_MAIN_NOTE") && !candidate.value) || null;
  const blockers = [
    !noteId ? "CURRENT_NOTE_ID_UNCONFIRMED" : null,
    metrics.status !== "SUCCESS" ? metrics.conflictCode || "PLATFORM_INTERACTION_NOT_RETURNED" : null,
    timeConflict ? "PUBLISHED_TIME_CONFLICT" : !publication?.value ? "ORIGINAL_PUBLISHED_TIME_NOT_RETURNED" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    metrics, publication,
    receipt: {
      version: 1, noteId, collectedAt: input.collectedAt,
      interaction: { status: metrics.status, sources: selected.map((candidate) => ({
        kind: candidate.kindHint, source: candidate.source, value: candidate.valueText, contentId: noteId,
        evidenceStatus: candidate.evidenceStatus,
        resolvedValue: candidate.evidenceStatus === "CONFIRMED_ZERO" ? 0 : parseInteractionCount(candidate.valueText),
        controlClass: candidate.controlClass, iconHref: candidate.iconHref,
        countNodePresent: candidate.countNodePresent,
      })), domSources: domMetrics.candidates.slice(0, 20).map(candidate => ({
        kind: candidate.kindHint, source: candidate.source, value: candidate.valueText,
        contentId: noteId, evidenceStatus: candidate.evidenceStatus,
        controlClass: candidate.controlClass, iconHref: candidate.iconHref,
        countNodePresent: candidate.countNodePresent, countNodeText: candidate.countNodeText,
      })) },
      publication: { status: timeConflict ? "CONFLICT" : publication?.value ? "CONFIRMED" : "UNCONFIRMED",
        selected: publication, candidates: boundTimes.slice(0, 20) },
      blockers,
      recovery: blockers.length ? "系统已尝试当前笔记结构化响应、内嵌数据和可见DOM；确认页面仍可访问，登录失效时请通过正常登录流程恢复" : null,
    },
  };
}
