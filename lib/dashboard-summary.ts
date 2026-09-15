import type { ResultStatusNormalizations } from "@/lib/result-summary";

export interface DashboardStatusGroup {
  autoStatus: string;
  topicsCompliant: boolean;
  clickableCompliant: boolean;
  _count: { _all: number };
}

export function summarizeDashboardStatusGroups(
  groups: DashboardStatusGroup[],
  normalizations: ResultStatusNormalizations = {},
) {
  const counts = {
    total: 0,
    passed: 0,
    failed: 0,
    needsReview: 0,
    readFailed: 0,
    topicMissing: 0,
    clickableAbnormal: 0,
  };
  let persistedPending = 0;
  for (const group of groups) {
    const count = group._count._all;
    counts.total += count;
    if (group.autoStatus === "PASSED") counts.passed += count;
    if (group.autoStatus === "FAILED") counts.failed += count;
    if (group.autoStatus === "NEEDS_REVIEW") counts.needsReview += count;
    if (group.autoStatus === "READ_FAILED") counts.readFailed += count;
    if (group.autoStatus === "PENDING_RETENTION") persistedPending += count;
    if (!group.topicsCompliant) counts.topicMissing += count;
    if (!group.clickableCompliant) counts.clickableAbnormal += count;
  }
  for (const [source, count] of Object.entries(normalizations.passed || {})) {
    if (source === "PASSED") continue;
    if (source === "FAILED") counts.failed = Math.max(0, counts.failed - (count || 0));
    if (source === "NEEDS_REVIEW") counts.needsReview = Math.max(0, counts.needsReview - (count || 0));
    counts.passed += count || 0;
  }
  for (const [source, count] of Object.entries(normalizations.failed || {})) {
    if (source === "FAILED") continue;
    if (source === "PASSED") counts.passed = Math.max(0, counts.passed - (count || 0));
    if (source === "NEEDS_REVIEW") counts.needsReview = Math.max(0, counts.needsReview - (count || 0));
    counts.failed += count || 0;
  }
  for (const [source, count] of Object.entries(normalizations.review || {})) {
    if (source === "NEEDS_REVIEW") continue;
    if (source === "PASSED") counts.passed = Math.max(0, counts.passed - (count || 0));
    if (source === "FAILED") counts.failed = Math.max(0, counts.failed - (count || 0));
    counts.needsReview += count || 0;
  }
  const normalizedPending = (normalizations.passed?.PENDING_RETENTION || 0) +
    (normalizations.failed?.PENDING_RETENTION || 0) +
    (normalizations.review?.PENDING_RETENTION || 0);
  counts.needsReview += Math.max(0, persistedPending - normalizedPending);
  return counts;
}
